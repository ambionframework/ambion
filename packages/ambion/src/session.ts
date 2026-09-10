/**
 * The room: the one place where a log, the seats around it, the people
 * visiting it and the exchanges they open become behaviour.
 *
 * The room is one operation and one step. `commit` appends one entry to the
 * log under a serial queue, then emits and sends. `reconcile` folds the log,
 * decides, writes what it decided, and sends; it runs after every commit,
 * every lease change, every alarm and every wake, and running it twice
 * writes nothing. Every fact about the room is a fold over the log
 * (`fold.ts`), so a room that resumes over the log continues where the last
 * run stopped.
 *
 * What is left here is what only a room can do:
 *
 * - **Compose.** Write the composition, admit the people, seat and unseat
 *   while it runs, and take it all down again.
 * - **Commit.** One queue, one seq at a time, for every author (rule 5), and
 *   one `message` event per message however it was written.
 * - **Route.** Who hears a message, and who wakes for it, written with it.
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
import { type Committed, type LogEntry, RoomLog } from './log/log.ts';
import { renderLine } from './render.ts';
import { assertAssistant } from './room/assistant.ts';
import { checkpointOf, foldRoom, type RoomState } from './room/fold.ts';
import { activationId, draftId, isExpired, isLive, parseId, seatOf } from './room/lease.ts';
import type { VisitRuntime } from './room/presence.ts';
import { decide, liveSeats, working } from './room/reconcile.ts';
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
	Commit,
	CommitResponse,
	EndReason,
	Lease,
	LeaseResponse,
	LeaseRow,
	SeatPort,
	SeatRow,
	ViewResponse,
} from './wire.ts';

/** An agent with the attention it takes when seated. */
interface Placed {
	def: AgentDefinition;
	attention: Attention;
}

/** What a run starts with, as values. The row on the log is the same, by name. */
interface Composition {
	assistant: AgentDefinition;
	goal: string | undefined;
	agents: Placed[];
	available: Placed[];
}

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
	/** The question the room is working on, or nothing when nobody has asked. A fold over the log. */
	exchange(): Exchange | undefined;
	/** Resolves when no seat that speaks for itself is live and the assistant is not composing. */
	settled(): Promise<void>;
	/**
	 * Resolves when nothing at all is live: no lease held, no wake pending.
	 * `settled()` reports the seats alone, which is what rule 5 needs it to
	 * mean; this is what a host waits for when it wants the one message a
	 * person reads.
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
	// with the refusal, and nothing runs under it.
	session.started().catch(() => free(runtime, session));
	return session;
}

/**
 * Brings a name back up over its log, with the composition the log holds.
 * Every name on the roster resolves through the runtime's catalog, and the
 * first one missing is the error. The room reconciles at once: a lease the
 * last run left expires, a wake it left pending is sent again, and an
 * exchange it left open closes.
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

class ReadOnlySession implements SessionView {
	private readonly log: RoomLog;

	constructor(
		readonly name: string,
		sessions: SessionOpener,
		private readonly runtime: Runtime,
	) {
		this.log = new RoomLog(sessions.open(name));
	}

	async messages(options: { since?: Seq } = {}): Promise<Message[]> {
		await this.log.ready;
		return this.log.since(options.since);
	}

	/** The roster the log folds, and everybody the record knows. Nothing stands up. */
	seats(): SeatInfo[] {
		const state = foldRoom(this.log.entries, this.runtime.retry);
		return seatsOf({
			name: this.name,
			state,
			live: liveSeats(state, this.runtime.clock.now()),
		});
	}

	/** Nothing is running, so nothing happens. The listener is never called. */
	subscribe(): () => void {
		return () => {};
	}
}

/** Thrown inside the queue when the request the seat sent is answered `stale`. */
class StaleError extends Error {}

const stale = (why: string) => ({ stale: why });

// -- the room ----------------------------------------------------------------

class SessionImpl implements Session, RunningRoom {
	readonly name: string;
	readonly stream: StreamFn;
	readonly model: ModelResolver;
	readonly sessions: SessionOpener;
	private readonly runtime: Runtime;
	/** How this room reaches a seat: what the runtime holds, or every seat as an actor in this process. */
	private readonly transport: Transport;
	private readonly log: RoomLog;
	/** The replay, the composition on the log, and the first reconcile. Every operation waits here. */
	private readonly ready: Promise<void>;
	/** Every definition this room can seat, by name. */
	private readonly defs = new Map<string, AgentDefinition>();
	/** What `seats()` reports before the replay: the composition the room was started with. */
	private readonly starting: SeatInfo[];
	/** The handles the host delivers through. Presence itself is a fold over the log. */
	private readonly visits = new Map<string, VisitRuntime>();
	private readonly ports = new Map<string, SeatPort>();
	private readonly listeners = new Set<(event: SessionEvent) => void>();
	private readonly settledWaiters: (() => void)[] = [];
	private readonly quietWaiters: (() => void)[] = [];
	/** When this room last sent each wake. A cache: a resumed room sends every pending wake again. */
	private readonly sentAt = new Map<string, number>();
	private cancelAlarm: () => void = () => {};
	private reconciling: Promise<void> = Promise.resolve();
	private fold: { length: number; state: RoomState } | undefined;
	private replayed = false;
	private stopped = false;
	private evicted = false;
	/** Whether the room has reported quiet since it was last busy. */
	private idleReported = true;

	static start(options: StartSessionOptions, runtime: Runtime): SessionImpl {
		const composition = composeFrom(options);
		return new SessionImpl(options.name, runtime, options, composition);
	}

	static resume(name: string, runtime: Runtime, streamFn: StreamFn | undefined): SessionImpl {
		return new SessionImpl(name, runtime, { streamFn }, undefined);
	}

	private constructor(
		name: string,
		runtime: Runtime,
		options: { repo?: SessionRepo; streamFn?: StreamFn },
		composition: Composition | undefined,
	) {
		this.name = name;
		this.runtime = runtime;
		this.transport = runtime.transport ?? inProcessTransport();
		this.sessions = options.repo ? sessionsOver(options.repo) : runtime.sessions;
		this.log = new RoomLog(this.sessions.open(name), (entry, fresh) => this.heard(entry, fresh));
		this.stream = options.streamFn ?? runtime.stream;
		this.model = options.streamFn ? stubModel : runtime.model;
		this.starting = composition ? startingSeats(composition, name) : [];
		if (composition)
			this.know(...composition.agents, ...composition.available, {
				def: composition.assistant,
				attention: 'none',
			});
		this.ready = composition ? this.compose(composition) : this.recover();
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
	 * the refusal. The row is what the roster folds from.
	 */
	private async compose(composition: Composition): Promise<void> {
		await this.log.ready;
		this.replayed = true;
		const people = this.state().people;
		for (const name of this.defs.keys()) {
			if (people.has(name)) {
				throw new Error(`Duplicate agent name '${name}': one name names one participant.`);
			}
		}
		await this.log.write('composition', {
			assistant: seatRow({ def: composition.assistant, attention: 'none' }),
			...(composition.goal === undefined ? {} : { goal: composition.goal }),
			agents: composition.agents.map(seatRow),
			available: composition.available.map(seatRow),
			at: this.iso(),
		});
		this.wake();
		await this.reconcile();
	}

	/** The composition off the log, and every name on it through the catalog. */
	private async recover(): Promise<void> {
		await this.log.ready;
		this.replayed = true;
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
		this.wake();
		await this.reconcile();
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

	private iso(): string {
		return new Date(this.now()).toISOString();
	}

	/** Every fact about the room, folded over the log as it stands. */
	private state(): RoomState {
		const length = this.log.entries.length;
		if (this.fold?.length !== length) {
			this.fold = { length, state: foldRoom(this.log.entries, this.runtime.retry) };
		}
		return this.fold.state;
	}

	private get assistant(): string {
		return (
			this.state().composition?.assistant.name ??
			this.starting.find((s) => s.kind === 'agent' && s.assistant)?.name ??
			''
		);
	}

	private gone(): boolean {
		return this.stopped || this.evicted;
	}

	private assertRunning(): void {
		if (this.gone()) throw new Error(`Session '${this.name}' is stopped.`);
	}

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

	async messages(options: { since?: Seq } = {}): Promise<Message[]> {
		await this.ready;
		await this.log.settled();
		return this.log.since(options.since);
	}

	seats(): SeatInfo[] {
		if (!this.replayed) return this.starting;
		const state = this.state();
		return seatsOf({
			name: this.name,
			state,
			live: this.live(state),
		});
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
		// A room that is gone never settles on its own, so nobody waits on it.
		if (this.gone()) return;
		await this.ready;
		await this.stilled();
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

	/** Nothing at all is live: no lease held, no wake pending, no wake sent and unanswered. */
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
		// A person the log holds as present is here already: a crash wrote no
		// `left`, and the host's word is what says otherwise. Nothing commits.
		if (this.state().people.get(human.name)?.presence !== 'present') {
			try {
				await this.commitMessage<PresenceMessage>(crypto.randomUUID(), undefined, () => ({
					kind: 'arrived',
					at: this.iso(),
					from: human.name,
					identity: human.identity,
					...(human.preferences === undefined ? {} : { preferences: human.preferences }),
				}));
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
		if (this.defs.has(human.name) || state.roster.some((seat) => seat.name === human.name)) {
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
		await this.commitMessage<PresenceMessage>(crypto.randomUUID(), undefined, () => ({
			kind: 'left',
			at: this.iso(),
			from: visit.human.name,
		}));
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
		// A seat at the narrow end wakes for nothing said: a delivery to it is
		// a message nobody reads. The assistant sits there.
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
		if (state.roster.some((s) => s.name === given.def.name) || state.people.has(given.def.name)) {
			throw new Error(`Duplicate agent name '${given.def.name}': one name names one participant.`);
		}
		// A bare definition takes the attention its reserve entry carried.
		const held = state.reserve.find((s) => s.name === given.def.name);
		const attention = isSeatedAgent(seat) ? seat.attention : (held?.attention ?? 'broadcast');
		this.know({ def: given.def, attention });
		await this.commitMessage<PresenceMessage>(crypto.randomUUID(), undefined, () => ({
			kind: 'seated',
			at: this.iso(),
			from: given.def.name,
			identity: given.def.identity,
			attention,
		}));
	}

	/** The host takes an agent off the roster. Never the assistant. */
	async unseat(agent: AgentDefinition): Promise<void> {
		this.assertRunning();
		await this.ready;
		if (!this.state().roster.some((seat) => seat.name === agent.name)) {
			throw new Error(`'${agent.name}' is not seated in this session.`);
		}
		if (agent.name === this.assistant) {
			throw new Error(`'${agent.name}' is the assistant: a room cannot run without one.`);
		}
		await this.revoke((seat) => seat === agent.name);
		await this.commitMessage<PresenceMessage>(crypto.randomUUID(), undefined, () => ({
			kind: 'unseated',
			at: this.iso(),
			from: agent.name,
		}));
	}

	// -- commits ----------------------------------------------------------------

	/**
	 * One operation on the room's commit queue: the draft is built where the
	 * write happens, with the wakes the room decides for it, and what the room
	 * does with a fresh message runs inside the same link of the queue.
	 */
	private commitMessage<T extends Message>(
		key: string,
		readThrough: Seq | undefined,
		draft: (state: RoomState) => Omit<T, 'seq' | 'key' | 'wakes'>,
		route = true,
	): Promise<Committed<T>> {
		return this.log.commit<T>(
			{
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
			},
			(message) => this.committed(message),
		);
	}

	/**
	 * Who hears a message — the room's whole policy in one place, and the
	 * same for what a person said, what a person did, and what a colleague
	 * said. An idle seat hears it when the attention it was seated at reaches
	 * the message (rules 1, 4 and 6, in `wakes`); a seat already at work
	 * hears everything (rule 2), except the assistant while it composes. A
	 * person's question that opens an exchange also wakes the assistant, when
	 * the reserve holds anybody. The seat side decides what hearing means:
	 * a fresh activation, or a steer into the one that runs.
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
				? [
						...state.roster,
						{
							name: message.from,
							identity: message.identity ?? '',
							attention: message.attention ?? 'broadcast',
							assistant: false,
						},
					]
				: state.roster;
		const atWork = this.atWork(state, live);
		const woken = roster
			.filter((seat) => seat.name !== author)
			.filter((seat) => wakes(seat, target, message, fromAssistant) || atWork.has(seat.name))
			.map((seat) => seat.name);
		if (this.opensExchange(message, state) && state.reserve.length > 0 && !live.has(assistant)) {
			woken.push(assistant);
		}
		return [...new Set(woken)];
	}

	/**
	 * The seats holding a live lease, which hear every message. The assistant
	 * does not: a composing activation decides on the question as it was
	 * asked, and what the seats say while it decides is theirs to say; a
	 * drafting activation learns what landed from the refusal of its draft,
	 * which carries it.
	 */
	private atWork(state: RoomState, live: ReadonlyMap<string, string[]>): Set<string> {
		const now = this.now();
		const holds = (id: string) => {
			const lease = state.leases.get(id);
			return lease !== undefined && isLive(lease, now);
		};
		const atWork = new Set<string>();
		for (const [seat, ids] of live) {
			if (seat !== this.assistant && ids.some(holds)) atWork.add(seat);
		}
		return atWork;
	}

	private opensExchange(message: Message, state: RoomState): boolean {
		return state.exchange === undefined && isSpoken(message) && state.people.has(message.from);
	}

	/**
	 * What happens to every message once its write is confirmed: the host
	 * hears about it, then what it opened, then the room sends. One message,
	 * one event, one order — stated here rather than at each of the commit sites.
	 */
	private committed(message: Message): void {
		this.emit({ type: 'message', message });
		const state = this.state();
		if (state.exchange?.from === message.seq) {
			this.idleReported = false;
			this.emit({ type: 'exchange_opened', exchange: state.exchange });
		}
		for (const seat of message.wakes ?? []) this.send(activationId(message.seq, seat), seat);
		void this.reconcile();
	}

	/**
	 * An entry the log found on a read in doubt: it landed, and this room
	 * never heard. The room acts on it as on a write it confirmed: the host
	 * hears the event, and a message is routed.
	 */
	private heard(entry: LogEntry, fresh: boolean): void {
		if (entry.type === 'message') {
			this.committed(entry.message);
			return;
		}
		if (entry.type === 'close') {
			const question = this.log.messages.find((m) => m.seq === entry.close.from);
			this.emit({
				type: 'exchange_closed',
				exchange: {
					owner: entry.close.owner,
					from: entry.close.from,
					at: question?.at ?? entry.close.at,
					through: entry.close.through,
				},
			});
			return;
		}
		if (entry.type === 'lease') this.heardLease(entry.lease, fresh);
	}

	/** A lease row found: a fresh claim starts an activation, an end ends one, and an end with no claim before it is a wake written off. */
	private heardLease(lease: LeaseRow, fresh: boolean): void {
		const seat = seatOf(lease.id, this.assistant) ?? '';
		if (lease.phase === 'running') {
			if (fresh) {
				this.idleReported = false;
				this.emit({ type: 'activation_start', agent: seat });
			}
			return;
		}
		if (fresh) return;
		const spoke = this.log.messages.some((m) => m.activationId === lease.id);
		this.emit({ type: 'activation_end', agent: seat, spoke });
		if (lease.reason === 'expired') {
			this.emit({
				type: 'error',
				agent: seat,
				error: new Error('The activation ran past its lease.'),
			});
		}
	}

	/** One wake over the wire. A wake a message caused carries the line a running activation is steered with. */
	private send(id: string, seat: string): void {
		this.sentAt.set(id, this.now());
		const parsed = parseId(id);
		const message =
			parsed?.kind === 'wake' ? this.log.messages.find((m) => m.seq === parsed.seq) : undefined;
		const steer =
			message === undefined ? {} : { steer: { seq: message.seq, line: renderLine(message) } };
		void this.port(seat)
			.wake({ room: this.name, seat, activation: id, ...steer })
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
			unseen: (since) => this.log.since(since).length,
		};
	}

	/** The seat holding a live lease under this id, or nothing. */
	private liveSeatOf(id: string, state: RoomState): string | undefined {
		const lease = state.leases.get(id);
		if (lease === undefined || !isLive(lease, this.now())) return undefined;
		const seat = seatOf(id, this.assistant);
		return state.roster.some((s) => s.name === seat) ? seat : undefined;
	}

	async commit(commit: Commit): Promise<CommitResponse> {
		if (this.gone()) return stale('the room is gone');
		await this.ready;
		// A lease that ended is answered first: nothing the activation writes
		// lands, whatever the record did. The queue checks again where it writes.
		if (this.liveSeatOf(commit.activation, this.state()) === undefined) {
			return stale('the lease ended');
		}
		const seat = seatOf(commit.activation, this.assistant) ?? '';
		try {
			const committed = await this.commitMessage<Message>(
				commit.key,
				commit.readThrough,
				(state) => {
					if (this.liveSeatOf(commit.activation, state) === undefined)
						throw new StaleError('the lease ended');
					return this.draft(commit, seat, state);
				},
			);
			if ('missed' in committed) {
				this.emit({ type: 'conflict', author: seat, missed: committed.missed });
				return { missed: committed.missed };
			}
			return { committed: committed.message };
		} catch (error) {
			if (error instanceof StaleError) return stale(error.message);
			if (error instanceof RefusedError) return { refused: error.message };
			throw error;
		}
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
		return {
			kind: 'seated',
			...stamp,
			from: held.name,
			identity: held.identity,
			by: seat,
			attention: held.attention,
		};
	}

	async lease(lease: Lease): Promise<LeaseResponse> {
		if (this.gone()) return stale('the room is gone');
		await this.ready;
		const seat = seatOf(lease.activation, this.assistant);
		if (seat === undefined || !this.state().roster.some((s) => s.name === seat)) {
			return stale('the seat is not on the roster');
		}
		return lease.phase === 'running'
			? this.claim(lease.activation, seat, lease.heard ?? 0)
			: this.release(lease, seat);
	}

	/**
	 * A claim, or a renewal: the lease runs until `expiry`, unless it had
	 * ended. A fresh claim is taken only for an activation the fold says is
	 * due: the next attempt at a pending wake, or at an owed draft. Anything
	 * else was answered already, and a second run of it would answer twice.
	 * No lease runs past the deadline: the expiry a claim or a renewal takes
	 * is capped there, so an activation that runs on expires on the room's
	 * alarm, and the room counts it as one that came to nothing.
	 */
	private async claim(id: string, seat: string, heard: Seq): Promise<LeaseResponse> {
		const now = this.now();
		let expiry = now + this.runtime.wake.expiry;
		let fresh = false;
		const written = await this.log.write('lease', () => {
			const state = this.state();
			const known = state.leases.get(id);
			if (known === undefined && !this.due(state).has(id)) return undefined;
			if (known !== undefined && !isLive(known, now)) return undefined;
			fresh = known === undefined;
			const since = known === undefined ? now : Date.parse(known.since);
			expiry = Math.min(expiry, since + this.runtime.wake.deadline);
			const taken = Math.max(known?.heard ?? this.log.lastSeq, heard);
			return { id, phase: 'running', expiry, heard: taken, at: this.iso() };
		});
		if (!written) return stale('the lease ended');
		if (fresh) {
			this.idleReported = false;
			this.emit({ type: 'activation_start', agent: seat });
		}
		void this.reconcile();
		return { ok: { expiry, lastSeq: this.log.lastSeq } };
	}

	/** The ids the fold says may claim a fresh lease now. */
	private due(state: RoomState): Set<string> {
		return new Set([
			...state.pending.map((wake) => wake.id),
			...state.owed.map((owed) => draftId(owed.through, owed.attempts + 1)),
		]);
	}

	private async release(lease: Lease, seat: string): Promise<LeaseResponse> {
		const ended = await this.end(lease.activation, seat, lease.reason ?? 'released', lease.heard);
		if (!ended) return stale('the lease ended');
		void this.reconcile();
		return { ok: { expiry: this.now(), lastSeq: this.log.lastSeq } };
	}

	/**
	 * End one lease, for whatever reason, and say so once. Nothing to end is
	 * not an error. A revocation or an abandonment may name an activation
	 * that never claimed: the row ends it before it starts, and the wake or
	 * the draft it stood for is answered.
	 */
	private async end(id: string, seat: string, reason: EndReason, heard = 0): Promise<boolean> {
		let started = true;
		const written = await this.log.write('lease', () => {
			const known = this.state().leases.get(id);
			if (known?.phase === 'ended') return undefined;
			if (known === undefined && !WRITES_OFF.has(reason)) return undefined;
			const expired = known !== undefined && isExpired(known, this.now());
			if (known !== undefined && expired !== (reason === 'expired')) return undefined;
			started = known !== undefined;
			const taken = Math.max(known?.heard ?? this.log.lastSeq, heard);
			return { id, phase: 'ended', reason, heard: taken, at: this.iso() };
		});
		if (!written) return false;
		if (!started) return true;
		const spoke = this.state().messages.some((m) => m.activationId === id);
		this.emit({ type: 'activation_end', agent: seat, spoke });
		if (reason === 'expired') {
			this.emit({
				type: 'error',
				agent: seat,
				error: new Error('The activation ran past its lease.'),
			});
		}
		return true;
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
	 * storage refuses ends the pass, and the room looks again after the
	 * resend window: what it decided is still on the fold, and the storage
	 * may be back.
	 */
	private async reconcileOnce(): Promise<void> {
		await this.log.ready;
		for (let pass = 0; pass < 8 && !this.gone(); pass += 1) {
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
				this.arm(this.now() + this.runtime.wake.resend);
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

	/**
	 * A checkpoint once the log took enough rows since the last one, written
	 * from the fold where the write happens. It is a cache over the log: a
	 * write that fails changes nothing, and the room tries again at the next
	 * pass that writes nothing.
	 */
	private async checkpoint(): Promise<void> {
		if (this.stopped || this.log.rowsSinceCheckpoint < this.runtime.checkpoint.rows) return;
		try {
			await this.log.write('checkpoint', () => checkpointOf(this.state(), this.now()));
		} catch {
			// A checkpoint the storage refused is one the room does not need.
		}
	}

	/** A wake the fold no longer says is due is not one this room waits on. */
	private forget(state: RoomState): void {
		const due = this.due(state);
		for (const id of this.sentAt.keys()) {
			if (!due.has(id)) this.sentAt.delete(id);
		}
	}

	/** Write what the decision wrote, send what it sent. True when anything changed. */
	private async apply(decision: ReturnType<typeof decide>): Promise<boolean> {
		let changed = false;
		for (const expired of decision.expired) {
			const seat = seatOf(expired.id, this.assistant) ?? '';
			changed = (await this.end(expired.id, seat, 'expired')) || changed;
		}
		changed = (await this.abandon(decision.abandoned)) || changed;
		if (decision.close) changed = (await this.close(decision.close)) || changed;
		for (const send of decision.sends) this.send(send.id, send.seat);
		return changed || decision.sends.length > 0;
	}

	/** Write off each attempt the room does not make, and say so. True when any row landed. */
	private async abandon(rows: ReturnType<typeof decide>['abandoned']): Promise<boolean> {
		let changed = false;
		for (const row of rows) {
			const seat = seatOf(row.id, this.assistant) ?? '';
			if (!(await this.end(row.id, seat, 'abandoned', row.heard))) continue;
			changed = true;
			this.emit({ type: 'abandoned', agent: seat, activation: row.id });
		}
		return changed;
	}

	/**
	 * The room went quiet on an exchange, so that exchange ends at the record
	 * as the decision saw it: the close is a row on the log, written where the
	 * fold still says the same exchange is open. A question that landed after
	 * the decision opens the next exchange the moment this one closes, and the
	 * room says so; the next pass closes it at once when nobody works on it.
	 * The host hears the close before anything is written about it.
	 */
	private async close(close: NonNullable<ReturnType<typeof decide>['close']>): Promise<boolean> {
		let exchange: Exchange | undefined;
		const written = await this.log.write('close', () => {
			exchange = this.state().exchange;
			if (exchange?.from !== close.from || this.stopped) return undefined;
			return close;
		});
		if (!written || exchange === undefined) return false;
		this.emit({ type: 'exchange_closed', exchange: { ...exchange, through: close.through } });
		const next = this.state().exchange;
		if (next !== undefined) {
			this.idleReported = false;
			this.emit({ type: 'exchange_opened', exchange: next });
		}
		return true;
	}

	/** Whoever waited on the seats stopping, or on the room going quiet, hears it. */
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

	/** Revoke every live lease on the seats `which` picks: the room writes the end, and the seat side is cut. */
	private async revoke(which: (seat: string) => boolean): Promise<void> {
		if (this.evicted) return;
		await this.ready.catch(() => {});
		for (let pass = 0; pass < 8; pass += 1) {
			const picked = [...this.live(this.state())].filter(([seat]) => which(seat));
			if (picked.length === 0) break;
			for (const [seat, ids] of picked) await this.cut(seat, ids);
		}
		if (!this.gone()) await this.reconcile();
	}

	/**
	 * Cut one seat: every lease it holds ends revoked, every wake pending for
	 * it is written off the same way, and the seat side is told to stop, so
	 * nothing the seat was sent runs after the cut.
	 */
	private async cut(seat: string, ids: string[]): Promise<void> {
		for (const id of ids) await this.end(id, seat, 'revoked');
		const port = this.ports.get(seat);
		for (const id of ids) void port?.cut(id).catch(() => {});
	}

	/** Closes the run: what is live is revoked, what is present is marked gone, and the name comes free. */
	async stop(): Promise<void> {
		if (this.stopped) return;
		// Stopped from here on: a visit that arrives during the shutdown is
		// refused rather than seated into a room that is going away.
		this.stopped = true;
		this.cancelAlarm();
		try {
			// A room dropped from memory writes nothing: the next run over the log takes it up.
			if (this.evicted) return;
			await this.ready;
			await this.revoke(() => true);
			await this.leaveEverybody();
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
			await this.commitMessage<PresenceMessage>(
				crypto.randomUUID(),
				undefined,
				() => ({ kind: 'left', at: this.iso(), from: person.name }),
				false,
			);
		}
	}

	/**
	 * Dropped from memory: the alarm is cancelled, the log is closed, every
	 * call a seat makes from now on is stale, and nothing reaches a listener
	 * again. The record keeps what landed before, and nothing this run had
	 * in flight lands after.
	 */
	evict(): void {
		this.evicted = true;
		this.log.close();
		this.cancelAlarm();
		this.listeners.clear();
		for (const visit of this.visits.values()) visit.gone = true;
		for (const resolve of this.quietWaiters.splice(0)) resolve();
		for (const resolve of this.settledWaiters.splice(0)) resolve();
	}
}

/** A seat's intent the room refuses, with the reason the model reads. */
class RefusedError extends Error {}

/** The reasons that end an activation before it starts. */
const WRITES_OFF: ReadonlySet<EndReason> = new Set(['revoked', 'abandoned']);

/** A message before the log stamps its seq, its key and its wakes. */
type Drafted =
	| Omit<SpokenMessage, 'seq' | 'key' | 'wakes'>
	| Omit<SummaryMessage, 'seq' | 'key' | 'wakes'>
	| Omit<PresenceMessage, 'seq' | 'key' | 'wakes'>;

/** The composition `startSession` was given, checked for duplicates the way the room refuses them. */
function composeFrom(options: StartSessionOptions): Composition {
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

const seatRow = (placed: Placed): SeatRow => ({
	name: placed.def.name,
	identity: placed.def.identity,
	attention: placed.attention,
});

/** The roster before the replay: the composition, every seat idle, and nobody in the room. */
function startingSeats(composition: Composition, room: string): SeatInfo[] {
	const seats: SeatInfo[] = composition.agents.map(({ def, attention }) => ({
		kind: 'agent',
		name: def.name,
		identity: def.identity,
		status: 'idle',
		attention,
		sessionId: `${room}:${def.name}`,
	}));
	seats.push({
		kind: 'agent',
		name: composition.assistant.name,
		identity: composition.assistant.identity,
		status: 'idle',
		attention: 'none',
		sessionId: `${room}:${composition.assistant.name}`,
		assistant: true,
	});
	return seats;
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
