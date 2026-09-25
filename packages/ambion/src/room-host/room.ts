/**
 * The room: the one place where a journal, the seats around it, the people
 * visiting it and the exchanges they open become behaviour.
 *
 * The room is one operation and one step. `commit` appends one entry to the
 * journal under a serial queue, then emits and sends. `reconcile` folds the journal,
 * decides, writes what it decided, and sends; it runs after every commit,
 * every lease change, every alarm and every wake, and running it twice
 * writes nothing. Every fact about the room is a fold over the journal
 * (`room/fold.ts`), so a room that resumes over the journal continues where the
 * last run stopped.
 *
 * `RoomHost` holds the state and the phases of the room. Its mechanisms live
 * in the files beside it, as functions over a view of the room:
 *
 * - `people.ts` — visits, deliveries from a visit, and the roster.
 * - `dispatch.ts` — the reaction to each entry, and the ports that send.
 * - `waits.ts` — exchange handles and the callers that wait on them.
 * - `control.ts` — the reconcile loop, cancellation, shutdown, and seat writes.
 *
 * What is left here is what only the room can do: compose, recover, take a
 * phase, and answer a seat with the three calls in `protocol.ts`.
 */

import type { Answering } from '../answers.ts';
import { answerCommit, answerLease, answerView } from '../answers.ts';
import { AmbionError } from '../errors.ts';
import type { ExecutionConnector, RoomRuntime, RunningRoom } from '../host/runtime.ts';
import type { Composition } from '../journal/events.ts';
import { type Entry, type RoomJournal, roomJournal } from '../journal/journal.ts';
import type {
	AgentPort,
	CommitRequest,
	CommitResult,
	LeaseRequest,
	LeaseResponse,
	RoomProtocol,
	ViewRange,
	ViewResponse,
} from '../protocol.ts';
import type { RoomState } from '../room/fold.ts';
import type { VisitRuntime } from '../room/presence.ts';
import {
	advance,
	emptyProjection,
	projectState,
	type RoomProjection,
	replay,
} from '../room/projection.ts';
import {
	captureMessageSelection,
	type MessageSelection,
	pendingFor,
	readView,
} from '../room/read.ts';
import { liveWork } from '../room/reconcile.ts';
import { decide, type Refusal } from '../room/transition.ts';
import type { PendingSay } from '../scheduling.ts';
import type {
	AgentDefinition,
	ClosedExchange,
	ClosedExchangeView,
	EndReason,
	FailureCause,
	HarnessSession,
	HumanDefinition,
	Message,
	RoomNotification,
	RoomRead,
	SeatOptions,
	Seq,
	Usage,
	Without,
} from '../types.ts';
import * as control from './control.ts';
import {
	acceptedEvent,
	compositionOf,
	notificationFor,
	requireSubmission,
	submit,
} from './core.ts';
import * as dispatch from './dispatch.ts';
import * as people from './people.ts';
import * as waits from './waits.ts';

export type { RoomRead } from '../types.ts';
export type { Visit } from './people.ts';
export type { ExchangeHandle } from './waits.ts';

/**
 * Where the room is in its life. One field answers every question the room
 * asks about itself, so no guard reads two.
 *
 * - `starting` — the record is not replayed yet, and every operation waits.
 * - `running` — the composition is on the journal, and the room answers.
 * - `stopped` — the host closed the run. What was queued still lands, and
 *   the name comes free.
 * - `evicted` — the room is dropped from memory. Nothing lands, nothing is
 *   answered, and nothing reaches a listener.
 *
 * Eviction is terminal: a room that lost its name takes no phase after it.
 */
type Phase = 'starting' | 'running' | 'stopped' | 'evicted';

/** What a run starts with, as definitions. The journal holds the same composition, by name. */
export interface CompositionDraft {
	goal: string | undefined;
	summary: string | undefined;
	definitions: AgentDefinition[];
	seats: ReadonlyMap<string, SeatOptions>;
}

export interface Room {
	readonly name: string;
	/** Observe one detached room read without waiting for agent work. */
	read(options?: { messages?: MessageSelection }): Promise<RoomRead>;
	/** The closed exchanges that wait on one person. A detached read: it waits for no work. */
	pendingFor(person: string): Promise<ClosedExchangeView[]>;
	subscribe(listener: (event: RoomNotification) => void): () => void;
	/** Reacquire an exchange by the source sequence of its opening question. */
	exchange(from: Seq): waits.ExchangeHandle | undefined;
	visit(human: HumanDefinition): Promise<people.Visit>;
	stop(): Promise<void>;
	/** Cancel work at one durable journal boundary. The room keeps running. */
	abort(): Promise<void>;
	/**
	 * Put a registered agent on the roster while the room runs. The seating lands on the record, and it wakes the seat it names.
	 */
	seat(name: string, options?: SeatOptions): Promise<void>;
	/**
	 * Take an agent off the roster. Its lease in flight is revoked, the
	 * record says it left, and its definition remains in the reserve.
	 */
	unseat(name: string): Promise<void>;
	/**
	 * Dismiss one scheduled say that waits to return, by its handle: the seq
	 * of the say. True when the room dismissed it now. False when it no longer
	 * waits: it returned, or somebody dismissed it, or the room dropped it.
	 */
	dismiss(handle: Seq): Promise<boolean>;
	/** The scheduled says that wait to return. A detached read: it waits for no work. */
	scheduled(): Promise<PendingSay[]>;
	/** Fold, decide, write, send. The room runs it on its own; a host on a platform with its own alarms calls it. */
	reconcile(): Promise<void>;
}

// -- the room ----------------------------------------------------------------

/**
 * The state is public inside the package so the mechanism files can reach it
 * through their views. The public surface of a room is the `Room` interface.
 */
export class RoomHost implements Room, RunningRoom {
	readonly name: string;
	readonly runtime: RoomRuntime;
	/** The configured execution owner for this room's seats. */
	readonly connector: ExecutionConnector;
	readonly journal: RoomJournal;
	/** The replay, the composition on the journal, and the first reconcile. Every operation waits here. */
	readonly ready: Promise<void>;
	/** Every definition this room can seat, by name. */
	readonly defs: ReadonlyMap<string, AgentDefinition>;
	/** The handles the host delivers through. Presence itself is a fold over the journal. */
	readonly visits = new Map<string, VisitRuntime>();
	/** Arrivals awaiting durable acknowledgement, keyed by human name. */
	readonly arrivals = new Map<string, { identity: string; promise: Promise<VisitRuntime> }>();
	readonly ports = new Map<string, AgentPort>();
	/** The three room calls exposed to an in-process seat. */
	readonly calls: RoomProtocol = {
		view: (id, range) => this.view(id, range),
		commit: (commit) => this.commit(commit),
		lease: (lease) => this.lease(lease),
	};
	private readonly listeners = new Set<(event: RoomNotification) => void>();
	readonly closeWaiters = new Map<
		Seq,
		Array<{
			resolve: (close: ClosedExchange) => void;
			reject: (error: Error) => void;
		}>
	>();
	readonly responseWaiters = new Set<() => void>();
	/** When this room last sent each wake. A cache: a resumed room sends every pending wake again. */
	readonly sentAt = new Map<string, number>();
	/** Delivery state is bounded by currently due/live activations and fences late replies by token. */
	readonly deliveryStates = new Map<string, dispatch.DeliveryState>();
	/** Every lease id this room has heard a change for. It says `activation_start` once. */
	readonly heardLeases = new Set<string>();
	cancelAlarm: () => void = () => {};
	/** The reconcile in flight: the entries it writes, and whoever it wakes. A caller that asks waits for it. */
	reconciling: Promise<void> = Promise.resolve();
	/** Publications run in journal order after the confirmed entry has been folded. */
	publications: Promise<void> = Promise.resolve();
	/** A stop is one shared operation; a failed one may be retried after its promise clears. */
	private stopInFlight: Promise<void> | undefined;
	/** A cancellation append in flight, with its key retained across uncertainty. */
	abortInFlight: Promise<void> | undefined;
	abortKey: string | undefined;
	private fold: { length: number; projection: RoomProjection; state: RoomState } | undefined;
	private phase: Phase = 'starting';
	/** This run's id: the fence it writes first, and the stamp on every entry it writes. */
	private readonly run = crypto.randomUUID();

	static start(
		name: string,
		runtime: RoomRuntime,
		cast: CompositionDraft,
		connector: ExecutionConnector,
	): RoomHost {
		return new RoomHost(name, runtime, cast, connector);
	}

	static resume(
		name: string,
		runtime: RoomRuntime,
		bindings: Map<string, AgentDefinition>,
		connector: ExecutionConnector,
	): RoomHost {
		return new RoomHost(name, runtime, undefined, connector, bindings);
	}

	private constructor(
		name: string,
		runtime: RoomRuntime,
		cast: CompositionDraft | undefined,
		connector: ExecutionConnector,
		bindings: Map<string, AgentDefinition> = new Map(),
	) {
		this.name = name;
		this.runtime = runtime;
		this.connector = connector;
		this.journal = roomJournal(
			runtime.journals.open(name),
			(entry) => this.hear(entry),
			this.run,
			() => this.superseded(),
		);
		this.defs = cast ? new Map(cast.definitions.map((agent) => [agent.name, agent])) : bindings;
		const starting = cast && compositionOf(cast, this.iso());
		this.ready = starting ? this.compose(starting) : this.recover();
		void this.ready.catch(() => {});
	}

	/** Resolves once the room is up. `resumeRoom` waits for it; every operation does. */
	started(): Promise<void> {
		return this.ready;
	}

	/**
	 * The composition against the record, then on it. A name the record knows
	 * as a person cannot be seated, and the first call that needs the room sees
	 * the refusal. The composition is what the roster folds from. The first
	 * reconcile closes an exchange the last run left open once nothing works on it.
	 */
	private async compose(composition: Without<Composition, 'seq'>): Promise<void> {
		await this.journal.ready;
		this.enter('running');
		dispatch.seedHeardLeases(this);
		acceptedEvent(decide(this.state(), { type: 'compose', composition }, this.now()));
		requireSubmission(
			await submit(this.journal, 'run', () => decide(this.state(), { type: 'run' }, this.now())),
		);
		requireSubmission(
			await submit(this.journal, 'composition', () =>
				decide(this.state(), { type: 'compose', composition }, this.now()),
			),
		);
		await this.reconcile();
	}

	/** The composition off the journal, and every name on it through the supplied bindings. */
	private async recover(): Promise<void> {
		await this.journal.ready;
		this.enter('running');
		dispatch.seedHeardLeases(this);
		const state = this.state();
		this.validateDefinitions(state);
		// The fence lands here: from here on, every earlier run's later writes are void.
		requireSubmission(
			await submit(this.journal, 'run', () => {
				this.validateDefinitions(this.state());
				return decide(this.state(), { type: 'run' }, this.now());
			}),
		);
		requireSubmission(
			await submit(this.journal, 'composition', () => {
				const current = this.state();
				this.validateDefinitions(current);
				const priorComposition = current.composition;
				if (priorComposition === undefined) return { event: undefined };
				const roster = new Set(current.roster.map((seat) => seat.name));
				const definitions = new Map(
					[...priorComposition.agents, ...priorComposition.available, ...current.roster].map(
						(seat) => [seat.name, seat],
					),
				);
				for (const agent of this.defs.values())
					if (!definitions.has(agent.name))
						definitions.set(agent.name, {
							name: agent.name,
							identity: agent.identity,
							attention: 'broadcast',
						});
				const available = [...definitions.values()].filter((seat) => !roster.has(seat.name));
				const { seq: _seq, at: _at, ...prior } = priorComposition;
				const body = { ...prior, agents: current.roster, available, at: this.iso() };
				return decide(current, { type: 'compose', composition: body }, this.now());
			}),
		);
		await this.reconcile();
	}

	private validateDefinitions(state: RoomState): void {
		if (state.composition === undefined)
			throw new AmbionError(
				'no_composition',
				`Room '${this.name}' has no composition on its record: start it instead.`,
			);
		const names = new Set([
			...state.composition.agents.map((seat) => seat.name),
			...state.composition.available.map((seat) => seat.name),
			...state.roster.map((seat) => seat.name),
		]);
		for (const name of names)
			if (!this.defs.has(name))
				throw new AmbionError(
					'missing_definition',
					`Room '${this.name}' cannot resume: agent '${name}' has no binding.`,
				);
		for (const name of this.defs.keys())
			if (state.people.has(name))
				throw new AmbionError(
					'duplicate_name',
					`Room '${this.name}' cannot resume: '${name}' is a person in this room.`,
				);
	}

	/**
	 * Another run took the name. This run says so once, then drops itself
	 * from memory: nothing it does from here on writes, and every seat it
	 * runs hears stale. The record is the other run's from its fence on.
	 */
	private superseded(): void {
		if (this.phase === 'evicted') return;
		this.emit({ type: 'superseded' });
		// This run alone: the runtime may hold a newer room under the name by now.
		this.release();
		this.evict();
	}

	/** Free the name in the runtime, for this run alone. */
	release(): void {
		this.runtime.release(this);
	}

	// -- what the room holds --------------------------------------------------

	/** The bounds the room applies to what an activation reads. */
	get limits(): Answering['limits'] {
		return this.runtime.limits;
	}

	now(): number {
		return this.runtime.clock.now();
	}

	/** The room's clock, as an ISO stamp for the record. */
	private iso(): string {
		return new Date(this.now()).toISOString();
	}

	/** Every fact about the room, folded over the journal as it stands. */
	state(): RoomState {
		const current = this.fold;
		const options = this.runtime.limits.activation;
		const entries = this.journal.entriesFrom(current?.length ?? 0);
		if (current !== undefined && entries.length === 0) return current.state;
		let projection = current?.projection ?? emptyProjection();
		// A cold room replays in place. A warm room advances one value per entry.
		if (current === undefined) projection = replay(entries, options);
		else for (const entry of entries) projection = advance(projection, entry, options);
		this.fold = {
			length: (current?.length ?? 0) + entries.length,
			projection,
			state: projectState(projection),
		};
		return this.fold.state;
	}

	/** Take a phase. Eviction is terminal, so nothing follows it. */
	private enter(phase: Phase): void {
		if (this.phase !== 'evicted') this.phase = phase;
	}

	/** The room answers nothing more: the host stopped it, or it was dropped. */
	gone(): boolean {
		return this.phase === 'stopped' || this.phase === 'evicted';
	}

	/** Dropped from memory: nothing lands, and nothing reaches a listener. */
	evicted(): boolean {
		return this.phase === 'evicted';
	}

	assertRunning(): void {
		if (this.gone()) throw new AmbionError('room_stopped', `Room '${this.name}' is stopped.`);
	}

	/** The seats live now, for a caller that reads no more than the names. */
	live(state: RoomState): Map<string, string[]> {
		return liveWork(state, this.now()).seats;
	}

	// -- what the host reads -----------------------------------------------------

	subscribe(listener: (event: RoomNotification) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: RoomNotification): void {
		for (const listener of this.listeners) {
			try {
				listener(notificationFor(event));
			} catch {
				// A listener's failure is the listener's problem, never the room's.
			}
		}
	}

	/** Read the detached room projection after pending journal work settles. */
	async read(options: { messages?: MessageSelection } = {}): Promise<RoomRead> {
		const messages = captureMessageSelection(options.messages);
		await this.ready;
		await this.journal.settled();
		return readView(
			this.name,
			this.state(),
			this.runtime.clock.now(),
			this.journal.lastSeq,
			messages,
		);
	}

	async pendingFor(person: string): Promise<ClosedExchangeView[]> {
		return pendingFor(await this.read({ messages: false }), person);
	}

	async scheduled(): Promise<PendingSay[]> {
		return [...(await this.read({ messages: false })).scheduled];
	}

	dismiss(handle: Seq): Promise<boolean> {
		return control.dismissSay(this, handle);
	}

	exchange(from: Seq): waits.ExchangeHandle | undefined {
		return waits.exchange(this, from);
	}

	handleForMessage(message: Message): waits.ExchangeHandle {
		return waits.handleForMessage(this, message);
	}

	notifyExchangeWaiters(): void {
		waits.notifyExchangeWaiters(this);
	}

	rejectExchangeWaiters(error: Error): void {
		waits.rejectExchangeWaiters(this, error);
	}

	// -- people -----------------------------------------------------------------

	/** Puts a person in the room. A second visit while they are here is the same visit. */
	visit(human: HumanDefinition): Promise<people.Visit> {
		return people.visit(this, human);
	}

	/** The host seats a registered agent. Executable definitions stay fixed for the run. */
	seat(name: string, options: SeatOptions = {}): Promise<void> {
		return people.seatAgent(this, name, options);
	}

	/** The host takes an agent off the roster. */
	unseat(name: string): Promise<void> {
		return people.unseatAgent(this, name);
	}

	leaveEverybody(): Promise<void> {
		return people.leaveEverybody(this);
	}

	// -- what the room hears --------------------------------------------------

	/**
	 * One entry, one reaction. The journal calls this for every entry it takes
	 * after the replay: one this run appended, and one a read found because
	 * the confirmation was lost or another run wrote it. The room reacts the
	 * same way to both, so it has one path from the record to a host and
	 * never a second one for the entries it wrote itself.
	 */
	private hear(entry: Entry): void {
		dispatch.hearEntry(this, entry);
	}

	/** One activation wake over the wire. */
	sendWake(id: string, seat: string): void {
		dispatch.sendWake(this, id, seat);
	}

	// -- what a seat asks -------------------------------------------------------

	view(id: string, range?: ViewRange): Promise<ViewResponse> {
		return answerView(this, id, range);
	}

	commit(commit: CommitRequest): Promise<CommitResult> {
		return answerCommit(this, commit);
	}

	lease(lease: LeaseRequest): Promise<LeaseResponse> {
		return answerLease(this, lease);
	}

	// -- what an answer reads of the room ---------------------------------------

	/** One operation on the room's commit queue, with the wakes the room routes. */
	write(commit: CommitRequest): Promise<CommitResult | { refusal: Refusal }> {
		return control.writeCommit(this, commit);
	}

	claim(id: string): Promise<LeaseResponse> {
		return control.hold(this, id, 'claim');
	}

	renew(id: string, readThrough?: Seq): Promise<LeaseResponse> {
		return control.hold(this, id, 'renew', readThrough);
	}

	/** End one lease, for whatever reason. Nothing to end is not an error. */
	end(
		id: string,
		reason: EndReason,
		readThrough: Seq,
		cause?: FailureCause,
		usage?: Usage,
		session?: HarnessSession,
	): Promise<boolean | { refusal: Refusal }> {
		return control.end(this, id, reason, readThrough, cause, usage, session);
	}

	// -- control ----------------------------------------------------------------

	reconcile(): Promise<void> {
		return control.reconcile(this);
	}

	abort(): Promise<void> {
		return control.abort(this);
	}

	/** Closes the run: what is live is revoked, what is present is marked gone, and the name comes free. */
	async stop(): Promise<void> {
		if (this.phase === 'evicted') return;
		if (this.stopInFlight !== undefined) return this.stopInFlight;
		// Stopped from here on: a visit that arrives during the shutdown is
		// refused rather than seated into a room that is going away.
		this.enter('stopped');
		this.cancelAlarm();
		let operation!: Promise<void>;
		operation = control.stopRun(this).catch((error) => {
			if (this.stopInFlight === operation) this.stopInFlight = undefined;
			throw error;
		});
		this.stopInFlight = operation;
		return operation;
	}

	/**
	 * Dropped from memory: the alarm is cancelled, the journal is closed, every
	 * call a seat makes from now on is stale, every visit is over, nothing
	 * the host does with the handle writes, nothing reaches a listener again,
	 * and nobody waits on the room. The record keeps what landed before, and
	 * nothing this run had queued lands after.
	 */
	evict(): void {
		this.phase = 'evicted';
		this.deliveryStates.clear();
		this.journal.close();
		this.cancelAlarm();
		this.listeners.clear();
		for (const visit of this.visits.values()) visit.gone = true;
		this.rejectExchangeWaiters(new AmbionError('room_stopped', `Room '${this.name}' was evicted.`));
	}
}
