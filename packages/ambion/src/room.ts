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
 *   and the lease it holds — the three calls in `wire.ts`.
 * - **Say when it has stopped.** An exchange closed, and nothing live.
 */

import type { Committed } from '@ambionframework/journal';
import type { SessionOpener } from '@ambionframework/journal/pi';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { answerCommit, answerLease, answerView, RefusedError } from './answers.ts';
import { captureAgent, captureHuman } from './define.ts';
import {
	defaultRuntime,
	type RunningRoom,
	type Runtime,
	registerRoom,
	releaseRoom,
	runningRoom,
	stubModel,
	type Transport,
} from './host/runtime.ts';
import { type Body, type Entry, type Kind, placed, RoomJournal } from './journal/journal.ts';
import { summaryCompletion } from './room/exchange.ts';
import { foldRoom, type RoomState } from './room/fold.ts';
import { isLive, seatOf } from './room/lease.ts';
import type { VisitRuntime } from './room/presence.ts';
import { type LiveWork, liveWork } from './room/reconcile.ts';
import {
	decide,
	evolve,
	type ReconcileDecision,
	type RoomCommand,
	type RoomDecision,
} from './room/transition.ts';
import { seatsOf } from './room/view.ts';
import { inProcessTransport } from './seat/seat.ts';
import type {
	AgentDefinition,
	Attention,
	ClosedExchange,
	Exchange,
	HumanDefinition,
	Message,
	ModelResolver,
	PresenceMessage,
	RoomNotification,
	SeatInfo,
	Seq,
	SummaryMessage,
} from './types.ts';
import type {
	Close,
	CommitRequest,
	CommitResult,
	Composition,
	EndReason,
	LeaseChange,
	LeaseRequest,
	LeaseResponse,
	SeatPort,
	ViewResponse,
	Without,
} from './wire.ts';

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
interface CompositionDraft {
	goal: string | undefined;
	assistant: string | undefined;
	definitions: AgentDefinition[];
	seats: ReadonlyMap<string, Attention>;
}

/** A presence change before the room stamps when it happened. */
type PresenceDraft = Omit<PresenceMessage, 'seq' | 'key' | 'at' | 'wakes'>;

export interface StartRoomOptions {
	/** The room's name: the record belongs to it, across every run. */
	name: string;
	/** All ordinary executable definitions for this run, including agents initially in reserve. */
	agents?: readonly AgentDefinition[];
	/** Initial membership and attention. Omit to seat every ordinary agent at broadcast. */
	seats?: Readonly<Record<string, Attention>>;
	/**
	 * The room's assistant: an agent that composes the room at the open of an
	 * exchange, from the reserve, and writes the one message a person reads
	 * when their exchange closes, shaped to how that person reads.
	 *
	 * The option seats it at `none`. A room without one closes
	 * every exchange and owes no summary.
	 */
	assistant?: AgentDefinition;
	/** What the room is for. Read by every agent; gates the arrival paragraph. */
	goal?: string;
	/**
	 * Override the model call — Pi's own extension surface, and the only one
	 * here: a scripted stream makes the room deterministic, a custom stream
	 * brings custom providers. Defaults to the runtime's.
	 */
	streamFn?: StreamFn;
	/** The runtime this room runs in. Defaults to `defaultRuntime`. */
	runtime?: Runtime;
}

export interface ReadRoomOptions {
	runtime?: Runtime;
}

export interface ResumeRoomOptions {
	/** The definitions that resolve the roster and reserve recorded by the prior run. */
	agents: readonly AgentDefinition[];
	runtime?: Runtime;
	/** Override the model call, as `startRoom` does. */
	streamFn?: StreamFn;
}

/** A room's durable state at the time it is read, with no live methods or subscriptions. */
export interface RoomSnapshot {
	readonly name: string;
	readonly messages: readonly Message[];
	readonly participants: readonly SeatInfo[];
	readonly exchange: Exchange | undefined;
}

export interface ExchangeHandle {
	/** The person who opened this exchange. */
	readonly owner: string;
	/** The source sequence of the opening question. This identifies the exchange. */
	readonly from: Seq;
	/** The timestamp of the opening question. */
	readonly at: string;
	/**
	 * Resolve with the fixed non-summary conversation after the durable close.
	 * Reject if the room stops before the exchange closes.
	 */
	messages(): Promise<Message[]>;
	/** Resolve with the durable summary, or `undefined` when no summary is needed; reject when required work fails. */
	response(): Promise<SummaryMessage | undefined>;
}

export interface Room {
	readonly name: string;
	messages(options?: { since?: Seq }): Promise<Message[]>;
	participants(): SeatInfo[];
	subscribe(listener: (event: RoomNotification) => void): () => void;
	/** Reacquire an exchange by the source sequence of its opening question. */
	exchange(from: Seq): ExchangeHandle | undefined;
	visit(human: HumanDefinition): Promise<Visit>;
	stop(): Promise<void>;
	/** Revoke every lease in flight. The room keeps running; `stop` ends it. */
	abort(): void;
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
export async function startRoom(options: StartRoomOptions): Promise<Room> {
	const runtime = options.runtime ?? defaultRuntime;
	assertFree(runtime, options.name);
	const room = RoomHost.start(options, runtime);
	registerRoom(runtime, room);
	// A composition the record refuses frees the name: the handle answers
	// every call with the refusal, and nothing runs under it.
	try {
		await room.started();
	} catch (error) {
		free(runtime, room);
		throw error;
	}
	return room;
}

/**
 * Brings a name back up over its journal, with the composition the journal holds.
 * Every name on the roster resolves through the explicit bindings, and the
 * first one missing is the error. The room reconciles at once: a lease the
 * last run left expires, a wake it left pending is sent again, and an
 * exchange it left open closes once nothing works on it.
 */
export async function resumeRoom(name: string, options: ResumeRoomOptions): Promise<Room> {
	const runtime = options.runtime ?? defaultRuntime;
	assertFree(runtime, name);
	const room = RoomHost.resume(name, runtime, options.streamFn, definitionsOf(options.agents));
	registerRoom(runtime, room);
	try {
		await room.started();
	} catch (error) {
		free(runtime, room);
		throw error;
	}
	return room;
}

/** The name comes free, unless another room took it since. */
function free(runtime: Runtime, room: RoomHost): void {
	releaseRoom(runtime, room.name, room);
}

function assertFree(runtime: Runtime, name: string): void {
	if (runningRoom(runtime, name) !== undefined) {
		throw new Error(`Room '${name}' is already running: stop it before starting it again.`);
	}
}

/** Reads a name and starts nothing. */
export async function readRoom(name: string, options: ReadRoomOptions = {}): Promise<RoomSnapshot> {
	const runtime = options.runtime ?? defaultRuntime;
	const live = runningRoom(runtime, name);
	if (live instanceof RoomHost) return live.snapshot();
	const journal = new RoomJournal(runtime.journals.open(name));
	await journal.ready;
	const state = foldRoom(journal.entries, runtime.retry);
	const liveSeats = liveWork(state, runtime.clock.now()).seats;
	return {
		name,
		messages: journal.messages(),
		participants: seatsOf({ name, state, live: liveSeats }),
		exchange: state.exchange,
	};
}

const _stale = (why: string) => ({ stale: why });

/** How many times one pass folds, decides and writes before it yields. */
const PASSES = 8;

// -- the room ----------------------------------------------------------------

class RoomHost implements Room, RunningRoom {
	readonly name: string;
	readonly stream: StreamFn;
	readonly model: ModelResolver;
	readonly transcripts: SessionOpener;
	readonly runtime: Runtime;
	/** How this room reaches a seat: what the runtime holds, or every seat as an actor in this process. */
	private readonly transport: Transport;
	readonly journal: RoomJournal;
	/** The replay, the composition on the journal, and the first reconcile. Every operation waits here. */
	readonly ready: Promise<void>;
	/** Every definition this room can seat, by name. */
	private readonly defs: ReadonlyMap<string, AgentDefinition>;
	/** The handles the host delivers through. Presence itself is a fold over the journal. */
	private readonly visits = new Map<string, VisitRuntime>();
	private readonly ports = new Map<string, SeatPort>();
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
	/** Every lease id this room has heard a change for. It says `activation_start` once. */
	private readonly heardLeases = new Set<string>();
	private cancelAlarm: () => void = () => {};
	/** The reconcile in flight: the entries it writes, and whoever it wakes. A caller that asks waits for it. */
	private reconciling: Promise<void> = Promise.resolve();
	private fold: { length: number; state: RoomState } | undefined;
	private phase: Phase = 'starting';
	/** This run's id: the fence it writes first, and the stamp on every entry it writes. */
	private readonly run = crypto.randomUUID();
	/** Whether the room has told the host about the rest it is in. */

	static start(options: StartRoomOptions, runtime: Runtime): RoomHost {
		return new RoomHost(options.name, runtime, options, composeFrom(options));
	}

	static resume(
		name: string,
		runtime: Runtime,
		streamFn: StreamFn | undefined,
		bindings: Map<string, AgentDefinition>,
	): RoomHost {
		return new RoomHost(name, runtime, { streamFn }, undefined, bindings);
	}

	private constructor(
		name: string,
		runtime: Runtime,
		options: { streamFn?: StreamFn },
		cast: CompositionDraft | undefined,
		bindings: Map<string, AgentDefinition> = new Map(),
	) {
		this.name = name;
		this.runtime = runtime;
		this.transport = runtime.transport ?? inProcessTransport();
		this.transcripts = runtime.transcripts;
		this.journal = new RoomJournal(
			runtime.journals.open(name),
			(entry) => this.hear(entry),
			this.run,
			() => this.superseded(),
		);
		this.stream = options.streamFn ?? runtime.stream;
		this.model = options.streamFn ? stubModel : runtime.model;
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
		this.seedHeardLeases();
		this.acceptedEvent(decide(this.state(), { type: 'compose', composition }, this.now()));
		await this.journal.write('run', () => {
			const event = this.acceptedEvent(decide(this.state(), { type: 'run' }, this.now()));
			return event?.body;
		});
		await this.journal.write('composition', () => {
			const event = this.acceptedEvent(
				decide(this.state(), { type: 'compose', composition }, this.now()),
			);
			return event?.body;
		});
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
		await this.journal.write('run', () => {
			this.validateDefinitions(this.state());
			const event = this.acceptedEvent(decide(this.state(), { type: 'run' }, this.now()));
			return event?.body;
		});
		await this.journal.write('composition', () => {
			const current = this.state();
			this.validateDefinitions(current);
			const composition = current.composition;
			if (composition === undefined) return undefined;
			const roster = new Set(current.roster.map((seat) => seat.name));
			const catalog = new Map(
				[...composition.agents, ...composition.available, ...current.roster].map((seat) => [
					seat.name,
					seat,
				]),
			);
			for (const agent of this.defs.values())
				if (!catalog.has(agent.name))
					catalog.set(agent.name, {
						name: agent.name,
						identity: agent.identity,
						attention: 'broadcast',
					});
			const available = [...catalog.values()].filter((seat) => !roster.has(seat.name));
			const { seq: _seq, at: _at, ...prior } = composition;
			const body = { ...prior, agents: current.roster, available, at: this.iso() };
			const event = this.acceptedEvent(
				decide(current, { type: 'compose', composition: body }, this.now()),
			);
			return event?.body;
		});
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
		releaseRoom(this.runtime, this.name, this);
		this.evict();
	}

	// -- what the room holds --------------------------------------------------

	private now(): number {
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
				listener(event);
			} catch {
				// A listener's failure is the listener's problem, never the room's.
			}
		}
	}

	/** The record, once every write asked for has landed or failed and every doubt is settled. */
	async messages(options: { since?: Seq } = {}): Promise<Message[]> {
		await this.ready;
		await this.journal.settled();
		return this.journal.messages(options.since);
	}

	/** The roster and people folded from the durable record. */
	participants(): SeatInfo[] {
		const state = this.state();
		return seatsOf({ name: this.name, state, live: this.live(state) });
	}

	async snapshot(): Promise<RoomSnapshot> {
		await this.ready;
		await this.journal.settled();
		const state = this.state();
		return {
			name: this.name,
			messages: this.journal.messages(),
			participants: seatsOf({ name: this.name, state, live: this.live(state) }),
			exchange: state.exchange,
		};
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

	private handleFor(exchange: Exchange): ExchangeHandle {
		const at =
			this.state().messages.find((message) => message.seq === exchange.from)?.at ?? exchange.at;
		return {
			owner: exchange.owner,
			from: exchange.from,
			at,
			messages: () => this.exchangeMessages(exchange.from),
			response: () => this.responseFor(exchange.from),
		};
	}

	private closedFor(from: Seq): ClosedExchange | undefined {
		const close = this.state().closes.find((candidate) => candidate.from === from);
		if (close === undefined) return undefined;
		return {
			owner: close.owner,
			from: close.from,
			through: close.through,
			at: this.state().messages.find((message) => message.seq === from)?.at ?? close.at,
		};
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
		return this.journal
			.messages()
			.filter((message) => message.kind !== 'summary')
			.filter((message) => message.seq >= close.from && message.seq <= close.through);
	}

	private async responseFor(from: Seq): Promise<SummaryMessage | undefined> {
		const close = await this.waitForClose(from);
		for (;;) {
			const result = this.responseResult(close);
			if (result === 'silent') return undefined;
			if (result !== 'pending' && result !== 'failed') return result;
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
		const completion = summaryCompletion(recordedClose, state.messages, state.leases);
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
		await this.ready;
		this.assertVisitable(captured);
		const known = this.visits.get(captured.name);
		if (known) return this.handle(known);
		const visit: VisitRuntime = { human: captured, gone: false };
		this.visits.set(captured.name, visit);
		// A person the journal holds as present is here already: the last run wrote
		// no `left`, and the host's word is what says otherwise. Nothing commits.
		// An arrival whose confirmation was lost is read back first.
		await this.journal.settled();
		// A room that stopped while this waited seats nobody.
		this.assertRunning();
		if (this.state().people.get(captured.name)?.presence !== 'present') {
			try {
				await this.commitPresence({
					kind: 'arrived',
					from: captured.name,
					subject: captured.name,
					identity: captured.identity,
					...(captured.preferences === undefined ? {} : { preferences: captured.preferences }),
				});
			} catch (error) {
				// An arrival the storage refused is no visit: the next visit writes it again.
				this.visits.delete(captured.name);
				throw error;
			}
		}
		return this.handle(visit);
	}

	/** One name names one participant, and a present person keeps one identity. */
	private assertVisitable(human: HumanDefinition): void {
		if (this.defs.has(human.name)) {
			throw new Error(`'${human.name}' is an agent in this room: one name names one participant.`);
		}
		this.validatePresence({
			kind: 'arrived',
			from: human.name,
			subject: human.name,
			identity: human.identity,
		});
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
		if (visit.gone) return;
		visit.gone = true;
		this.visits.delete(visit.human.name);
		await this.commitPresence({ kind: 'left', from: visit.human.name, subject: visit.human.name });
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
		if ('missed' in committed) throw new Error('The delivery record moved before it landed.');
		const message = placed(committed.entry);
		return this.handleForMessage(message);
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
		this.assertRunning();
		await this.ready;
		const definition = this.defs.get(name);
		if (definition === undefined) throw new Error(`Unknown agent '${name}'.`);
		const change: PresenceDraft = {
			kind: 'seated',
			subject: name,
			identity: definition.identity,
			attention: options.attention ?? 'broadcast',
		};
		this.validatePresence(change);
		await this.commitPresence(change);
	}

	/** The host takes an agent off the roster. It keeps the assistant seated. */
	async unseat(name: string): Promise<void> {
		this.assertRunning();
		await this.ready;
		if (!this.defs.has(name)) throw new Error(`Unknown agent '${name}'.`);
		this.validatePresence({ kind: 'unseated', subject: name });
		await this.revoke((seat) => seat === name);
		await this.commitPresence({ kind: 'unseated', subject: name });
	}

	// -- commits ----------------------------------------------------------------

	/**
	 * One operation on the room's commit queue: the draft is built where the
	 * write happens, with the wakes the room decides for it. The journal hears
	 * the message inside the same link, so what the room does with it happens
	 * before anything lands on top. A repeated token appends nothing, so the
	 * journal hears nothing, and the room reacts to nothing.
	 */
	private commitMessage(
		key: string,
		command: Extract<RoomCommand, { type: 'deliver' | 'presence' | 'commit' }>,
	): Promise<Committed<Body<Message>, Body<Message>>> {
		return this.journal.commit<Body<Message>>({
			key,
			draft: () => {
				const event = this.acceptedEvent(decide(this.state(), command, this.now()));
				if (event === undefined) throw new Error('The room command did not propose a message.');
				return event.body;
			},
		});
	}

	/** Validate before host effects, then decide again where the message commits. */
	private validatePresence(change: PresenceDraft): void {
		this.acceptedEvent(
			decide(this.state(), { type: 'presence', change, route: false }, this.now()),
		);
	}

	/** A presence change uses a fresh key. */
	private commitPresence(change: PresenceDraft, route = true, key = crypto.randomUUID()) {
		return this.commitMessage(key, { type: 'presence', change, route });
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
		if (entry.kind === 'message') {
			const message = placed(entry);
			this.heardMessage(message);
		} else if (entry.kind === 'close') this.heardClose(entry.body);
		else if (entry.kind === 'lease') this.heardLease(entry.body, this.opens(entry.body.id));
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
	private heardMessage(message: Message): void {
		this.emit({ type: 'message', message });
		this.noteExchange(message.seq);
		this.steer(message);
		this.notifyExchangeWaiters();
		void this.reconcile();
	}

	/**
	 * An exchange ended at the range the close names. The host hears it
	 * before anything is written about it: the assistant is the first reader
	 * of a closed exchange and not the only one. A question that landed
	 * ahead of the close opens the next exchange, and the room says so.
	 */
	private heardClose(close: Close): void {
		const question = this.journal.messages().find((m) => m.seq === close.from);
		this.emit({
			type: 'exchange_closed',
			exchange: {
				owner: close.owner,
				from: close.from,
				at: question?.at ?? close.at,
				through: close.through,
			},
		});
		const next = this.state().exchange;
		if (next !== undefined) this.noteExchange(next.from);
		this.notifyExchangeWaiters();
	}

	/**
	 * A lease change: the first change of an id starts an activation, and an
	 * end ends one. A change that ends a lease the journal never held is a
	 * wake written off, and starts nothing.
	 */
	private heardLease(lease: LeaseChange, first: boolean): void {
		const seat = seatOf(lease.id) ?? '';
		if (lease.phase === 'running') {
			if (first) {
				this.emit({ type: 'activation_start', agent: seat });
			}
			// A claim that lost its confirmation never armed the expiry: this pass does.
			void this.reconcile();
			this.notifyExchangeWaiters();
			return;
		}
		if (first) {
			// A change that ends a lease the journal never held is an attempt nobody made.
			if (lease.reason === 'abandoned') {
				this.emit({ type: 'abandoned', agent: seat, activation: lease.id });
				void this.reconcile();
			}
			this.notifyExchangeWaiters();
			return;
		}
		const spoke = this.journal.messages().some((m) => m.activationId === lease.id);
		this.emit({ type: 'activation_end', agent: seat, spoke });
		this.notifyExchangeWaiters();
		if (lease.reason === 'expired') {
			this.emit({
				type: 'error',
				agent: seat,
				error: new Error('The activation ran past its lease.'),
			});
		}
	}

	/** The question at `seq` opened an exchange, and the room says so. */
	private noteExchange(seq: Seq): void {
		const state = this.state();
		if (state.exchange?.from !== seq) return;
		this.emit({ type: 'exchange_opened', exchange: state.exchange });
	}

	/**
	 * Send projected ordinary targets when their recorded lease is live now.
	 * The delivery projection excludes authors and context-bound activations.
	 */
	private steer(message: Message): void {
		const state = this.state();
		const delivery = state.deliveries.get(message.seq);
		if (delivery === undefined) return;
		const after =
			state.messages.filter((candidate) => candidate.seq < message.seq).at(-1)?.seq ?? 0;
		for (const steer of delivery.steers) {
			const lease = state.leases.get(steer.activation);
			if (lease === undefined || !isLive(lease, this.now())) continue;
			const seat = steer.seat;
			void this.port(seat)
				.steer({
					room: this.name,
					seat,
					activation: steer.activation,
					after,
					message,
				})
				.catch(() => {});
		}
	}

	/** One activation wake over the wire. */
	private send(id: string, seat: string): void {
		this.sentAt.set(id, this.now());
		void this.port(seat)
			.wake({ room: this.name, seat, activation: id })
			.catch(() => {});
	}

	private port(seat: string): SeatPort {
		let port = this.ports.get(seat);
		if (port === undefined) {
			port = this.transport.connect(this, seat, this.runtime);
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

	/** The definition a seat runs, off the names this room knows. */
	definition(seat: string): AgentDefinition | undefined {
		return this.defs.get(seat);
	}

	/** One operation on the room's commit queue, with the wakes the room routes. */
	write(commit: CommitRequest): Promise<Committed<Body<Message>, Body<Message>>> {
		return this.commitMessage(commit.key, { type: 'commit', commit });
	}

	private acceptedEvent<K extends Kind>(decision: RoomDecision<K>) {
		if ('refusal' in decision) {
			throw new RefusedError(decision.refusal);
		}
		return decision.event;
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
		let expiresAt: number | undefined;
		const written = await this.journal.write('lease', () => {
			if (this.gone()) return undefined;
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
			if ('refusal' in decision) return undefined;
			const event = decision.event;
			if (event === undefined || event.body.phase !== 'running') return undefined;
			expiresAt = event.body.expiresAt;
			return event.body;
		});
		return !written || expiresAt === undefined
			? { stale: 'the lease ended' }
			: { ok: { expiresAt, lastSeq: this.journal.lastCommitted } };
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
	end(id: string, reason: EndReason, readThrough: Seq): Promise<boolean> {
		return this.journal.write('lease', () => {
			const event = this.acceptedEvent(
				decide(this.state(), { type: 'end', id, reason, readThrough }, this.now()),
			);
			return event?.body;
		});
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
		const decision = decide(
			this.state(),
			{
				type: 'reconcile',
				options: {
					resend: this.runtime.wake.resend,
					attempts: this.runtime.retry.attempts,
					sent: this.sentAt,
					stopped: this.gone(),
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
			return this.end(event.body.id, event.body.reason, event.body.readThrough);
		return event.kind === 'close' ? this.close(event.body) : Promise.resolve(false);
	}

	/**
	 * The room completed an exchange, so that exchange ends at the record
	 * as the decision saw it: the close is an entry on the journal, written where the
	 * fold still says the same exchange is open. `heardClose` says so, and
	 * opens the next exchange when a question landed after the decision; the
	 * next pass closes that one at once when nobody works on it.
	 */
	private async close(close: Close): Promise<boolean> {
		const written = await this.journal.write('close', () => {
			if (this.gone()) return undefined;
			const event = this.acceptedEvent(decide(this.state(), { type: 'close', close }, this.now()));
			return event?.body;
		});
		if (written) return true;
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
			at === undefined ? () => {} : this.runtime.clock.alarm(at, () => void this.reconcile());
	}

	// -- control ----------------------------------------------------------------

	abort(): void {
		// A room that is gone writes nothing more: the stop revoked what was live, or the next run does.
		if (this.gone()) return;
		void this.revoke(() => true);
	}

	/**
	 * Revoke every live lease on the seats `which` picks: the room writes the
	 * end, and the seat side is cut. A write that was queued ahead of the
	 * revoke lands first and can leave a lease live or a wake pending, so
	 * the room looks again until nothing it picks is live.
	 */
	private async revoke(which: (seat: string) => boolean): Promise<void> {
		if (this.phase === 'evicted') return;
		await this.ready.catch(() => {});
		for (let pass = 0; pass < PASSES; pass += 1) {
			const picked = [...this.live(this.state())].filter(([seat]) => which(seat));
			if (picked.length === 0) break;
			for (const [seat, ids] of picked) await this.cut(seat, ids);
		}
		if (!this.gone()) await this.reconcile();
	}

	/**
	 * Cut one seat: every lease it holds ends revoked, every wake pending for
	 * it and every draft due for it is written off the same way, and the seat
	 * side is told to stop, wherever the seat runs. The room writes first, so
	 * a seat that never hears the cut is refused whatever it writes after it.
	 */
	private async cut(seat: string, ids: string[]): Promise<void> {
		for (const id of ids) await this.end(id, 'revoked', 0);
		const port = this.port(seat);
		for (const id of ids) void port.cut(id).catch(() => {});
	}

	/** Closes the run: what is live is revoked, what is present is marked gone, and the name comes free. */
	async stop(): Promise<void> {
		if (this.phase === 'stopped') return;
		// Stopped from here on: a visit that arrives during the shutdown is
		// refused rather than seated into a room that is going away.
		this.enter('stopped');
		this.cancelAlarm();
		try {
			// A room dropped from memory writes nothing: the next run over the journal takes it up.
			if (this.phase === 'evicted') return;
			await this.ready;
			await this.revoke(() => true);
			// A write queued ahead of the stop lands first, so the record says who was present.
			await this.journal.settled();
			await this.leaveEverybody();
		} catch (error) {
			// A stop that found another run's fence has nothing left to write: the
			// run said `superseded`, and the name is the other run's.
			if (this.phase !== 'evicted') throw error;
		} finally {
			// The name comes free whatever the storage did. A failed write must
			// not leave a room that can never be started again.
			releaseRoom(this.runtime, this.name, this);
			this.rejectExchangeWaiters(new Error(`Room '${this.name}' was stopped.`));
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
			if (visit) visit.gone = true;
			await this.commitPresence({ kind: 'left', from: person.name, subject: person.name }, false);
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
		this.phase = 'evicted';
		this.journal.close();
		this.cancelAlarm();
		this.listeners.clear();
		for (const visit of this.visits.values()) visit.gone = true;
		this.rejectExchangeWaiters(new Error(`Room '${this.name}' was evicted.`));
	}
}

/**
 * The composition `startRoom` was given, checked for duplicates the way
 * the room refuses them. The assistant is a seating like every other: the
 * option seats it at `none`, beside the agents.
 */
function composeFrom(options: StartRoomOptions): CompositionDraft {
	const definitions = capturedDefinitions(options);
	const attentions = initialSeats(options, definitions);
	return {
		goal: options.goal?.trim() || undefined,
		assistant: options.assistant?.name,
		definitions,
		seats: attentions,
	};
}

function capturedDefinitions(options: StartRoomOptions): AgentDefinition[] {
	const definitions = (options.agents ?? []).map(captureAgent);
	if (options.assistant !== undefined) definitions.push(captureAgent(options.assistant));
	const names = new Set<string>();
	for (const definition of definitions) {
		if (names.has(definition.name)) throw duplicate(definition.name);
		names.add(definition.name);
	}
	return definitions;
}

function initialSeats(
	options: StartRoomOptions,
	definitions: readonly AgentDefinition[],
): Map<string, Attention> {
	const configured = options.seats;
	const selected = new Set(
		configured === undefined
			? (options.agents ?? []).map((agent) => agent.name)
			: Object.keys(configured),
	);
	if (options.assistant !== undefined) selected.add(options.assistant.name);
	const names = new Set(definitions.map((agent) => agent.name));
	for (const name of selected) if (!names.has(name)) throw new Error(`Unknown agent '${name}'.`);
	if (
		options.assistant !== undefined &&
		configured?.[options.assistant.name] !== undefined &&
		configured[options.assistant.name] !== 'none'
	)
		throw new Error(`Assistant '${options.assistant.name}' must have attention 'none'.`);
	return new Map(
		definitions
			.filter((agent) => selected.has(agent.name))
			.map((agent) => [
				agent.name,
				agent.name === options.assistant?.name ? 'none' : (configured?.[agent.name] ?? 'broadcast'),
			]),
	);
}

function definitionsOf(agents: readonly AgentDefinition[]): Map<string, AgentDefinition> {
	const bindings = new Map<string, AgentDefinition>();
	for (const agent of agents) {
		const captured = captureAgent(agent);
		if (bindings.has(captured.name)) throw duplicate(captured.name);
		bindings.set(captured.name, captured);
	}
	return bindings;
}

function duplicate(name: string): Error {
	return new Error(`Duplicate agent name '${name}': one name names one participant.`);
}

/** The cast as the journal holds it: every seat by name, identity, and attention. */
function compositionOf(cast: CompositionDraft, at: string): Without<Composition, 'seq'> {
	return {
		...(cast.goal === undefined ? {} : { goal: cast.goal }),
		...(cast.assistant === undefined ? {} : { assistant: cast.assistant }),
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
