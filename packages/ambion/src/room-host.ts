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
 * What is left here is what only a room can do:
 *
 * - **Compose.** Write the composition, admit the people, seat and unseat
 *   while it runs, and take it all down again.
 * - **Commit.** One queue, one seq at a time, for every author (rule 5).
 * - **Hear.** One reaction per entry on the journal, whether this run wrote the
 *   entry or found it on a read. The room writes down and hears back up, so
 *   a message it committed and a message another run left reach a host the
 *   same way.
 * - **Route.** Who wakes for a message, written with it, and who is steered.
 * - **Answer a seat.** The view an activation reads, the commit it asks for,
 *   and the lease it holds — the three calls in `protocol.ts`.
 * - **Say when it has stopped.** An exchange closed, and nothing live.
 */

import { answerCommit, answerLease, answerView } from './answers.ts';
import { captureHuman } from './define.ts';
import type { ExecutionConnector, RoomRuntime, RunningRoom } from './host/runtime.ts';
import type {
	Close,
	Composition,
	LeaseChange,
	TaskChange,
	TaskDelivery,
} from './journal/events.ts';
import { type Entry, type Kind, placed, type RoomJournal, roomJournal } from './journal/journal.ts';
import type {
	CommitRequest,
	CommitResult,
	LeaseRequest,
	LeaseResponse,
	SeatPort,
	Steer,
	TaskSeatRoom,
	ViewResponse,
} from './protocol.ts';
import { activationSpec } from './room/activation.ts';
import { closedExchange, discussionMessages, summaryCompletion } from './room/exchange.ts';
import { foldRoom, type RoomState } from './room/fold.ts';
import { isLive, seatOf } from './room/lease.ts';
import type { VisitRuntime } from './room/presence.ts';
import { captureMessageSelection, type MessageSelection, readView } from './room/read.ts';
import { type LiveWork, liveWork } from './room/reconcile.ts';
import {
	decide,
	evolve,
	type ReconcileDecision,
	type Refusal,
	type RoomCommand,
	type RoomDecision,
	stopWork as stopWorkDecision,
} from './room/transition.ts';
import { TaskHost } from './task-host.ts';
import type {
	AgentDefinition,
	Attention,
	ClosedExchange,
	EndReason,
	ExchangeRef,
	HumanDefinition,
	Message,
	PresenceMessage,
	RoomNotification,
	RoomSnapshot,
	Seq,
	SummaryMessage,
	TaskRecord,
	Without,
} from './types.ts';
import { copyMessage } from './types.ts';

export type { RoomSnapshot } from './types.ts';

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
type DeliveryOperation = 'wake' | 'steer' | 'cut';

interface DeliveryState {
	activation: string;
	token: number;
	pending: boolean;
	failed: boolean;
}

/** What a run starts with, as definitions. The journal holds the same composition, by name. */
export interface CompositionDraft {
	goal: string | undefined;
	summary: string | undefined;
	definitions: AgentDefinition[];
	seats: ReadonlyMap<string, Attention>;
	taskScope?: { room: string; exchange: Seq };
}

/** A presence change before the room stamps when it happened. */
type PresenceDraft = Omit<PresenceMessage, 'seq' | 'key' | 'at' | 'wakes'>;

export interface ExchangeHandle extends ExchangeRef {
	/**
	 * Resolve with the fixed non-summary conversation after the durable close.
	 * Reject if the room stops before the exchange closes.
	 */
	waitForClose(): Promise<Message[]>;
	/** Resolve with the durable summary, or `undefined` when no summary is needed; reject when required work fails. */
	waitForSummary(): Promise<SummaryMessage | undefined>;
}

export interface Room {
	readonly name: string;
	/** Observe one detached room snapshot without waiting for agent work. */
	read(options?: { messages?: MessageSelection }): Promise<RoomSnapshot>;
	subscribe(listener: (event: RoomNotification) => void): () => void;
	/** Reacquire an exchange by the source sequence of its opening question. */
	exchange(from: Seq): ExchangeHandle | undefined;
	visit(human: HumanDefinition): Promise<Visit>;
	stop(): Promise<void>;
	/** Cancel work at one durable journal boundary. The room keeps running. */
	abort(): Promise<void>;
	/**
	 * Put a registered agent on the roster while the room runs. The seating lands on the record, and it wakes the seat it names.
	 */
	seat(name: string, options?: { attention?: Attention }): Promise<void>;
	/**
	 * Take an agent off the roster. Its lease in flight is revoked, the
	 * record says it left, and its definition remains in the reserve.
	 */
	unseat(name: string): Promise<void>;
	/** Fold, decide, write, send. The room runs it on its own; a host on a platform with its own alarms calls it. */
	reconcile(): Promise<void>;
}

export interface Visit {
	readonly human: HumanDefinition;
	/** The seq of this person's last `left`, or undefined the first time. A live read. */
	readonly since: Seq | undefined;
	/**
	 * Send a message to the room. `key` is the delivery's idempotency token:
	 * a repeated token lands once, so a host that never learned whether a
	 * delivery landed delivers it again under the same token. The message the
	 * token landed carries it back, so a host reads which delivery it was.
	 * A host that names none gets a token of its own that matches nothing.
	 */
	send(input: { to?: string; text: string; key?: string }): Promise<ExchangeHandle>;
	leave(): Promise<void>;
}

/** Sets up the context where the agents work and waits for its opening replay. */
/** The name comes free, unless another room took it since. */
const _stale = (why: string) => ({ stale: why });

/** Copy mutable notification values for one listener. */
function notificationFor(event: RoomNotification): RoomNotification {
	switch (event.type) {
		case 'message':
			return { ...event, message: copyMessage(event.message) };
		case 'conflict':
			return { ...event, missed: event.missed.map(copyMessage) };
		case 'exchange_opened':
			return { ...event, exchange: { ...event.exchange } };
		case 'exchange_closed':
			return { ...event, exchange: { ...event.exchange } };
		case 'error':
		case 'audit_error':
			// Execution diagnostics retain their original Error object and cause.
			return { ...event };
		default:
			return { ...event };
	}
}

/** How many times one pass folds, decides and writes before it yields. */
const PASSES = 8;

type SubmissionResult<K extends Kind> = Exclude<RoomDecision<K>, { event: unknown }> | undefined;

const refusalMessage = (refusal: Refusal): string =>
	'reason' in refusal ? refusal.reason : 'The record moved.';

// -- the room ----------------------------------------------------------------

export class RoomHost implements Room, RunningRoom {
	readonly name: string;
	readonly runtime: RoomRuntime;
	/** The configured execution owner for this room's seats. */
	private readonly connector: ExecutionConnector;
	private readonly journal: RoomJournal;
	readonly tasks: TaskHost;
	private readonly taskRooms = new Map<string, Promise<TaskHost>>();
	/** The replay, the composition on the journal, and the first reconcile. Every operation waits here. */
	readonly ready: Promise<void>;
	/** Every definition this room can seat, by name. */
	private readonly defs: ReadonlyMap<string, AgentDefinition>;
	/** The handles the host delivers through. Presence itself is a fold over the journal. */
	private readonly visits = new Map<string, VisitRuntime>();
	/** Arrivals awaiting durable acknowledgement, keyed by human name. */
	private readonly arrivals = new Map<
		string,
		{ identity: string; promise: Promise<VisitRuntime> }
	>();
	private readonly ports = new Map<string, SeatPort>();
	/** Room and Task calls exposed to an in-process seat. */
	readonly calls: TaskSeatRoom = {
		view: (id) => this.view(id),
		commit: (commit) => this.commit(commit),
		lease: (lease) => this.lease(lease),
		task: (request) => this.tasks.create(request),
		taskUpdate: (request) => this.tasks.update(request),
		taskSay: (request) => this.tasks.say(request),
	};
	private readonly listeners = new Set<(event: RoomNotification) => void>();
	private readonly closeWaiters = new Map<
		Seq,
		Array<{
			resolve: (close: ClosedExchange) => void;
			reject: (error: Error) => void;
		}>
	>();
	private readonly responseWaiters = new Set<() => void>();
	/** When this room last sent each wake. A cache: a resumed room sends every pending wake again. */
	private readonly sentAt = new Map<string, number>();
	/** Delivery state is bounded by currently due/live activations and fences late replies by token. */
	private readonly deliveryStates = new Map<string, DeliveryState>();
	/** Every lease id this room has heard a change for. It says `activation_start` once. */
	private readonly heardLeases = new Set<string>();
	private cancelAlarm: () => void = () => {};
	/** The reconcile in flight: the entries it writes, and whoever it wakes. A caller that asks waits for it. */
	private reconciling: Promise<void> = Promise.resolve();
	/** Publications run in journal order after the confirmed entry has been folded. */
	private publications: Promise<void> = Promise.resolve();
	/** A stop is one shared operation; a failed one may be retried after its promise clears. */
	private stopInFlight: Promise<void> | undefined;
	/** A cancellation append in flight, with its key retained across uncertainty. */
	private abortInFlight: Promise<void> | undefined;
	private abortKey: string | undefined;
	private fold: { length: number; state: RoomState } | undefined;
	private phase: Phase = 'starting';
	/** This run's id: the fence it writes first, and the stamp on every entry it writes. */
	private readonly run = crypto.randomUUID();
	/** Whether the room has told the host about the rest it is in. */

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
		this.tasks = this.taskHost();
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
		this.seedHeardLeases();
		this.acceptedEvent(decide(this.state(), { type: 'compose', composition }, this.now()));
		this.requireSubmission(
			await this.submit('run', () => decide(this.state(), { type: 'run' }, this.now())),
		);
		this.requireSubmission(
			await this.submit('composition', () =>
				decide(this.state(), { type: 'compose', composition }, this.now()),
			),
		);
		await this.reconcile();
	}

	/** The composition off the journal, and every name on it through the supplied bindings. */
	private async recover(): Promise<void> {
		await this.journal.ready;
		this.enter('running');
		this.seedHeardLeases();
		const state = this.state();
		this.validateDefinitions(state);
		// The fence lands here: from here on, every earlier run's later writes are void.
		this.requireSubmission(
			await this.submit('run', () => {
				this.validateDefinitions(this.state());
				return decide(this.state(), { type: 'run' }, this.now());
			}),
		);
		this.requireSubmission(
			await this.submit('composition', () => {
				const current = this.state();
				this.validateDefinitions(current);
				const priorComposition = current.composition;
				if (priorComposition === undefined) return { event: undefined };
				const roster = new Set(current.roster.map((seat) => seat.name));
				const catalog = new Map(
					[...priorComposition.agents, ...priorComposition.available, ...current.roster].map(
						(seat) => [seat.name, seat],
					),
				);
				for (const agent of this.defs.values())
					if (!catalog.has(agent.name))
						catalog.set(agent.name, {
							name: agent.name,
							identity: agent.identity,
							attention: 'broadcast',
						});
				const available = [...catalog.values()].filter((seat) => !roster.has(seat.name));
				const { seq: _seq, at: _at, ...prior } = priorComposition;
				const body = { ...prior, agents: current.roster, available, at: this.iso() };
				return decide(current, { type: 'compose', composition: body }, this.now());
			}),
		);
		await this.tasks.restore();
		await this.reconcile();
	}

	private validateDefinitions(state: RoomState): void {
		if (state.composition === undefined)
			throw new Error(`Room '${this.name}' has no composition on its record: start it instead.`);
		const names = new Set([
			...state.composition.agents.map((seat) => seat.name),
			...state.composition.available.map((seat) => seat.name),
			...state.roster.map((seat) => seat.name),
		]);
		for (const name of names)
			if (!this.defs.has(name))
				throw new Error(`Room '${this.name}' cannot resume: agent '${name}' has no binding.`);
		for (const name of this.defs.keys())
			if (state.people.has(name))
				throw new Error(`Room '${this.name}' cannot resume: '${name}' is a person in this room.`);
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
		this.runtime.release(this);
		this.evict();
	}

	// -- what the room holds --------------------------------------------------

	now(): number {
		return this.runtime.clock.now();
	}

	/** The room's clock, as an ISO stamp for the record. */
	private iso(): string {
		return new Date(this.now()).toISOString();
	}

	/** Every fact about the room, folded over the journal as it stands. */
	state(): RoomState {
		const entries = this.journal.entries;
		const current = this.fold;
		if (current === undefined) {
			this.fold = { length: entries.length, state: foldRoom(entries, this.runtime.retry) };
			return this.fold.state;
		}
		for (const entry of entries.slice(current.length))
			current.state = evolve(current.state, entry, this.runtime.retry);
		current.length = entries.length;
		return current.state;
	}

	/** Take a phase. Eviction is terminal, so nothing follows it. */
	private enter(phase: Phase): void {
		if (this.phase !== 'evicted') this.phase = phase;
	}

	/** The room's one typed adapter from a decision to the generic journal queue. */
	private submit<K extends Kind>(kind: K, decision: () => RoomDecision<K>, key?: string) {
		return this.journal.append(kind, {
			...(key === undefined ? {} : { key }),
			decide: () => {
				const result = decision();
				if ('event' in result)
					return result.event === undefined ? { result: undefined } : { body: result.event.body };
				return { result };
			},
		});
	}

	/** Convert a refused internal decision to the existing room API error. */
	private requireSubmission<K extends Kind>(
		result: { entry: unknown } | { result: SubmissionResult<K> },
	): void {
		if ('result' in result && result.result !== undefined && 'refusal' in result.result)
			throw new Error(refusalMessage(result.result.refusal));
	}

	/** The room answers nothing more: the host stopped it, or it was dropped. */
	gone(): boolean {
		return this.phase === 'stopped' || this.phase === 'evicted';
	}

	private assertRunning(): void {
		if (this.gone()) throw new Error(`Room '${this.name}' is stopped.`);
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
	async read(options: { messages?: MessageSelection } = {}): Promise<RoomSnapshot> {
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

	exchange(from: Seq): ExchangeHandle | undefined {
		const state = this.state();
		const close = state.closes.find((candidate) => candidate.from === from);
		const exchange = close ?? (state.exchange?.from === from ? state.exchange : undefined);
		if (exchange === undefined) return undefined;
		const message = state.messages.find(
			(candidate): candidate is Extract<Message, { kind: 'said' }> =>
				candidate.seq === from && candidate.kind === 'said',
		);
		return message === undefined ? undefined : this.handleFor(exchange);
	}

	private handleFor(exchange: ExchangeRef): ExchangeHandle {
		const at =
			this.state().messages.find((message) => message.seq === exchange.from)?.at ?? exchange.at;
		return {
			owner: exchange.owner,
			from: exchange.from,
			at,
			waitForClose: () => this.exchangeMessages(exchange.from),
			waitForSummary: () => this.responseFor(exchange.from),
		};
	}

	private closedFor(from: Seq): ClosedExchange | undefined {
		const state = this.state();
		const close = state.closes.find((candidate) => candidate.from === from);
		if (close === undefined) return undefined;
		return closedExchange(close, state.messages);
	}

	private async waitForClose(from: Seq): Promise<ClosedExchange> {
		await this.ready;
		const closed = this.closedFor(from);
		if (closed !== undefined) return closed;
		if (this.gone()) throw new Error(`Exchange '${from}' was stopped or interrupted.`);
		return new Promise((resolve, reject) => {
			const waiters = this.closeWaiters.get(from) ?? [];
			waiters.push({ resolve, reject });
			this.closeWaiters.set(from, waiters);
		});
	}

	private async exchangeMessages(from: Seq): Promise<Message[]> {
		const close = await this.waitForClose(from);
		return discussionMessages(this.state().messages, close.from, close.through);
	}

	private async responseFor(from: Seq): Promise<SummaryMessage | undefined> {
		const close = await this.waitForClose(from);
		for (;;) {
			const result = this.responseResult(close);
			if (result === 'silent') return undefined;
			if (result !== 'pending' && result !== 'failed') return copyMessage(result);
			if (result === 'failed') throw new Error(`Exchange '${from}' summary work was interrupted.`);
			if (this.gone())
				throw new Error(`Exchange '${from}' summary work was stopped or interrupted.`);
			await new Promise<void>((resolve) => {
				this.responseWaiters.add(resolve);
			});
		}
	}

	private responseResult(close: ClosedExchange): SummaryMessage | 'pending' | 'silent' | 'failed' {
		const state = this.state();
		const recordedClose = state.closes.find((candidate) => candidate.from === close.from);
		if (recordedClose === undefined) return 'silent';
		const completion = summaryCompletion(
			recordedClose,
			state.messages,
			state.leases,
			state.cancelledAt,
		);
		return completion.status === 'published' ? completion.summary : completion.status;
	}

	private notifyExchangeWaiters(): void {
		for (const [from, waiters] of this.closeWaiters) {
			const closed = this.closedFor(from);
			if (closed === undefined) continue;
			this.closeWaiters.delete(from);
			for (const waiter of waiters) waiter.resolve(closed);
		}
		const responseWaiters = [...this.responseWaiters];
		this.responseWaiters.clear();
		for (const resolve of responseWaiters) resolve();
	}

	private rejectExchangeWaiters(error: Error): void {
		for (const [from, waiters] of this.closeWaiters) {
			this.closeWaiters.delete(from);
			for (const waiter of waiters) waiter.reject(error);
		}
		const responseWaiters = [...this.responseWaiters];
		this.responseWaiters.clear();
		for (const resolve of responseWaiters) resolve();
	}

	/** What the room is working on: the seats live now, and what holds them. */
	private work(state: RoomState): LiveWork {
		return liveWork(state, this.now());
	}

	/** The seats live now, for a caller that reads no more than the names. */
	live(state: RoomState): Map<string, string[]> {
		return this.work(state).seats;
	}

	// -- people -----------------------------------------------------------------

	/** Puts a person in the room. A second visit while they are here is the same visit. */
	async visit(human: HumanDefinition): Promise<Visit> {
		this.assertRunning();
		const captured = captureHuman(human);
		const pending = this.arrivals.get(captured.name);
		if (pending !== undefined) {
			if (pending.identity !== captured.identity)
				throw new Error(
					`'${captured.name}' is already entering this room under a different identity: one name is one person.`,
				);
			const admitted = await pending.promise;
			this.assertRunning();
			return this.handle(admitted);
		}
		const arrival = this.arrive(captured);
		this.arrivals.set(captured.name, { identity: captured.identity, promise: arrival });
		try {
			const admitted = await arrival;
			this.assertRunning();
			return this.handle(admitted);
		} finally {
			if (this.arrivals.get(captured.name)?.promise === arrival)
				this.arrivals.delete(captured.name);
		}
	}

	/** Complete one arrival and cache the handle only after its presence is durable. */
	private async arrive(captured: HumanDefinition): Promise<VisitRuntime> {
		await this.ready;
		this.assertRunning();
		await this.journal.settled();
		this.assertRunning();
		const known = this.visits.get(captured.name);
		if (known?.gone) return this.retryKnown(captured, known);
		this.assertVisitable(captured);
		const committed = await this.commitPresence({
			kind: 'arrived',
			from: captured.name,
			subject: captured.name,
			identity: captured.identity,
			...(captured.preferences === undefined ? {} : { preferences: captured.preferences }),
		});
		this.assertRunning();
		const current = this.visits.get(captured.name);
		if (current?.gone) return this.retryKnown(captured, current);
		if (committed === undefined && current !== undefined) return current;
		if (current !== undefined) current.gone = true;
		const visit: VisitRuntime = { human: captured, gone: false };
		this.visits.set(captured.name, visit);
		return visit;
	}

	private async retryKnown(captured: HumanDefinition, known: VisitRuntime): Promise<VisitRuntime> {
		if (known.departure !== undefined) await known.departure.catch(() => {});
		else await this.endVisit(known);
		return this.arrive(captured);
	}

	private assertVisitable(human: HumanDefinition): void {
		if (this.defs.has(human.name))
			throw new Error(`'${human.name}' is an agent in this room: one name names one participant.`);
	}

	private handle(visit: VisitRuntime): Visit {
		const room = this;
		return {
			human: visit.human,
			get since() {
				return room.state().people.get(visit.human.name)?.since;
			},
			async send(input) {
				if (visit.gone) throw new Error(`${visit.human.name}'s visit has ended.`);
				room.assertRunning();
				return room.deliverFrom(visit.human.name, input);
			},
			leave() {
				return room.endVisit(visit);
			},
		};
	}

	private async endVisit(visit: VisitRuntime): Promise<void> {
		if (visit.departure !== undefined) return visit.departure;
		// A terminal room invalidates handles it ended itself. A handle that
		// started a departure has a stable key and must still retry its write,
		// even when shutdown also failed while the storage was unavailable.
		if (
			visit.gone &&
			visit.departureKey === undefined &&
			(this.phase === 'stopped' || this.phase === 'evicted')
		)
			return;
		if (visit.departureKey === undefined) visit.departureKey = crypto.randomUUID();
		const key = visit.departureKey;
		// Close this handle's admission immediately. The durable decision below
		// still checks recorded presence before any speech or departure lands.
		visit.gone = true;
		let operation!: Promise<void>;
		operation = this.leaveVisit(visit, key).catch((error) => {
			if (visit.departure === operation) visit.departure = undefined;
			throw error;
		});
		visit.departure = operation;
		return operation;
	}

	private async leaveVisit(visit: VisitRuntime, key: string): Promise<void> {
		await this.ready;
		await this.journal.settled();
		if (this.state().people.get(visit.human.name)?.presence === 'present') {
			const current = this.visits.get(visit.human.name);
			if (current !== undefined && current !== visit) {
				return;
			}
			await this.commitPresence(
				{ kind: 'left', from: visit.human.name, subject: visit.human.name },
				true,
				key,
			);
		}
		visit.gone = true;
		if (this.visits.get(visit.human.name) === visit) this.visits.delete(visit.human.name);
	}

	private async deliverFrom(
		from: string,
		input: { to?: string; text: string; key?: string },
	): Promise<ExchangeHandle> {
		const to = input.to;
		const key = input.key ?? crypto.randomUUID();
		const committed = await this.commitMessage(key, {
			type: 'deliver',
			from,
			...(to === undefined ? {} : { to }),
			text: input.text,
		});
		return this.handleForMessage(committed);
	}

	private handleForMessage(message: Message): ExchangeHandle {
		if (message.kind !== 'said') throw new Error('A delivery did not commit a spoken message.');
		const state = this.state();
		const close = state.closes.find(
			(candidate) => message.seq >= candidate.from && message.seq <= candidate.through,
		);
		const exchange =
			close ??
			(state.exchange !== undefined && message.seq >= state.exchange.from
				? state.exchange
				: undefined);
		if (exchange === undefined) throw new Error('A delivery does not belong to an exchange.');
		return this.handleFor(exchange);
	}

	// -- the roster -------------------------------------------------------------

	/** The host seats a registered agent. Executable definitions stay fixed for the run. */
	async seat(name: string, options: { attention?: Attention } = {}): Promise<void> {
		const attention = options.attention ?? 'broadcast';
		this.assertRunning();
		await this.ready;
		const definition = this.defs.get(name);
		if (definition === undefined) throw new Error(`Unknown agent '${name}'.`);
		const change: PresenceDraft = {
			kind: 'seated',
			subject: name,
			identity: definition.identity,
			attention,
		};
		this.validatePresence(change);
		await this.commitPresence(change);
	}

	/** The host takes an agent off the roster. */
	async unseat(name: string): Promise<void> {
		this.assertRunning();
		await this.ready;
		if (!this.defs.has(name)) throw new Error(`Unknown agent '${name}'.`);
		this.validatePresence({ kind: 'unseated', subject: name });
		await this.commitPresence({ kind: 'unseated', subject: name });
		await this.reconcile();
	}

	// -- commits ----------------------------------------------------------------

	/**
	 * One operation on the room's commit queue: the draft is built where the
	 * write happens, with the wakes the room decides for it. The journal hears
	 * the message inside the same link, so what the room does with it happens
	 * before anything lands on top. A repeated token appends nothing, so the
	 * journal hears nothing, and the room reacts to nothing.
	 */
	private async commitMessage(
		key: string,
		command: Extract<RoomCommand, { type: 'deliver' | 'commit' }>,
	): Promise<Message> {
		const appended = await this.submit(
			'message',
			() => decide(this.state(), command, this.now()),
			key,
		);
		this.requireSubmission(appended);
		if (!('entry' in appended)) throw new Error('The room command did not append a message.');
		return placed(appended.entry);
	}

	/** Validate before host effects, then decide again where the message commits. */
	private validatePresence(change: PresenceDraft): void {
		this.acceptedEvent(
			decide(this.state(), { type: 'presence', change, route: false }, this.now()),
		);
	}

	/** A presence change uses its caller's stable key, or a fresh key by default. */
	private async commitPresence(
		change: PresenceDraft,
		route = true,
		key: string = crypto.randomUUID(),
	): Promise<Message | undefined> {
		const appended = await this.submit(
			'message',
			() => decide(this.state(), { type: 'presence', change, route }, this.now()),
			key,
		);
		this.requireSubmission(appended);
		return 'entry' in appended ? placed(appended.entry) : undefined;
	}

	private taskHost(): TaskHost {
		const room = this;
		return new TaskHost({
			name: this.name,
			get ready() {
				return room.ready;
			},
			now: () => this.now(),
			state: () => this.state(),
			gone: () => this.gone() || this.abortInFlight !== undefined,
			catalog: () => [...this.defs.keys()],
			progress: () => this.runtime.taskProgress,
			get: (name) => this.taskRoom(name),
			ensure: (task) => this.ensureTaskRoom(task),
			write: (key, decision) => this.writeTask(key, decision),
			deliver: (delivery) => this.deliverTask(delivery),
			view: (activation) => this.view(activation),
			changed: () => this.taskChanged(),
			stop: () => this.stopWork(),
			cancel: (key) => this.recordCancellation(key),
		});
	}

	private taskRoom(name: string): TaskHost | undefined {
		if (name === this.name) return this.tasks;
		const room = this.runtime.get(name);
		return room instanceof RoomHost ? room.tasks : undefined;
	}

	private async writeTask(key: string, decision: () => TaskChange): Promise<TaskChange> {
		const written = await this.submit(
			'task',
			() => ({ event: { kind: 'task', body: decision() } }),
			key,
		);
		this.requireSubmission(written);
		if (!('entry' in written)) throw new Error('The Task operation did not commit.');
		return structuredClone(written.entry.body);
	}

	private async deliverTask(delivery: TaskDelivery): Promise<number> {
		await this.journal.ready;
		if (delivery.to !== undefined && !this.state().roster.some((seat) => seat.name === delivery.to))
			return 0;
		const message = await this.commitMessage(delivery.id, {
			type: 'deliver',
			from: delivery.from,
			text: delivery.text,
			...(delivery.to === undefined ? {} : { to: delivery.to }),
			taskId: delivery.task.id,
			taskSnapshot: delivery.task,
			taskCrossRoom: delivery.sourceRoom !== this.name,
			taskNotice: !delivery.wake,
			internal: true,
		});
		return message.seq;
	}

	private ensureTaskRoom(task: TaskRecord): Promise<TaskHost> {
		const existing = this.taskRoom(task.workingRoom);
		if (existing !== undefined) return Promise.resolve(existing);
		const pending = this.taskRooms.get(task.workingRoom);
		if (pending !== undefined) return pending;
		const opening = this.openTaskRoom(task).finally(() => this.taskRooms.delete(task.workingRoom));
		this.taskRooms.set(task.workingRoom, opening);
		return opening;
	}

	private async openTaskRoom(task: TaskRecord): Promise<TaskHost> {
		const definitions = task.agents.map((name) => {
			const definition = this.defs.get(name);
			if (definition === undefined) throw new Error(`Unknown Task agent '${name}'.`);
			return definition;
		});
		const stored = await (await this.runtime.journals.open(task.workingRoom)).read(0);
		const initialized = stored.entries.some(
			({ entry }) =>
				typeof entry === 'object' &&
				entry !== null &&
				'kind' in entry &&
				entry.kind === 'composition',
		);
		if (this.phase === 'evicted') throw new Error('The Task origin is evicted.');
		const child = initialized
			? RoomHost.resume(
					task.workingRoom,
					this.runtime,
					new Map(definitions.map((def) => [def.name, def])),
					this.connector,
				)
			: RoomHost.start(
					task.workingRoom,
					this.runtime,
					{
						goal: undefined,
						summary: undefined,
						definitions,
						seats: new Map(task.agents.map((name) => [name, 'broadcast' as const])),
						taskScope: { room: task.originRoom, exchange: task.exchange },
					},
					this.connector,
				);
		this.runtime.register(child);
		await child.ready;
		if (this.isEvicted()) {
			this.runtime.release(child);
			child.evict();
			throw new Error('The Task origin is evicted.');
		}
		return child.tasks;
	}

	private isEvicted(): boolean {
		return this.phase === 'evicted';
	}

	taskActive(exchange: number): boolean {
		return this.tasks.active(exchange);
	}
	roomActive(): boolean {
		return this.tasks.busy();
	}

	private taskChanged(): void {
		void this.reconcile();
		const origin = this.state().composition?.taskScope?.room;
		const parent = origin === undefined ? undefined : this.runtime.get(origin);
		if (parent instanceof RoomHost) void parent.reconcile();
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
		if (entry.kind === 'message') this.queueMessage(entry);
		else if (entry.kind === 'close') this.queueClose(entry.body);
		else if (entry.kind === 'lease') this.queueLease(entry.body, this.opens(entry.body.id));
		else if (entry.kind === 'cancel') this.queueCancellation(entry.body.close, entry.seq);
		else if (entry.kind === 'task') this.publish(() => this.taskChanged());
		if (this.state().composition?.taskScope !== undefined) this.publish(() => this.taskChanged());
		// Membership, cancellation, and lease entries can make an earlier
		// delivery obsolete without dispatching another message immediately.
		this.pruneDeliveryErrors();
	}

	/** Queue one captured publication without making journal confirmation await listeners or transport. */
	private publish(effect: () => void): void {
		this.publications = this.publications.then(() => {
			if (this.phase === 'evicted') return;
			try {
				effect();
			} catch {
				// External publication is best effort after the durable fact is confirmed.
			}
		});
	}

	/**
	 * Whether this change starts an activation: the room has heard no earlier
	 * change for the id. The room keeps the set, because the question is the room's:
	 * it says `activation_start` once. The replay seeds it from the fold, so a
	 * resumed room starts no activation the last run already started.
	 */
	private opens(id: string): boolean {
		const first = !this.heardLeases.has(id);
		this.heardLeases.add(id);
		return first;
	}

	/** Every lease id the room has heard a change for, seeded by the replay. */
	private seedHeardLeases(): void {
		for (const id of this.state().leases.keys()) this.heardLeases.add(id);
	}

	/**
	 * A message on the record: the host hears about it, then what it opened,
	 * steers every active ordinary seat, and asks reconciliation to dispatch
	 * the pending activations the projection derives. One message, one event,
	 * one order.
	 */
	private queueMessage(entry: Extract<Entry, { kind: 'message' }>): void {
		const message = copyMessage(placed(entry));
		const state = this.state();
		const exchange = state.exchange?.from === message.seq ? { ...state.exchange } : undefined;
		const delivery = state.deliveries.get(message.seq);
		const after =
			state.messages.filter((candidate) => candidate.seq < message.seq).at(-1)?.seq ?? 0;
		const steers: Steer[] = [];
		for (const target of delivery?.steers ?? []) {
			const lease = state.leases.get(target.activation);
			if (lease === undefined || !isLive(lease, this.now())) continue;
			steers.push({
				room: this.name,
				seat: target.seat,
				activation: target.activation,
				after,
				message: copyMessage(message),
			});
		}
		this.publish(() => {
			this.emit({ type: 'message', message });
			if (exchange !== undefined) this.emit({ type: 'exchange_opened', exchange });
			for (const steer of steers) this.steer(steer);
			this.notifyExchangeWaiters();
			void this.reconcile();
		});
	}

	/**
	 * An exchange ended at the range the close names. The host hears it
	 * before any closing summary. A question that landed
	 * ahead of the close opens the next exchange, and the room says so.
	 */
	private queueClose(close: Close): void {
		this.evictTaskRooms(close.from);
		const question = this.state().messages.find((m) => m.seq === close.from);
		const exchange: ClosedExchange = {
			owner: close.owner,
			from: close.from,
			at: question?.at ?? close.at,
			through: close.through,
		};
		const next = this.state().exchange;
		const opened = next === undefined ? undefined : { ...next };
		this.publish(() => {
			this.emit({ type: 'exchange_closed', exchange });
			if (opened !== undefined) this.emit({ type: 'exchange_opened', exchange: opened });
			this.notifyExchangeWaiters();
		});
	}

	/** A cancellation closes its current exchange and cuts every lease it superseded. */
	private queueCancellation(close: Close | undefined, seq: Seq): void {
		const state = this.state();
		const revoked = [...state.leases.values()].filter(
			(lease) => lease.phase === 'ended' && lease.reason === 'revoked' && lease.until === seq,
		);
		this.sentAt.clear();
		if (close !== undefined) this.queueClose(close);
		this.publish(() => {
			for (const lease of revoked) {
				const seat = seatOf(lease.id);
				if (seat === undefined) continue;
				this.cutPort(seat, lease.id);
				if (this.heardLeases.has(lease.id))
					this.emit({
						type: 'activation_end',
						agent: seat,
						spoke: state.messages.some((message) => message.activationId === lease.id),
					});
			}
			this.notifyExchangeWaiters();
		});
	}

	/**
	 * A lease change: the first change of an id starts an activation, and an
	 * end ends one. A change that ends a lease the journal never held is a
	 * wake written off, and starts nothing.
	 */
	private queueLease(lease: LeaseChange, first: boolean): void {
		const seat = seatOf(lease.id) ?? '';
		if (lease.phase === 'running') {
			this.publish(() => {
				if (first) this.emit({ type: 'activation_start', agent: seat });
				// A claim that lost its confirmation never armed the expiry: this pass does.
				void this.reconcile();
				this.notifyExchangeWaiters();
			});
			return;
		}
		const revoked = lease.reason === 'revoked';
		if (first) {
			// A change that ends a lease the journal never held is an attempt nobody made.
			this.publish(() => {
				if (revoked) this.cutPort(seat, lease.id);
				if (lease.reason === 'abandoned') {
					this.emit({ type: 'abandoned', agent: seat, activation: lease.id });
					void this.reconcile();
				}
				this.notifyExchangeWaiters();
			});
			return;
		}
		const spoke = this.state().messages.some((m) => m.activationId === lease.id);
		this.publish(() => {
			if (revoked) this.cutPort(seat, lease.id);
			this.emit({ type: 'activation_end', agent: seat, spoke });
			this.notifyExchangeWaiters();
			if (lease.reason === 'expired')
				this.emit({
					type: 'error',
					agent: seat,
					error: new Error('The activation ran past its lease.'),
				});
		});
	}

	/**
	 * Send projected ordinary targets when their recorded lease is live now.
	 * The delivery projection excludes authors and context-bound activations.
	 */
	private steer(steer: Steer): void {
		if (activationSpec(steer.activation, this.state()) === undefined) return;
		this.dispatch(steer.seat, 'steer', steer.activation, (port) => port.steer(steer));
	}

	/** One activation wake over the wire. */
	private send(id: string, seat: string): void {
		if (activationSpec(id, this.state()) === undefined) return;
		this.sentAt.set(id, this.now());
		this.dispatch(seat, 'wake', id, (port) => port.wake({ room: this.name, seat, activation: id }));
	}

	private cutPort(seat: string, activation: string): void {
		this.dispatch(seat, 'cut', activation, (port) => port.cut(activation));
	}

	/** Contain synchronous connector faults and asynchronous transport rejection independently. */
	private dispatch(
		seat: string,
		operation: DeliveryOperation,
		activation: string,
		send: (port: SeatPort) => Promise<void>,
	): void {
		if (this.phase === 'evicted') return;
		this.pruneDeliveryErrors();
		const key = JSON.stringify([seat, operation, activation]);
		const previous = this.deliveryStates.get(key);
		if (previous?.pending && !previous.failed) {
			previous.failed = true;
			this.emitDeliveryError(
				seat,
				operation,
				activation,
				new Error('The previous delivery result is still pending; its outcome is unknown.'),
			);
		}
		const state: DeliveryState = previous ?? {
			activation,
			token: 0,
			pending: false,
			failed: false,
		};
		const token = state.token + 1;
		state.token = token;
		state.pending = true;
		this.deliveryStates.set(key, state);
		const report = (error: unknown) => {
			const current = this.deliveryStates.get(key);
			if (
				this.gone() ||
				current?.token !== token ||
				(operation !== 'cut' && !this.deliveryActive(activation))
			)
				return;
			current.pending = false;
			if (current.failed) return;
			current.failed = true;
			this.emitDeliveryError(seat, operation, activation, error);
		};
		try {
			const result = send(this.port(seat));
			void result.then(() => {
				const current = this.deliveryStates.get(key);
				if (current?.token !== token) return;
				current.pending = false;
				current.failed = false;
			}, report);
		} catch (error) {
			report(error);
		}
	}

	private deliveryActive(activation: string): boolean {
		return (
			this.state().due.some((work) => work.id === activation) ||
			this.state().leases.get(activation)?.phase === 'running'
		);
	}

	/** Remove failures for activations that are no longer pending or live. */
	private pruneDeliveryErrors(): void {
		const active = new Set([
			...this.state().due.map((work) => work.id),
			...[...this.state().leases.values()]
				.filter((lease) => lease.phase === 'running')
				.map((lease) => lease.id),
		]);
		for (const [key, state] of this.deliveryStates)
			if (!active.has(state.activation)) this.deliveryStates.delete(key);
	}

	/** Report a failed or unknown delivery without changing the journal result. */
	private emitDeliveryError(
		seat: string,
		operation: DeliveryOperation,
		activation: string,
		error: unknown,
	): void {
		this.emit({
			type: 'delivery_error',
			agent: seat,
			activation,
			operation,
			error: error instanceof Error ? error : new Error(String(error)),
		});
	}

	private port(seat: string): SeatPort {
		let port = this.ports.get(seat);
		if (port === undefined) {
			const definition = this.defs.get(seat);
			if (definition === undefined)
				throw new Error(`Room '${this.name}' has no binding for '${seat}'.`);
			port = this.connector.connect(this.calls, {
				room: this.name,
				hostRoom: this.state().composition?.taskScope?.room ?? this.name,
				seat,
				definition,
				emit: (event) => this.emit(event),
			});
			this.ports.set(seat, port);
		}
		return port;
	}

	// -- what a seat asks -------------------------------------------------------

	view(id: string): Promise<ViewResponse> {
		return answerView(this, id);
	}

	commit(commit: CommitRequest): Promise<CommitResult> {
		return answerCommit(this, commit);
	}

	lease(lease: LeaseRequest): Promise<LeaseResponse> {
		return answerLease(this, lease);
	}

	// -- what an answer reads of the room ---------------------------------------

	/** One operation on the room's commit queue, with the wakes the room routes. */
	async write(commit: CommitRequest): Promise<CommitResult | { refusal: Refusal }> {
		const appended = await this.submit(
			'message',
			() => decide(this.state(), { type: 'commit', commit }, this.now()),
			commit.key,
		);
		if ('entry' in appended) return { committed: copyMessage(placed(appended.entry)) };
		if (appended.result === undefined) throw new Error('The commit did not propose a message.');
		return appended.result;
	}

	private acceptedEvent<K extends Kind>(decision: RoomDecision<K>) {
		if ('refusal' in decision) throw new Error(refusalMessage(decision.refusal));
		return 'event' in decision ? decision.event : undefined;
	}

	claim(id: string): Promise<LeaseResponse> {
		return this.hold(id, 'claim');
	}

	renew(id: string, readThrough?: Seq): Promise<LeaseResponse> {
		return this.hold(id, 'renew', readThrough);
	}

	private async hold(
		id: string,
		type: 'claim' | 'renew',
		readThrough?: Seq,
	): Promise<LeaseResponse> {
		const written = await this.submit('lease', () => {
			if (this.gone()) return { event: undefined };
			const wake = this.runtime.wake;
			const decision = decide(
				this.state(),
				{
					type,
					id,
					expiry: wake.expiry,
					deadline: wake.deadline,
					...(readThrough === undefined ? {} : { readThrough }),
				},
				this.now(),
			);
			if (!('event' in decision) || decision.event?.body.phase !== 'running')
				return { event: undefined };
			return decision;
		});
		this.requireSubmission(written);
		return 'entry' in written && written.entry.body.phase === 'running'
			? { ok: { expiresAt: written.entry.body.expiresAt, lastSeq: this.state().lastSeq } }
			: { stale: 'the lease ended' };
	}

	/**
	 * End one lease, for whatever reason. Nothing to end is not an error. A
	 * revocation may name an activation that never claimed: the change ends it
	 * before it starts, and the wake or the draft it stood for is answered.
	 * An abandonment names an activation that never claimed and nothing else:
	 * a lease that started ends how it went.
	 * An expiry is judged where the change is written: a renewal that landed
	 * ahead of it keeps the lease, and nothing is written. The change says
	 * how the activation went, and `heardLease` says so once.
	 */
	async end(
		id: string,
		reason: EndReason,
		readThrough: Seq,
	): Promise<boolean | { refusal: Refusal }> {
		const appended = await this.submit('lease', () =>
			decide(this.state(), { type: 'end', id, reason, readThrough }, this.now()),
		);
		if ('entry' in appended) return true;
		if (appended.result !== undefined && 'refusal' in appended.result)
			return { refusal: appended.result.refusal };
		return false;
	}

	// -- reconcile ----------------------------------------------------------------

	reconcile(): Promise<void> {
		this.reconciling = this.reconciling.then(() => this.reconcileOnce()).catch(() => {});
		return this.reconciling;
	}

	/**
	 * Fold, decide, write, send, until a decision writes nothing. Every write
	 * checks the fold again where it lands, so a lease that arrives between
	 * the decision and the write turns the write into nothing. A write the
	 * storage refuses ends the pass: whoever waits still hears the room, and
	 * the room looks again after the resend window, when the storage may be
	 * back and what it decided is still on the fold.
	 */
	private async reconcileOnce(): Promise<void> {
		await this.journal.ready;
		for (let pass = 0; pass < PASSES && !this.gone(); pass += 1) {
			if (await this.onePass()) return;
		}
		// A pass that kept writing yields, and the room looks again after the resend window.
		if (!this.gone()) this.arm(this.now() + this.runtime.wake.resend);
	}

	/**
	 * One pass: decide, apply, and arm the clock where the room stops. True
	 * where the room has nothing more to write, and the caller stops looking.
	 */
	private async onePass(): Promise<boolean> {
		try {
			if ((this.state().taskChanges?.size ?? 0) > 0) await this.tasks.drain();
		} catch {
			this.arm(this.now() + this.runtime.wake.resend);
			return true;
		}
		const current = this.state();
		const decision = decide(
			current,
			{
				type: 'reconcile',
				options: {
					resend: this.runtime.wake.resend,
					attempts: this.runtime.retry.attempts,
					sent: this.sentAt,
					stopped: this.gone(),
					externalExchange:
						current.exchange === undefined
							? false
							: this.runtime.externalExchange(this.name, current.exchange.from),
				},
			},
			this.now(),
		);
		let changed: boolean;
		try {
			changed = await this.apply(decision);
		} catch {
			this.settle();
			// A write that failed because the room is gone arms nothing.
			if (!this.gone()) this.arm(this.now() + this.runtime.wake.resend);
			return true;
		}
		if (changed) return false;
		// Whoever waits hears it once the room has nothing more to write: a
		// pass that expired a lease is followed by the pass that closes.
		this.settle();
		this.arm(decision.effects.alarmAt);
		return true;
	}

	/** Write what the decision wrote, send what it sent. True when anything changed. */
	private async apply(decision: ReconcileDecision): Promise<boolean> {
		// A wake the fold no longer says is due is not one this room waits on.
		for (const id of decision.effects.forget) this.sentAt.delete(id);
		let changed = false;
		// The decision says how each lease ends: expired first, then given up on.
		for (const event of decision.events) {
			// A room that went away mid-pass writes nothing more of what it decided.
			if (this.gone()) return changed;
			changed = (await this.applyEvent(event)) || changed;
		}
		for (const send of decision.effects.sends) this.send(send.id, send.seat);
		return changed || decision.effects.sends.length > 0;
	}

	private applyEvent(event: ReconcileDecision['events'][number]): Promise<boolean> {
		if (event.kind === 'lease' && event.body.phase === 'ended')
			return this.end(event.body.id, event.body.reason, event.body.readThrough).then((result) => {
				return this.requireEnd(result);
			});
		return event.kind === 'close' ? this.close(event.body) : Promise.resolve(false);
	}

	/**
	 * The room completed an exchange, so that exchange ends at the record
	 * as the decision saw it: the close is an entry on the journal, written where the
	 * fold still says the same exchange is open. The queued close publication says so, and
	 * opens the next exchange when a question landed after the decision; the
	 * next pass closes that one at once when nobody works on it.
	 */
	private async close(close: Close): Promise<boolean> {
		const written = await this.submit('close', () => {
			if (this.gone()) return { event: undefined };
			return decide(
				this.state(),
				{
					type: 'close',
					close,
					external: this.runtime.externalExchange(this.name, close.from),
				},
				this.now(),
			);
		});
		this.requireSubmission(written);
		if ('entry' in written) return true;
		const state = this.state();
		return (
			state.exchange?.from === close.from &&
			(state.lastSeq !== close.through || liveWork(state, this.now()).exchange)
		);
	}

	/** Wake exchange handles after reconciliation changes the durable state. */
	private settle(): void {
		this.notifyExchangeWaiters();
	}

	private arm(at: number | undefined): void {
		this.cancelAlarm();
		this.cancelAlarm =
			at === undefined ? () => {} : this.runtime.clock.alarm(at, () => this.reconcile());
	}

	// -- control ----------------------------------------------------------------

	async abort(): Promise<void> {
		this.assertRunning();
		if (this.abortInFlight !== undefined) return this.abortInFlight;
		const key = this.abortKey ?? crypto.randomUUID();
		this.abortKey = key;
		const operation = this.cancel(key);
		this.abortInFlight = operation;
		try {
			await operation;
			this.abortKey = undefined;
		} finally {
			if (this.abortInFlight === operation) this.abortInFlight = undefined;
		}
	}

	/** Append the cancellation marker after every earlier journal request. */
	private async cancel(key: string): Promise<void> {
		await this.ready;
		this.assertRunning();
		// Admission is closed while abortInFlight holds. Include earlier writes
		// before deciding whether this exchange has Tasks to settle.
		await this.journal.settled();
		if (await this.tasks.cancel(key)) return;
		await this.recordCancellation(key);
	}

	private async recordCancellation(key: string): Promise<void> {
		const appended = await this.submit(
			'cancel',
			() => {
				if (this.phase === 'evicted') return { event: undefined };
				return decide(this.state(), { type: 'cancel' }, this.now());
			},
			key,
		);
		this.requireSubmission(appended);
		if (!('entry' in appended)) throw new Error(`Room '${this.name}' stopped before cancellation.`);
	}

	/** Revoke every running lease and due obligation until a durable read finds none. */
	private async stopWork(): Promise<void> {
		// Admission is closed. Each entry settles one recorded obligation;
		// the final decision confirms the recovered journal has no work left.
		for (;;) {
			const result = await this.submit('lease', () => stopWorkDecision(this.state(), this.now()));
			this.requireSubmission(result);
			if (!('entry' in result)) return;
		}
	}

	private requireEnd(result: boolean | { refusal: Refusal }): boolean {
		if (typeof result === 'boolean') return result;
		throw new Error(refusalMessage(result.refusal));
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
		operation = this.stopRun().catch((error) => {
			if (this.stopInFlight === operation) this.stopInFlight = undefined;
			throw error;
		});
		this.stopInFlight = operation;
		return operation;
	}

	private async stopRun(): Promise<void> {
		try {
			// A room dropped from memory writes nothing: the next run over the journal takes it up.
			if (this.phase === 'evicted') return;
			await this.ready;
			await this.journal.settled();
			await this.tasks.cancel(`stop:${this.state().exchange?.from ?? 0}`);
			await this.stopWork();
			// A write queued ahead of the stop lands first, so the record says who was present.
			await this.journal.settled();
			await this.leaveEverybody();
		} catch (error) {
			// A stop that found another run's fence has nothing left to write: the
			// run said `superseded`, and the name is the other run's.
			if (this.phase !== 'evicted') throw error;
		} finally {
			this.evictTaskRooms();
			// The name comes free whatever the storage did. A failed write must
			// not leave a room that can never be started again.
			this.runtime.release(this);
			this.rejectExchangeWaiters(new Error(`Room '${this.name}' was stopped.`));
		}
	}

	/** Working rooms are cohosted implementation details of their origin. */
	private evictTaskRooms(exchange?: Seq): void {
		const names = new Set(
			[...(this.state().tasks?.values() ?? [])]
				.filter(
					(task) =>
						task.originRoom === this.name && (exchange === undefined || task.exchange === exchange),
				)
				.map((task) => task.workingRoom),
		);
		for (const name of names) {
			const child = this.runtime.get(name);
			if (child === undefined) continue;
			this.runtime.release(child);
			child.evict();
		}
	}

	/**
	 * A deliberate shutdown observed everybody leaving, so the record says
	 * so, and the host hears it. It wakes nobody: an activation started to
	 * hear that the room is closing is an activation nobody reads.
	 */
	private async leaveEverybody(): Promise<void> {
		for (const person of this.state().people.values()) {
			if (person.presence !== 'present') continue;
			const visit = this.visits.get(person.name);
			await this.commitPresence({ kind: 'left', from: person.name, subject: person.name }, false);
			if (visit) {
				visit.gone = true;
				if (this.visits.get(person.name) === visit) this.visits.delete(person.name);
			}
		}
	}

	/**
	 * Dropped from memory: the alarm is cancelled, the journal is closed, every
	 * call a seat makes from now on is stale, every visit is over, nothing
	 * the host does with the handle writes, nothing reaches a listener again,
	 * and nobody waits on the room. The record keeps what landed before, and
	 * nothing this run had queued lands after.
	 */
	evict(): void {
		const origin = this.state().composition?.taskScope?.room;
		const parent = origin === undefined ? undefined : this.runtime.get(origin);
		if (parent instanceof RoomHost) void parent.reconcile();
		this.evictTaskRooms();
		this.phase = 'evicted';
		this.deliveryStates.clear();
		this.journal.close();
		this.cancelAlarm();
		this.listeners.clear();
		for (const visit of this.visits.values()) visit.gone = true;
		this.rejectExchangeWaiters(new Error(`Room '${this.name}' was evicted.`));
	}
}

/** The cast as the journal holds it: every seat by name, identity, and attention. */
function compositionOf(cast: CompositionDraft, at: string): Without<Composition, 'seq'> {
	return {
		...(cast.goal === undefined ? {} : { goal: cast.goal }),
		version: 2,
		...(cast.taskScope === undefined ? {} : { taskScope: cast.taskScope }),
		...(cast.summary === undefined ? {} : { summary: cast.summary }),
		agents: cast.definitions
			.filter((agent) => cast.seats.has(agent.name))
			.map((agent) => ({
				name: agent.name,
				identity: agent.identity,
				attention: cast.seats.get(agent.name) ?? 'broadcast',
			})),
		available: cast.definitions
			.filter((agent) => !cast.seats.has(agent.name))
			.map((agent) => ({
				name: agent.name,
				identity: agent.identity,
				attention: 'broadcast' as const,
			})),
		at,
	};
}
