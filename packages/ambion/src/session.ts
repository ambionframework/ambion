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
import type { SessionRepo, StreamFn } from '@earendil-works/pi-agent-core';
import {
	defaultRuntime,
	type RunningRoom,
	type Runtime,
	sessionsOver,
	stubModel,
	type Transport,
} from './host/runtime.ts';
import { type Committed, type Entry, RoomJournal } from './journal/journal.ts';
import { renderLine } from './render.ts';
import { assertAssistant } from './room/assistant.ts';
import { checkpointOf, foldRoom, type RoomState } from './room/fold.ts';
import { activationId, isExpired, isLive, type LeaseState, parseId, seatOf } from './room/lease.ts';
import type { VisitRuntime } from './room/presence.ts';
import { type Decision, decide, liveSeats, working } from './room/reconcile.ts';
import { type RoomFacts, seatsOf, viewOf } from './room/view.ts';
import { inProcessTransport, wakes } from './seat/seat.ts';
import {
	type AgentDefinition,
	type AgentSeat,
	type Attention,
	authorOf,
	type Exchange,
	type HumanDefinition,
	isAgent,
	isSeatedAgent,
	isSpoken,
	type Message,
	type ModelResolver,
	type Participant,
	type PresenceMessage,
	type SeatInfo,
	type Seq,
	type SessionEvent,
	type SessionOpener,
	type SpokenMessage,
	type SummaryMessage,
} from './types.ts';
import type {
	Close,
	Commit,
	CommitResponse,
	Composition,
	EndReason,
	Lease,
	LeaseChange,
	LeaseResponse,
	Seating,
	SeatPort,
	ViewResponse,
	Without,
} from './wire.ts';

/** An agent with the attention it takes when seated. */
interface Placed {
	def: AgentDefinition;
	attention: Attention;
}

/** What a run starts with, as values. The entry on the journal is the same, by name. */
interface Cast {
	assistant: AgentDefinition;
	goal: string | undefined;
	agents: Placed[];
	available: Placed[];
}

/** A message before the journal stamps its seq, its key and its wakes. */
type Drafted =
	| Omit<SpokenMessage, 'seq' | 'key' | 'wakes'>
	| Omit<SummaryMessage, 'seq' | 'key' | 'wakes'>
	| Omit<PresenceMessage, 'seq' | 'key' | 'wakes'>;

/** A presence change before the room stamps when it happened. */
type PresenceDraft = Omit<PresenceMessage, 'seq' | 'key' | 'at' | 'wakes'>;

export interface StartSessionOptions {
	/** The session's name: the record belongs to it, across every run. */
	name: string;
	/** The agents seated when the room starts. May be empty: a room needs its assistant alone. */
	agents?: readonly AgentSeat[];
	/**
	 * The reserve: agents the room does not seat now, and the assistant may
	 * seat when a question needs them. A reserve entry carries an attention the
	 * way a seated one does. Empty, or absent, means the assistant is never
	 * woken at the open of an exchange.
	 */
	available?: readonly AgentSeat[];
	/**
	 * The room's assistant: an agent that composes the room at the open of an
	 * exchange, from the reserve, and writes the one message a person reads
	 * when their exchange closes, shaped to how that person reads. It is seated
	 * with the agents, at `none`, and it writes for every person who visits.
	 * It carries no tools and no workspace: the room refuses one that does.
	 */
	assistant: AgentDefinition;
	/** What the room is for. Read by every agent; gates the arrival paragraph. */
	goal?: string;
	/**
	 * Override the model call — Pi's own extension surface, and the only one
	 * here: a scripted stream makes the room deterministic, a custom stream
	 * brings custom providers. Defaults to the runtime's.
	 */
	streamFn?: StreamFn;
	/** Pi's own session repository. Defaults to the runtime's opener. */
	repo?: SessionRepo;
	/** The runtime this room runs in. Defaults to `defaultRuntime`. */
	runtime?: Runtime;
}

export interface ReadSessionOptions {
	repo?: SessionRepo;
	runtime?: Runtime;
}

export interface ResumeSessionOptions {
	runtime?: Runtime;
	/** Override the model call, as `startSession` does. */
	streamFn?: StreamFn;
}

/** Reading a room takes no run: the pull side, and nothing that starts anything. */
export interface SessionView {
	readonly name: string;
	messages(options?: { since?: Seq }): Promise<Message[]>;
	seats(): SeatInfo[];
	subscribe(listener: (event: SessionEvent) => void): () => void;
}

export interface Session extends SessionView {
	/** The question the room is working on, or nothing when nobody has asked. A fold over the journal. */
	exchange(): Exchange | undefined;
	/** Resolves when no seat that speaks for itself is live and the assistant is not composing. */
	settled(): Promise<void>;
	/**
	 * Resolves when nothing at all is live: no lease held, no wake pending,
	 * no draft due. `settled()` reports the seats alone, which is what rule 5
	 * needs it to mean; this is what a host waits for when it wants the one
	 * message a person reads.
	 */
	quiet(): Promise<void>;
	/** Revoke every lease in flight. The room keeps running; `stopSession` ends it. */
	abort(): void;
	/**
	 * Put an agent on the roster while the room runs, from the reserve or from
	 * anywhere. The seating lands on the record, and it wakes the seat it names.
	 */
	seat(seat: AgentSeat): Promise<void>;
	/**
	 * Take an agent off the roster. Its lease in flight is revoked, the
	 * record says it left, and an agent that came from the reserve returns to it.
	 */
	unseat(agent: AgentDefinition): Promise<void>;
	/** Fold, decide, write, send. The room runs it on its own; a host on a platform with its own alarms calls it. */
	reconcile(): Promise<void>;
}

export interface Visit {
	readonly human: HumanDefinition;
	/** The seq of this person's last `left`, or undefined the first time. A live read. */
	readonly since: Seq | undefined;
	/**
	 * Put a message on the record. `key` names the delivery: a repeated key
	 * lands once, so a host that never learned whether a delivery landed
	 * delivers it again under the same key.
	 */
	deliver(input: { to?: Participant; text: string; key?: string }): Promise<void>;
	leave(): Promise<void>;
}

/** Sets up the context where the agents work. */
export function startSession(options: StartSessionOptions): Session {
	const runtime = options.runtime ?? defaultRuntime;
	assertFree(runtime, options.name);
	const session = SessionImpl.start(options, runtime);
	runtime.running.set(options.name, session);
	// A composition the record refuses frees the name: the handle answers
	// every call with the refusal, and nothing runs under it.
	session.started().catch(() => free(runtime, session));
	return session;
}

/**
 * Brings a name back up over its journal, with the composition the journal holds.
 * Every name on the roster resolves through the runtime's catalog, and the
 * first one missing is the error. The room reconciles at once: a lease the
 * last run left expires, a wake it left pending is sent again, and an
 * exchange it left open closes once nothing works on it.
 */
export async function resumeSession(
	name: string,
	options: ResumeSessionOptions = {},
): Promise<Session> {
	const runtime = options.runtime ?? defaultRuntime;
	assertFree(runtime, name);
	const session = SessionImpl.resume(name, runtime, options.streamFn);
	runtime.running.set(name, session);
	try {
		await session.started();
	} catch (error) {
		free(runtime, session);
		throw error;
	}
	return session;
}

/** The name comes free, unless another room took it since. */
function free(runtime: Runtime, session: SessionImpl): void {
	if (runtime.running.get(session.name) === session) runtime.running.delete(session.name);
}

function assertFree(runtime: Runtime, name: string): void {
	if (runtime.running.has(name)) {
		throw new Error(`Session '${name}' is already running: stop it before starting it again.`);
	}
}

/** Takes the room down: leases revoked, visits closed, and the handle spent. */
export function stopSession(session: Session): Promise<void> {
	if (!(session instanceof SessionImpl)) {
		throw new Error('stopSession takes a session from startSession.');
	}
	return session.stop();
}

/** Puts a person in a running room. One person is in it once, or not at all. */
export function visitSession(session: Session, human: HumanDefinition): Promise<Visit> {
	if (!(session instanceof SessionImpl)) {
		throw new Error('visitSession takes a session from startSession.');
	}
	return session.visit(human);
}

/** Reads a name and starts nothing. A running name reads through its live room. */
export function readSession(name: string, options: ReadSessionOptions = {}): SessionView {
	const runtime = options.runtime ?? defaultRuntime;
	const live = runtime.running.get(name);
	if (live instanceof SessionImpl) return live;
	return new ReadOnlySession(
		name,
		options.repo ? sessionsOver(options.repo) : runtime.sessions,
		runtime,
	);
}

/** A read needs the journal, the clock and the retry policy: every identity it reports is on the journal. */
class ReadOnlySession implements SessionView {
	private readonly journal: RoomJournal;

	constructor(
		readonly name: string,
		sessions: SessionOpener,
		private readonly runtime: Runtime,
	) {
		this.journal = new RoomJournal(sessions.open(name));
	}

	async messages(options: { since?: Seq } = {}): Promise<Message[]> {
		await this.journal.ready;
		return this.journal.since(options.since);
	}

	/** The roster the journal folds, and everybody the record knows. Nothing stands up. */
	seats(): SeatInfo[] {
		const state = foldRoom(this.journal.entries, this.runtime.retry);
		return seatsOf({ name: this.name, state, live: liveSeats(state, this.runtime.clock.now()) });
	}

	/** Nothing is running, so nothing happens. The listener is never called. */
	subscribe(): () => void {
		return () => {};
	}
}

/** A seat's intent the room refuses, with the reason the model reads. */
class RefusedError extends Error {}

/** Thrown inside the queue when the request the seat sent is answered `stale`. */
class StaleError extends Error {}

const stale = (why: string) => ({ stale: why });

/** The reasons that end an activation before it starts. */
const WRITES_OFF: ReadonlySet<EndReason> = new Set(['revoked', 'abandoned']);

/** How many times one pass folds, decides and writes before it yields. */
const PASSES = 8;

// -- the room ----------------------------------------------------------------

class SessionImpl implements Session, RunningRoom {
	readonly name: string;
	readonly stream: StreamFn;
	readonly model: ModelResolver;
	readonly sessions: SessionOpener;
	private readonly runtime: Runtime;
	/** How this room reaches a seat: what the runtime holds, or every seat as an actor in this process. */
	private readonly transport: Transport;
	private readonly journal: RoomJournal;
	/** The replay, the composition on the journal, and the first reconcile. Every operation waits here. */
	private readonly ready: Promise<void>;
	/** Every definition this room can seat, by name. */
	private readonly defs = new Map<string, AgentDefinition>();
	/** The row this run writes about itself, or nothing for a resumed run. Before the replay, `seats()` folds this row alone. */
	private readonly starting: Without<Composition, 'after'> | undefined;
	/** The handles the host delivers through. Presence itself is a fold over the journal. */
	private readonly visits = new Map<string, VisitRuntime>();
	private readonly ports = new Map<string, SeatPort>();
	private readonly listeners = new Set<(event: SessionEvent) => void>();
	private readonly settledWaiters: (() => void)[] = [];
	private readonly quietWaiters: (() => void)[] = [];
	/** When this room last sent each wake. A cache: a resumed room sends every pending wake again. */
	private readonly sentAt = new Map<string, number>();
	/** Every lease id this room has heard a row for. It says `activation_start` once. */
	private readonly heardLeases = new Set<string>();
	private cancelAlarm: () => void = () => {};
	/** The reconcile in flight: the rows it writes, and whoever it wakes. A caller that asks waits for it. */
	private reconciling: Promise<void> = Promise.resolve();
	private fold: { length: number; state: RoomState } | undefined;
	/** The record is replayed and the composition is on the journal: a seat's call is answered on the spot. */
	private replayed = false;
	private stopped = false;
	private evicted = false;
	/** This run's id: the first row it writes, and the stamp on every entry it writes. */
	private readonly run = crypto.randomUUID();
	/** Whether the room has reported quiet since it was last busy. */
	private idleReported = true;

	static start(options: StartSessionOptions, runtime: Runtime): SessionImpl {
		return new SessionImpl(options.name, runtime, options, composeFrom(options));
	}

	static resume(name: string, runtime: Runtime, streamFn: StreamFn | undefined): SessionImpl {
		return new SessionImpl(name, runtime, { streamFn }, undefined);
	}

	private constructor(
		name: string,
		runtime: Runtime,
		options: { repo?: SessionRepo; streamFn?: StreamFn },
		composition: Cast | undefined,
	) {
		this.name = name;
		this.runtime = runtime;
		this.transport = runtime.transport ?? inProcessTransport();
		this.sessions = options.repo ? sessionsOver(options.repo) : runtime.sessions;
		this.journal = new RoomJournal(
			this.sessions.open(name),
			(entry) => this.hear(entry),
			this.run,
			() => this.superseded(),
		);
		this.stream = options.streamFn ?? runtime.stream;
		this.model = options.streamFn ? stubModel : runtime.model;
		this.starting = composition && compositionRow(composition, this.iso());
		if (composition) {
			this.know(...composition.agents, ...composition.available, {
				def: composition.assistant,
				attention: 'none',
			});
		}
		this.ready = this.starting ? this.compose(this.starting) : this.recover();
		void this.ready.catch(() => {});
	}

	/** Resolves once the room is up. `resumeSession` waits for it; every operation does. */
	started(): Promise<void> {
		return this.ready;
	}

	/** A definition the seat side resolves by name: on this room, and on the runtime's catalog. */
	private know(...placed: Placed[]): void {
		for (const { def } of placed) {
			this.defs.set(def.name, def);
			this.runtime.catalog.set(def.name, def);
		}
	}

	/**
	 * The composition against the record, then on it. A name the record knows
	 * as a person cannot be seated, and the first call that needs the room sees
	 * the refusal. The row is what the roster folds from. The first reconcile
	 * closes an exchange the last run left open once nothing works on it.
	 */
	private async compose(row: Without<Composition, 'after'>): Promise<void> {
		await this.journal.ready;
		this.replayed = true;
		this.seedHeardLeases();
		const people = this.state().people;
		for (const name of this.defs.keys()) {
			if (people.has(name)) {
				throw new Error(`Duplicate agent name '${name}': one name names one participant.`);
			}
		}
		await this.journal.write('run', { run: this.run, at: this.iso() });
		await this.journal.write('composition', row);
		this.wake();
		await this.reconcile();
	}

	/** The composition off the journal, and every name on it through the catalog. */
	private async recover(): Promise<void> {
		await this.journal.ready;
		this.replayed = true;
		this.seedHeardLeases();
		const state = this.state();
		if (state.composition === undefined) {
			throw new Error(`Session '${this.name}' has no composition on its record: start it instead.`);
		}
		const names = [
			state.composition.assistant.name,
			...state.roster.map((seat) => seat.name),
			...state.composition.available.map((seat) => seat.name),
		];
		for (const name of names) {
			const def = this.runtime.catalog.get(name);
			if (def === undefined) throw new Error(`'${name}' is not in the runtime's catalog.`);
			this.defs.set(name, def);
		}
		// The run row is the fence: from here on, every earlier run's later writes are void.
		await this.journal.write('run', { run: this.run, at: this.iso() });
		this.wake();
		await this.reconcile();
	}

	/**
	 * Another run took the name. This run says so once, then drops itself
	 * from memory: nothing it does from here on writes, and every seat it
	 * runs hears stale. The record is the other run's from its row on.
	 */
	private superseded(): void {
		if (this.evicted) return;
		this.emit({ type: 'superseded' });
		// This run alone: the runtime may hold a newer room under the name by now.
		if (this.runtime.running.get(this.name) === this) this.runtime.running.delete(this.name);
		this.evict();
	}

	/** A room with an exchange open or a lease live is busy, and says so when it goes quiet. */
	private wake(): void {
		const state = this.state();
		if (state.exchange !== undefined || this.live(state).size > 0) this.idleReported = false;
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
	private state(): RoomState {
		const length = this.journal.entries.length;
		if (this.fold?.length !== length) {
			this.fold = { length, state: foldRoom(this.journal.entries, this.runtime.retry) };
		}
		return this.fold.state;
	}

	private get assistant(): string {
		return this.state().composition?.assistant.name ?? this.starting?.assistant.name ?? '';
	}

	private gone(): boolean {
		return this.stopped || this.evicted;
	}

	private assertRunning(): void {
		if (this.gone()) throw new Error(`Session '${this.name}' is stopped.`);
	}

	private onRoster(name: string, state = this.state()): boolean {
		return state.roster.some((seat) => seat.name === name);
	}

	// -- what the host reads -----------------------------------------------------

	subscribe(listener: (event: SessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: SessionEvent): void {
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
		return this.journal.since(options.since);
	}

	/** The roster and the people off the fold. Before the replay, the fold is over the row this run writes. */
	seats(): SeatInfo[] {
		if (!this.replayed) {
			const rows = this.starting ? [{ ...this.starting, after: 0 }] : [];
			const state = foldRoom(
				rows.map((body) => ({ kind: 'composition' as const, body, after: 0 })),
				this.runtime.retry,
			);
			return seatsOf({ name: this.name, state, live: new Map() });
		}
		const state = this.state();
		return seatsOf({ name: this.name, state, live: this.live(state) });
	}

	exchange(): Exchange | undefined {
		return this.state().exchange;
	}

	/**
	 * Both answers wait for the room to be up, then for every reconcile in
	 * flight: the first reconcile closes an exchange the last run left open,
	 * and a lease change that lands while one reconcile is awaited chains
	 * the next, so the answer waits for that one too.
	 */
	async settled(): Promise<void> {
		if (this.gone()) return;
		await this.ready;
		await this.stilled();
		// A room that went away while this waited never settles on its own, so nobody waits on it.
		if (this.gone() || !working(this.state(), this.now())) return;
		return new Promise((resolve) => this.settledWaiters.push(resolve));
	}

	async quiet(): Promise<void> {
		// A room that is gone never goes quiet on its own, so nobody waits on it.
		if (this.gone()) return;
		await this.ready;
		await this.stilled();
		if (this.gone() || this.idle()) return;
		return new Promise((resolve) => this.quietWaiters.push(resolve));
	}

	/** Resolves once the reconcile chain stands still: nothing was chained while it was awaited. */
	private async stilled(): Promise<void> {
		let awaited: Promise<void>;
		do {
			awaited = this.reconciling;
			await awaited;
		} while (awaited !== this.reconciling);
	}

	/** Nothing at all is live: no lease held, no wake pending, no draft due. */
	private idle(): boolean {
		return this.live(this.state()).size === 0;
	}

	/** The seats live now: a lease held, a wake pending, or a draft due. */
	private live(state: RoomState): Map<string, string[]> {
		return liveSeats(state, this.now());
	}

	// -- people -----------------------------------------------------------------

	/** Puts a person in the room. A second visit while they are here is the same visit. */
	async visit(human: HumanDefinition): Promise<Visit> {
		this.assertRunning();
		await this.ready;
		this.assertVisitable(human);
		const known = this.visits.get(human.name);
		if (known) return this.handle(known);
		const visit: VisitRuntime = { human, gone: false };
		this.visits.set(human.name, visit);
		// A person the journal holds as present is here already: the last run wrote
		// no `left`, and the host's word is what says otherwise. Nothing commits.
		// An arrival whose confirmation was lost is read back first.
		await this.journal.settled();
		// A room that stopped while this waited seats nobody.
		this.assertRunning();
		if (this.state().people.get(human.name)?.presence !== 'present') {
			try {
				await this.commitPresence({
					kind: 'arrived',
					from: human.name,
					identity: human.identity,
					...(human.preferences === undefined ? {} : { preferences: human.preferences }),
				});
			} catch (error) {
				// An arrival the storage refused is no visit: the next visit writes it again.
				this.visits.delete(human.name);
				throw error;
			}
		}
		return this.handle(visit);
	}

	/** One name names one participant, and a present person keeps one identity. */
	private assertVisitable(human: HumanDefinition): void {
		const state = this.state();
		if (this.defs.has(human.name) || this.onRoster(human.name, state)) {
			throw new Error(
				`'${human.name}' is an agent in this session: one name names one participant.`,
			);
		}
		const known = state.people.get(human.name);
		if (known?.presence === 'present' && known.identity !== human.identity) {
			throw new Error(
				`'${human.name}' is already in this session under a different identity: one name is one person.`,
			);
		}
	}

	private handle(visit: VisitRuntime): Visit {
		const session = this;
		return {
			human: visit.human,
			get since() {
				return session.state().people.get(visit.human.name)?.since;
			},
			async deliver(input) {
				if (visit.gone) throw new Error(`${visit.human.name}'s visit has ended.`);
				session.assertRunning();
				await session.deliverFrom(visit.human.name, input);
			},
			leave() {
				return session.endVisit(visit);
			},
		};
	}

	private async endVisit(visit: VisitRuntime): Promise<void> {
		if (visit.gone) return;
		visit.gone = true;
		this.visits.delete(visit.human.name);
		await this.commitPresence({ kind: 'left', from: visit.human.name });
	}

	private async deliverFrom(
		from: string,
		input: { to?: Participant; text: string; key?: string },
	): Promise<void> {
		const to = input.to?.name;
		const state = this.state();
		const target = state.roster.find((seat) => seat.name === to);
		if (to !== undefined && !state.people.has(to) && target === undefined) {
			throw new Error(`Cannot direct a delivery to '${to}': not in this session.`);
		}
		// A seat at the narrow end wakes for nothing said, so a delivery to it
		// is a message nobody reads. The assistant sits there.
		if (target?.attention === 'none') {
			throw new Error(`Cannot direct a delivery to '${to}': it wakes for nothing said.`);
		}
		await this.commitMessage<SpokenMessage>(input.key ?? crypto.randomUUID(), undefined, () => ({
			kind: 'said',
			at: this.iso(),
			from,
			...(to === undefined ? {} : { to }),
			text: input.text,
		}));
	}

	// -- the roster -------------------------------------------------------------

	/** The host puts an agent on the roster. From the reserve when it is there; from anywhere else too. */
	async seat(seat: AgentSeat): Promise<void> {
		this.assertRunning();
		await this.ready;
		const given = unwrap(seat);
		const state = this.state();
		if (this.onRoster(given.def.name, state) || state.people.has(given.def.name)) {
			throw new Error(`Duplicate agent name '${given.def.name}': one name names one participant.`);
		}
		// A bare definition takes the attention its reserve entry carried.
		const held = state.reserve.find((s) => s.name === given.def.name);
		const attention = isSeatedAgent(seat) ? seat.attention : (held?.attention ?? 'broadcast');
		this.know({ def: given.def, attention });
		await this.commitPresence({
			kind: 'seated',
			from: given.def.name,
			identity: given.def.identity,
			attention,
		});
	}

	/** The host takes an agent off the roster. Never the assistant. */
	async unseat(agent: AgentDefinition): Promise<void> {
		this.assertRunning();
		await this.ready;
		if (!this.onRoster(agent.name))
			throw new Error(`'${agent.name}' is not seated in this session.`);
		if (agent.name === this.assistant) {
			throw new Error(`'${agent.name}' is the assistant: a room cannot run without one.`);
		}
		await this.revoke((seat) => seat === agent.name);
		await this.commitPresence({ kind: 'unseated', from: agent.name });
	}

	// -- commits ----------------------------------------------------------------

	/**
	 * One operation on the room's commit queue: the draft is built where the
	 * write happens, with the wakes the room decides for it. The journal hears
	 * the message inside the same link, so what the room does with it happens
	 * before anything lands on top. A repeated key lands nothing, so the
	 * room does nothing with it either.
	 */
	private commitMessage<T extends Message>(
		key: string,
		readThrough: Seq | undefined,
		draft: (state: RoomState) => Omit<T, 'seq' | 'key' | 'wakes'>,
		route = true,
	): Promise<Committed<T>> {
		return this.journal.commit<T>({
			key,
			...(readThrough === undefined ? {} : { readThrough }),
			draft: () => {
				const state = this.state();
				const message = draft(state);
				const woken = route ? this.routing(message as unknown as Message, state) : [];
				return { ...message, ...(woken.length === 0 ? {} : { wakes: woken }) } as Omit<
					T,
					'seq' | 'key'
				>;
			},
		});
	}

	/** A presence change the room observed, under a fresh key: the room's own word, never a retry. */
	private commitPresence(change: PresenceDraft, route = true) {
		return this.commitMessage<PresenceMessage>(
			crypto.randomUUID(),
			undefined,
			() => ({ ...change, at: this.iso() }),
			route,
		);
	}

	/**
	 * Who wakes for a message — the room's whole policy in one place, and
	 * the same for what a person said, what a person did, and what a
	 * colleague said. An idle seat wakes when the attention it was seated at
	 * reaches the message (rules 1, 4 and 6, in `wakes`). A person's question
	 * that opens an exchange also wakes the assistant, when the reserve holds
	 * anybody and the assistant is idle. A seat at work is not woken: it is
	 * steered once the write is confirmed (rule 2), and the steer is not on
	 * the message.
	 */
	private routing(message: Message, state: RoomState): string[] {
		const author = authorOf(message);
		const target = targetOf(message);
		const assistant = this.assistant;
		const fromAssistant = author === assistant;
		const live = this.live(state);
		// The room changes before the message does: a seating's newcomer is on
		// the roster the routing reads, so the seating wakes it.
		const roster =
			message.kind === 'seated'
				? [...state.roster, { name: message.from, attention: message.attention ?? 'broadcast' }]
				: state.roster;
		const woken = roster
			.filter((seat) => seat.name !== author && !live.has(seat.name))
			.filter((seat) => wakes(seat, target, message, fromAssistant))
			.map((seat) => seat.name);
		if (this.opensExchange(message, state) && state.reserve.length > 0 && !live.has(assistant)) {
			woken.push(assistant);
		}
		return [...new Set(woken)];
	}

	private opensExchange(message: Message, state: RoomState): boolean {
		return state.exchange === undefined && isSpoken(message) && state.people.has(message.from);
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
		if (entry.kind === 'message') this.heardMessage(entry.body);
		else if (entry.kind === 'close') this.heardClose(entry.body);
		else if (entry.kind === 'lease') this.heardLease(entry.body, this.opens(entry.body.id));
	}

	/**
	 * Whether this row starts an activation: the room has heard no earlier row
	 * for the id. The room keeps the set, because the question is the room's:
	 * it says `activation_start` once. The replay seeds it from the fold, so a
	 * resumed room starts no activation the last run already started.
	 */
	private opens(id: string): boolean {
		const first = !this.heardLeases.has(id);
		this.heardLeases.add(id);
		return first;
	}

	/** Every lease id the room has heard a row for, seeded by the replay. */
	private seedHeardLeases(): void {
		for (const id of this.state().leases.keys()) this.heardLeases.add(id);
	}

	/**
	 * A message on the record: the host hears about it, then what it opened,
	 * then the room sends the wakes the message carries and steers every seat
	 * at work. One message, one event, one order.
	 */
	private heardMessage(message: Message): void {
		this.emit({ type: 'message', message });
		this.noteExchange(message.seq);
		for (const seat of message.wakes ?? []) this.send(activationId(message.seq, seat), seat);
		this.steer(message);
		void this.reconcile();
	}

	/**
	 * An exchange ended at the range the close names. The host hears it
	 * before anything is written about it: the assistant is the first reader
	 * of a closed exchange and not the only one. A question that landed
	 * ahead of the close opens the next exchange, and the room says so.
	 */
	private heardClose(close: Close): void {
		const question = this.journal.messages.find((m) => m.seq === close.from);
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
	}

	/**
	 * A lease row: the first row of an id starts an activation, and an end
	 * row ends one. A row that ends a lease the journal never held is a wake
	 * written off, and starts nothing.
	 */
	private heardLease(lease: LeaseChange, first: boolean): void {
		const seat = seatOf(lease.id, this.assistant) ?? '';
		if (lease.phase === 'running') {
			if (first) {
				this.idleReported = false;
				this.emit({ type: 'activation_start', agent: seat });
			}
			// A claim that lost its confirmation never armed the expiry: this pass does.
			void this.reconcile();
			return;
		}
		if (first) {
			// A row that ends a lease the journal never held is an attempt nobody made.
			if (lease.reason === 'abandoned') {
				this.emit({ type: 'abandoned', agent: seat, activation: lease.id });
				void this.reconcile();
			}
			return;
		}
		const spoke = this.journal.messages.some((m) => m.activationId === lease.id);
		this.emit({ type: 'activation_end', agent: seat, spoke });
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
		this.idleReported = false;
		this.emit({ type: 'exchange_opened', exchange: state.exchange });
	}

	/**
	 * Every seat at work hears the message as a steer (rule 2), except its
	 * author and the assistant while it composes: a composing activation
	 * decides on the question as it was asked, and what the seats say while
	 * it decides is theirs to say. The steer is the room's word to a running
	 * activation, and the lease does not record it.
	 */
	private steer(message: Message): void {
		const author = authorOf(message);
		const state = this.state();
		for (const [seat, ids] of this.live(state)) {
			if (seat === author || !this.holds(state, ids)) continue;
			if (seat === this.assistant && ids.some((id) => parseId(id)?.kind === 'wake')) continue;
			this.send(activationId(message.seq, seat), seat, {
				seq: message.seq,
				line: renderLine(message),
			});
		}
	}

	/** Whether any of these ids is a lease held now: a seat with a wake pending is live and at rest. */
	private holds(state: RoomState, ids: string[]): boolean {
		const now = this.now();
		return ids.some((id) => {
			const lease = state.leases.get(id);
			return lease !== undefined && isLive(lease, now);
		});
	}

	/** One wake over the wire. A wake a message caused carries the line a running activation is steered with. */
	private send(id: string, seat: string, steer?: { seq: Seq; line: string }): void {
		if (steer === undefined) this.sentAt.set(id, this.now());
		void this.port(seat)
			.wake({ room: this.name, seat, activation: id, ...(steer === undefined ? {} : { steer }) })
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

	async view(id: string): Promise<ViewResponse> {
		if (this.gone()) return stale('the room is gone');
		await this.ready;
		const state = this.state();
		const seat = this.liveSeatOf(id, state);
		if (seat === undefined) return stale('the lease ended');
		const def = this.defs.get(seat);
		if (def === undefined) return stale('the seat left the roster');
		return { view: viewOf(id, seat, def, this.facts(state)) };
	}

	/** What a view is built from: the fold, and what the room holds beside it. */
	private facts(state: RoomState): RoomFacts {
		return {
			name: this.name,
			now: this.now(),
			assistant: this.assistant,
			state,
			live: this.live(state),
			unseen: (since) => this.journal.since(since).length,
		};
	}

	/** The seat holding a live lease under this id, or nothing. */
	private liveSeatOf(id: string, state: RoomState): string | undefined {
		const lease = state.leases.get(id);
		if (lease === undefined || !isLive(lease, this.now())) return undefined;
		const seat = seatOf(id, this.assistant);
		return seat !== undefined && this.onRoster(seat, state) ? seat : undefined;
	}

	/**
	 * Rule 5 for a say and for a summary: commit under `readThrough`, the seq
	 * the author has read. The queue refuses a commit the record moved past,
	 * and the loser is handed what it missed. The event names the author, not
	 * the seat: a say and a summary are refused the same way. A seating
	 * commits under no `readThrough`: it is decided on the question, whatever
	 * landed since. A lease that ended is answered `stale`, before and where
	 * the write happens.
	 */
	async commit(commit: Commit): Promise<CommitResponse> {
		if (this.gone()) return stale('the room is gone');
		await this.ready;
		const seat = this.liveSeatOf(commit.activation, this.state());
		if (seat === undefined) return stale('the lease ended');
		// Rule 5 comes first: a seat that has not read the record is told what
		// it missed before anything else is checked, so a say at a colleague
		// who left in the meantime reads the departure. The queue runs the same
		// check again where the write happens.
		const missed = this.unheard(commit.readThrough);
		if (missed !== undefined) {
			this.emit({ type: 'conflict', author: seat, missed });
			return { missed };
		}
		try {
			const committed = await this.commitMessage<Message>(
				commit.key,
				commit.readThrough,
				(state) => {
					if (this.liveSeatOf(commit.activation, state) === undefined) {
						throw new StaleError('the lease ended');
					}
					return this.draft(commit, seat, state);
				},
			);
			if ('missed' in committed) {
				const missed = [...committed.missed];
				this.emit({ type: 'conflict', author: seat, missed });
				return { missed };
			}
			return { committed: committed.body };
		} catch (error) {
			if (error instanceof StaleError) return stale(error.message);
			if (error instanceof RefusedError) return { refused: error.message };
			throw error;
		}
	}

	/** What the record holds past what the author read, or nothing when it read everything. */
	private unheard(readThrough: Seq | undefined): Message[] | undefined {
		if (readThrough === undefined || this.journal.lastSeq <= readThrough) return undefined;
		return this.journal.since(readThrough);
	}

	/** The message a seat's intent becomes, with everything the room stamps. */
	private draft(commit: Commit, seat: string, state: RoomState): Drafted {
		const intent = commit.intent;
		const stamp = { at: this.iso(), activationId: commit.activation };
		if (intent.kind === 'said') {
			assertAddressable(seat, intent.to, state);
			return {
				kind: 'said',
				...stamp,
				from: seat,
				...(intent.to === undefined ? {} : { to: intent.to }),
				text: intent.text,
			};
		}
		if (intent.kind === 'summary') {
			return {
				kind: 'summary',
				...stamp,
				from: seat,
				to: intent.to,
				text: intent.text,
				covers: intent.covers,
			};
		}
		const held = state.reserve.find((s) => s.name === intent.name);
		if (held === undefined) {
			const names = state.reserve.map((s) => s.name);
			throw new RefusedError(
				`'${intent.name}' is not in the reserve. ` +
					(names.length ? `Seat one of: ${names.join(', ')}.` : 'The reserve is empty.'),
			);
		}
		// The roster folds the seating where it lands, before it routes: every
		// seat the seating reaches reads a roster that already agrees with it.
		return {
			kind: 'seated',
			...stamp,
			from: held.name,
			identity: held.identity,
			by: seat,
			attention: held.attention,
		};
	}

	/**
	 * A claim, a renewal or a release. A claim or a renewal needs the seat
	 * on the roster; a release is answered from the fold, whatever the room's
	 * state, and the room hears how the activation went.
	 */
	async lease(lease: Lease): Promise<LeaseResponse> {
		if (this.gone()) return stale('the room is gone');
		await this.ready;
		const seat = seatOf(lease.activation, this.assistant);
		if (seat === undefined || !this.onRoster(seat)) return stale('the seat is not on the roster');
		return lease.phase === 'running' ? this.claim(lease.activation) : this.release(lease);
	}

	/**
	 * A claim, or a renewal: the lease runs until `expiry`, unless it had
	 * ended. A fresh claim is taken only for an activation the fold says is
	 * due: the next attempt at a pending wake, or at an owed draft. Anything
	 * else was answered already, and a second run of it would answer twice.
	 * The clock is read where the row is written: a renewal that waited on
	 * the queue is judged against the lease as it stands then. No lease runs
	 * past the deadline: the expiry a claim or a renewal takes is capped
	 * there, so an activation that runs on expires on the room's alarm.
	 */
	private async claim(id: string): Promise<LeaseResponse> {
		let expiry = 0;
		const written = await this.journal.write('lease', () => {
			const state = this.state();
			const known = state.leases.get(id);
			const now = this.now();
			if (known === undefined && (this.stopped || !this.due(state).has(id))) return undefined;
			if (known !== undefined && !isLive(known, now)) return undefined;
			const claimedAt = known === undefined ? now : Date.parse(known.claimedAt);
			expiry = Math.min(now + this.runtime.wake.expiry, claimedAt + this.runtime.wake.deadline);
			return { id, phase: 'running', expiry, at: this.iso() };
		});
		if (!written) return stale('the lease ended');
		return { ok: { expiry, lastSeq: this.journal.lastSeq } };
	}

	/** The ids the fold says may claim a fresh lease now. */
	private due(state: RoomState): Set<string> {
		return new Set(state.due.map((owed) => owed.id));
	}

	private async release(lease: Lease): Promise<LeaseResponse> {
		const ended = await this.end(lease.activation, lease.reason ?? 'released');
		if (!ended) return stale('the lease ended');
		void this.reconcile();
		return { ok: { expiry: this.now(), lastSeq: this.journal.lastSeq } };
	}

	/**
	 * End one lease, for whatever reason. Nothing to end is not an error. A
	 * revocation may name an activation that never claimed: the row ends it
	 * before it starts, and the wake or the draft it stood for is answered.
	 * An abandonment names an activation that never claimed and nothing else:
	 * a lease that started ends how it went.
	 * An expiry is judged where the row is written: a renewal that landed
	 * ahead of it keeps the lease, and the row is not written. The row says
	 * how the activation went, and `heardLease` says so once.
	 */
	private end(id: string, reason: EndReason): Promise<boolean> {
		return this.journal.write('lease', () => {
			const known = this.state().leases.get(id);
			if (!this.ends(known, reason)) return undefined;
			return { id, phase: 'ended', reason, at: this.iso() };
		});
	}

	/**
	 * Whether the row lands. A lease the journal never held takes a row that
	 * writes an activation off. A lease that already ended takes no second
	 * row, and neither takes an abandonment. An expiry is judged here: a
	 * renewal that landed ahead of it keeps the lease, and every other
	 * reason needs a lease that still holds.
	 */
	private ends(known: LeaseState | undefined, reason: EndReason): boolean {
		if (known === undefined) return WRITES_OFF.has(reason);
		if (known.phase === 'ended' || reason === 'abandoned') return false;
		return isExpired(known, this.now()) === (reason === 'expired');
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
			this.forget(this.state());
			const decision = decide(this.state(), {
				now: this.now(),
				resend: this.runtime.wake.resend,
				attempts: this.runtime.retry.attempts,
				sentAt: (id) => this.sentAt.get(id),
				stopped: this.stopped,
			});
			let changed: boolean;
			try {
				changed = await this.apply(decision);
			} catch {
				this.settle();
				// A write that failed because the room is gone arms nothing.
				if (!this.gone()) this.arm(this.now() + this.runtime.wake.resend);
				return;
			}
			// Whoever waits hears it once the room has nothing more to write: a
			// pass that expired a lease is followed by the pass that closes.
			if (!changed) {
				await this.checkpoint();
				this.settle();
				this.arm(decision.alarmAt);
				return;
			}
		}
		// A pass that kept writing yields, and the room looks again after the resend window.
		if (!this.gone()) this.arm(this.now() + this.runtime.wake.resend);
	}

	/** A wake the fold no longer says is due is not one this room waits on. */
	private forget(state: RoomState): void {
		const due = this.due(state);
		for (const id of this.sentAt.keys()) {
			if (!due.has(id)) this.sentAt.delete(id);
		}
	}

	/** Write what the decision wrote, send what it sent. True when anything changed. */
	private async apply(decision: Decision): Promise<boolean> {
		let changed = false;
		// The decision says how each lease ends: expired first, then given up on.
		for (const row of [...decision.expired, ...decision.abandoned]) {
			// A room that went away mid-pass writes nothing more of what it decided.
			if (this.gone()) return changed;
			changed = (await this.end(row.id, row.reason)) || changed;
		}
		if (decision.close && !this.gone()) changed = (await this.close(decision.close)) || changed;
		for (const send of decision.sends) this.send(send.id, send.seat);
		return changed || decision.sends.length > 0;
	}

	/**
	 * The room went quiet on an exchange, so that exchange ends at the record
	 * as the decision saw it: the close is a row on the journal, written where the
	 * fold still says the same exchange is open. `heardClose` says so, and
	 * opens the next exchange when a question landed after the decision; the
	 * next pass closes that one at once when nobody works on it.
	 */
	private close(close: NonNullable<Decision['close']>): Promise<boolean> {
		return this.journal.write('close', () => {
			if (this.state().exchange?.from !== close.from || this.stopped) return undefined;
			return close;
		});
	}

	/**
	 * Whoever waited on the seats stopping, or on the room going quiet, hears
	 * it. The room says `quiet` once per stretch of work: nothing is live, and
	 * it has not said so since it was last busy. A stopped room never says it.
	 */
	private settle(): void {
		const state = this.state();
		if (!working(state, this.now())) {
			for (const resolve of this.settledWaiters.splice(0)) resolve();
		}
		if (!this.idle()) return;
		if (!this.idleReported && !this.gone()) {
			this.idleReported = true;
			this.emit({ type: 'quiet' });
		}
		for (const resolve of this.quietWaiters.splice(0)) resolve();
	}

	/**
	 * A checkpoint when the journal has taken enough rows since the last one.
	 * The room writes it where it has nothing else to write, so the row
	 * stands for a room at rest, and a fold that reads it starts there.
	 *
	 * The row is built where it lands, like every other row: a row that
	 * landed between the decision and the write is in the fold the
	 * checkpoint carries, and the journal drops it as one the checkpoint
	 * replaced. A write that fails leaves the rows where they are, and the
	 * next pass tries again.
	 */
	private async checkpoint(): Promise<void> {
		// Nothing joins the queue until the rows are there: the room settles at
		// the speed it always did, and the builder checks the count again.
		if (this.gone() || this.journal.sinceCheckpoint < this.runtime.checkpoint.rows) return;
		await this.journal
			.write('checkpoint', () => {
				if (this.journal.sinceCheckpoint < this.runtime.checkpoint.rows) return undefined;
				return checkpointOf(this.state(), this.now());
			})
			.catch(() => {});
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
		if (this.evicted) return;
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
		for (const id of ids) await this.end(id, 'revoked');
		const port = this.port(seat);
		for (const id of ids) void port.cut(id).catch(() => {});
	}

	/** Closes the run: what is live is revoked, what is present is marked gone, and the name comes free. */
	async stop(): Promise<void> {
		if (this.stopped) return;
		// Stopped from here on: a visit that arrives during the shutdown is
		// refused rather than seated into a room that is going away.
		this.stopped = true;
		this.cancelAlarm();
		try {
			// A room dropped from memory writes nothing: the next run over the journal takes it up.
			if (this.evicted) return;
			await this.ready;
			await this.revoke(() => true);
			// A write queued ahead of the stop lands first, so the record says who was present.
			await this.journal.settled();
			await this.leaveEverybody();
		} catch (error) {
			// A stop that found another run's fence has nothing left to write: the
			// run said `superseded`, and the name is the other run's.
			if (!this.evicted) throw error;
		} finally {
			// The name comes free whatever the storage did. A failed write must
			// not leave a room that can never be started again.
			if (this.runtime.running.get(this.name) === this) this.runtime.running.delete(this.name);
			// A stopped room never goes quiet on its own, so nobody waits on it.
			for (const resolve of this.quietWaiters.splice(0)) resolve();
			for (const resolve of this.settledWaiters.splice(0)) resolve();
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
			await this.commitPresence({ kind: 'left', from: person.name }, false);
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
		this.evicted = true;
		this.journal.close();
		this.cancelAlarm();
		this.listeners.clear();
		for (const visit of this.visits.values()) visit.gone = true;
		for (const resolve of this.quietWaiters.splice(0)) resolve();
		for (const resolve of this.settledWaiters.splice(0)) resolve();
	}
}

/** The composition `startSession` was given, checked for duplicates the way the room refuses them. */
function composeFrom(options: StartSessionOptions): Cast {
	const assistant = assertAssistant(options.assistant);
	const names = new Set<string>();
	const take = (placed: Placed): Placed => {
		if (names.has(placed.def.name)) {
			throw new Error(`Duplicate agent name '${placed.def.name}': one name names one participant.`);
		}
		names.add(placed.def.name);
		return placed;
	};
	const agents = (options.agents ?? []).map((seat) => take(unwrap(seat)));
	take({ def: assistant, attention: 'none' });
	const available = (options.available ?? []).map((seat) => take(unwrap(seat)));
	return { assistant, goal: options.goal?.trim() || undefined, agents, available };
}

function unwrap(seat: AgentSeat): Placed {
	const def = isSeatedAgent(seat) ? seat.agent : seat;
	if (!isAgent(def)) throw new Error('Agents must come from defineAgent or seated().');
	return { def, attention: isSeatedAgent(seat) ? seat.attention : 'broadcast' };
}

const seatRow = (placed: Placed): Seating => ({
	name: placed.def.name,
	identity: placed.def.identity,
	attention: placed.attention,
});

/** The composition as the row the journal holds: every seat by name, identity and attention. */
function compositionRow(composition: Cast, at: string): Without<Composition, 'after'> {
	return {
		assistant: seatRow({ def: composition.assistant, attention: 'none' }),
		...(composition.goal === undefined ? {} : { goal: composition.goal }),
		agents: composition.agents.map(seatRow),
		available: composition.available.map(seatRow),
		at,
	};
}

/** The seat a message names: a directed say names who it addresses, a seating names who it seats. */
function targetOf(message: Message): string | undefined {
	if (isSpoken(message)) return message.to;
	return message.kind === 'seated' ? message.from : undefined;
}

function assertAddressable(seat: string, to: string | undefined, state: RoomState): void {
	if (to === undefined) return;
	const target = state.roster.find((s) => s.name === to);
	if (!state.people.has(to) && target === undefined) {
		throw new RefusedError(`Unknown participant '${to}'. Address someone from the roster.`);
	}
	if (to === seat) throw new RefusedError('You cannot address yourself.');
	// A seat at the narrow end wakes for nothing said, so addressing it
	// would leave a message nobody reads. Say it to the room instead.
	if (target?.attention === 'none') {
		throw new RefusedError(
			`'${to}' wakes for nothing said. Say it to the room, or to somebody else.`,
		);
	}
}
