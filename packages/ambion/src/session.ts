/**
 * The room: the one place where a record, the seats around it, the people
 * visiting it and the exchanges they open become behaviour.
 *
 * Everything with a life of its own has left. The log is `log/log.ts`, who
 * is here is `presence.ts`, a seat, what wakes it and the seat's side of the
 * wire is `seat/seat.ts`, one activation is `seat/activation.ts`, the hands
 * it holds are `seat/hands.ts`, an exchange is `exchange.ts`, the assistant
 * is `room/assistant.ts`, and every sentence a participant reads is
 * `render.ts`. What is left is what only a room can do:
 *
 * - **Compose.** Seat the agents and the assistant, hold the reserve, admit the
 *   people, seat and unseat while it runs, and take it all down again.
 * - **Commit.** One queue, one seq at a time, for every author (rule 5), and
 *   one `message` event per message however it was written.
 * - **Route.** Who hears a message, and who wakes for it.
 * - **Answer a seat.** The view an activation reads, the commit it asks for,
 *   and the lease it holds — the three calls in `wire.ts`. The room answers
 *   them from a lease table it keeps in memory. A lease ends when the seat
 *   side releases it; the room cuts an activation it ends, and the seat side
 *   releases the lease then. The expiry the room hands out is what the seat
 *   side renews against.
 * - **Say when it has stopped.** An exchange closed, and nothing live.
 */
import type { SessionRepo, StreamFn } from '@earendil-works/pi-agent-core';
import { seated } from './define.ts';
import { type ClosedExchange, type Exchange, Exchanges } from './exchange.ts';
import {
	defaultRuntime,
	type RunningRoom,
	type Runtime,
	sessionsOver,
	stubModel,
	type Transport,
} from './host/runtime.ts';
import { RoomLog } from './log/log.ts';
import { Attendance, type VisitRuntime } from './presence.ts';
import {
	type Closing,
	type ComposingView,
	type PersonView,
	type RoomView,
	renderLine,
	renderSystemPrompt,
	renderTurnContext,
	type SeatSpeaking,
} from './render.ts';
import { Assistant, assertAssistant, type Draft } from './room/assistant.ts';
import { activationId, draftId, parseId, seatOf } from './room/lease.ts';
import { inProcessTransport, SeatActor, wakes } from './seat/seat.ts';
import {
	type AgentDefinition,
	type AgentSeat,
	type Attention,
	authorOf,
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
	ActivationView,
	Commit,
	CommitResponse,
	EndReason,
	Hand,
	Lease,
	LeaseResponse,
	SeatPort,
	ViewResponse,
} from './wire.ts';

/** How long a lease runs between renewals. The seat side renews at half of it. */
const LEASE_EXPIRY = 60_000;

/** An agent on the roster or in the reserve: the definition, and the attention it takes when seated. */
interface Placed {
	def: AgentDefinition;
	attention: Attention;
	/** Seated after the room started, so `stop` unseats it and the record says so. */
	added?: true;
	/** Seated from the reserve, so an unseat returns it there. */
	reserved?: true;
}

/** One lease the room holds: whose it is, and whether the activation left a mark. */
interface Held {
	seat: string;
	spoke: boolean;
}

/** A message before the log stamps its seq and its key. */
type Drafted =
	| Omit<SpokenMessage, 'seq' | 'key'>
	| Omit<SummaryMessage, 'seq' | 'key'>
	| Omit<PresenceMessage, 'seq' | 'key'>;

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

/** Reading a room takes no run: the pull side, and nothing that starts anything. */
export interface SessionView {
	readonly name: string;
	messages(options?: { since?: Seq }): Promise<Message[]>;
	seats(): SeatInfo[];
	subscribe(listener: (event: SessionEvent) => void): () => void;
}

export interface Session extends SessionView {
	/**
	 * The question the room is working on, or nothing when nobody has asked.
	 * Run state: a restart begins with none.
	 */
	exchange(): Exchange | undefined;
	/** Resolves when no seat that speaks for itself is live and the assistant is not composing. */
	settled(): Promise<void>;
	/**
	 * Resolves when the room is quiet and every summary an exchange owed has
	 * been written, declined or refused. `settled()` reports the seats alone,
	 * which is what rule 5 needs it to mean; this is what a host waits for when
	 * it wants the one message a person reads.
	 */
	quiet(): Promise<void>;
	/** Cancel every activation in flight. The room keeps running; `stopSession` ends it. */
	abort(): void;
	/**
	 * Put an agent on the roster while the room runs, from the reserve or from
	 * anywhere. The seating lands on the record, and it wakes the seat it names.
	 */
	seat(seat: AgentSeat): Promise<void>;
	/**
	 * Take an agent off the roster. Its activation in flight is aborted, the
	 * record says it left, and an agent that came from the reserve returns to it.
	 */
	unseat(agent: AgentDefinition): Promise<void>;
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
	if (runtime.running.has(options.name)) {
		throw new Error(
			`Session '${options.name}' is already running: stop it before starting it again.`,
		);
	}
	const session = new SessionImpl(options, runtime);
	runtime.running.set(options.name, session);
	return session;
}

/** Takes the room down: activations aborted, visits closed, every departure committed. */
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
	return new ReadOnlySession(name, options.repo ? sessionsOver(options.repo) : runtime.sessions);
}

class ReadOnlySession implements SessionView {
	private readonly log: RoomLog;
	private readonly here: Attendance;

	constructor(
		readonly name: string,
		sessions: SessionOpener,
	) {
		this.log = new RoomLog(sessions.open(name));
		this.here = new Attendance(() => this.log.messages);
	}

	async messages(options: { since?: Seq } = {}): Promise<Message[]> {
		await this.log.ready;
		return this.log.since(options.since);
	}

	/** A room that is not running has no agents standing up, and nobody in it. */
	seats(): SeatInfo[] {
		return [...this.here.known()].map(([name, identity]) => ({
			kind: 'human' as const,
			name,
			identity,
			presence: this.here.presenceOf(name),
		}));
	}

	/** Nothing is running, so nothing happens. The listener is never called. */
	subscribe(): () => void {
		return () => {};
	}
}

/** A seat's intent the room refuses, with the reason the model reads. */
class RefusedError extends Error {}

const stale = (why: string) => ({ stale: why });

// -- the room ----------------------------------------------------------------

class SessionImpl implements Session, RunningRoom {
	readonly name: string;
	readonly stream: StreamFn;
	readonly model: ModelResolver;
	readonly sessions: SessionOpener;
	private readonly goal?: string;
	private readonly runtime: Runtime;
	/** How this room reaches a seat: what the runtime holds, or every seat as an actor in this process. */
	private readonly transport: Transport;
	private readonly log: RoomLog;
	/**
	 * The record replayed, and the composition checked against it: a name the
	 * record knows as a person cannot be seated. Every operation waits here.
	 */
	private readonly ready: Promise<void>;
	private readonly agents = new Map<string, Placed>();
	/** The reserve: agents the room may seat later, held with the attention they will take. */
	private readonly reserve = new Map<string, Placed>();
	/** The room's assistant: how each person reads, who is owed, what it is drafting or composing. */
	private readonly assistant: Assistant;
	private readonly here = new Attendance(() => this.record);
	private readonly listeners = new Set<(event: SessionEvent) => void>();
	private readonly settledWaiters: (() => void)[] = [];
	private readonly quietWaiters: (() => void)[] = [];
	/** The leases held now, by activation id. */
	private readonly leases = new Map<string, Held>();
	/** The wakes sent and not yet claimed, by activation id: the seat is live from the send. */
	private readonly pending = new Map<string, string>();
	/** Every activation that ended. An ended activation never claims again. */
	private readonly spent = new Set<string>();
	/** How many drafts the assistant took at each seq, so a second draft at one seq takes a new id. */
	private readonly drafts = new Map<Seq, number>();
	private readonly ports = new Map<string, SeatPort>();
	/** The record is replayed and the composition holds: a seat's call is answered on the spot. */
	private replayed = false;
	private stopped = false;
	/**
	 * Whether a seat has worked since the room last settled. A failed draft
	 * waits for the seats to stop again, and a second settle at one quiescence
	 * — an aborted activation ending after an unseat closed the exchange, a
	 * question that woke nobody — is not the seats stopping again.
	 */
	private stirred = false;
	/** The room's exchanges: what a question opened, and what quiescence closes. */
	private readonly exchanges = new Exchanges();

	constructor(options: StartSessionOptions, runtime: Runtime) {
		this.name = options.name;
		this.goal = options.goal?.trim() || undefined;
		this.runtime = runtime;
		this.transport = runtime.transport ?? inProcessTransport();
		this.sessions = options.repo ? sessionsOver(options.repo) : runtime.sessions;
		this.log = new RoomLog(this.sessions.open(this.name));
		for (const seat of options.agents ?? []) this.place(seat);
		// Seated at the narrow end: nothing said in the room wakes the assistant;
		// the open and the close of an exchange do, and it is here for the whole run.
		const assistant = assertAssistant(options.assistant);
		this.place(seated(assistant, 'none'));
		this.assistant = new Assistant(assistant.name);
		for (const seat of options.available ?? []) this.hold(seat);
		this.stream = options.streamFn ?? runtime.stream;
		this.model = options.streamFn ? stubModel : runtime.model;
		this.ready = this.compose();
		void this.ready.catch(() => {});
	}

	/**
	 * The composition against the record: `assertFreeName` reads the record,
	 * so the check the constructor ran saw an empty one. This is the check
	 * that counts, and the first call that needs the room sees its refusal.
	 */
	private async compose(): Promise<void> {
		await this.log.ready;
		for (const name of [...this.agents.keys(), ...this.reserve.keys()]) {
			if (this.here.knows(name)) {
				throw new Error(`Duplicate agent name '${name}': one name names one participant.`);
			}
		}
		this.replayed = true;
	}

	/**
	 * A seat's call waits for the room to be up, and for nothing else once it
	 * is: a view taken in the same tick as the wake reads the record the wake
	 * was decided on, before anything lands on top of it.
	 */
	private async up(): Promise<void> {
		if (!this.replayed) await this.ready;
	}

	/** The room's clock, as an ISO stamp for the record. */
	private now(): string {
		return new Date(this.runtime.clock.now()).toISOString();
	}

	private get record(): Message[] {
		return this.log.messages;
	}

	// -- the roster --------------------------------------------------------------

	/** Seat one agent, refusing a name the room already knows. */
	private place(seat: AgentSeat): Placed {
		const placed = this.unwrap(seat);
		this.assertFreeName(placed.def.name);
		this.agents.set(placed.def.name, placed);
		return placed;
	}

	/** Hold one agent in reserve, refusing a name the room already knows. */
	private hold(seat: AgentSeat): void {
		const held = this.unwrap(seat);
		this.assertFreeName(held.def.name);
		this.reserve.set(held.def.name, held);
	}

	/** The definition and its attention. The seat side resolves the definition by name, so the catalog knows it. */
	private unwrap(seat: AgentSeat): Placed {
		const def = isSeatedAgent(seat) ? seat.agent : seat;
		if (!isAgent(def)) {
			throw new Error('Agents must come from defineAgent or seated().');
		}
		this.runtime.catalog.set(def.name, def);
		return { def, attention: isSeatedAgent(seat) ? seat.attention : 'broadcast' };
	}

	/** One name names one participant: seated, in reserve, or a person the room knows. */
	private assertFreeName(name: string): void {
		if (this.agents.has(name) || this.reserve.has(name) || this.here.knows(name)) {
			throw new Error(`Duplicate agent name '${name}': one name names one participant.`);
		}
	}

	/** The host puts an agent on the roster. From the reserve when it is there; from anywhere else too. */
	async seat(seat: AgentSeat): Promise<void> {
		this.assertRunning();
		await this.ready;
		const given = this.unwrap(seat);
		const held = this.reserve.get(given.def.name);
		if (held) this.reserve.delete(given.def.name);
		// A bare definition takes the attention its reserve entry carried.
		const attention = isSeatedAgent(seat) ? seat.attention : (held?.attention ?? 'broadcast');
		const placed = this.place(seated(given.def, attention));
		placed.added = true;
		if (held) placed.reserved = true;
		await this.commitPresence({
			kind: 'seated',
			from: given.def.name,
			identity: given.def.identity,
		});
	}

	/** The host takes an agent off the roster. Never the assistant. */
	async unseat(agent: AgentDefinition): Promise<void> {
		this.assertRunning();
		await this.ready;
		const seat = this.agents.get(agent.name);
		if (!seat) throw new Error(`'${agent.name}' is not seated in this session.`);
		if (this.assistant.is(agent.name)) {
			throw new Error(`'${agent.name}' is the assistant: a room cannot run without one.`);
		}
		this.retire(seat);
		await this.commitPresence({ kind: 'unseated', from: agent.name });
	}

	/**
	 * Off the roster: what was mid-flight is cut, a wake it was sent and never
	 * claimed is forgotten, and a reserve agent goes back to the reserve. The
	 * lease it holds ends when the seat side releases it.
	 */
	private retire(seat: Placed): void {
		const name = seat.def.name;
		const port = this.ports.get(name);
		if (port instanceof SeatActor) port.abort();
		for (const [id, of] of this.pending) if (of === name) this.pending.delete(id);
		this.agents.delete(name);
		if (seat.reserved) this.reserve.set(name, { def: seat.def, attention: seat.attention });
	}

	/** The assistant seats one name from the reserve, where its seating lands. */
	private admit(name: string): void {
		const held = this.reserve.get(name);
		if (!held) throw new Error(`'${name}' is not in the reserve.`);
		this.reserve.delete(name);
		const placed = this.place(seated(held.def, held.attention));
		placed.added = true;
		placed.reserved = true;
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

	exchange(): Exchange | undefined {
		return this.exchanges.current();
	}

	settled(): Promise<void> {
		if (!this.working()) return Promise.resolve();
		return new Promise((resolve) => this.settledWaiters.push(resolve));
	}

	quiet(): Promise<void> {
		// The same condition the `quiet` event reports. A summary a race left
		// owed is not work in flight: it waits for the next quiet room, and the
		// room is quiet in the meantime.
		if (this.idle()) return Promise.resolve();
		return new Promise((resolve) => this.quietWaiters.push(resolve));
	}

	/** Whether a seat is live: it holds a lease, or a wake was sent to it and not yet claimed. */
	private live(name: string): boolean {
		for (const held of this.leases.values()) if (held.seat === name) return true;
		for (const of of this.pending.values()) if (of === name) return true;
		return false;
	}

	/**
	 * What is live, on the roster. One fact, kept in one place: a lease is held
	 * or a wake is pending, so nothing counts activations alongside and
	 * nothing can drift.
	 */
	private running(): string[] {
		return [...this.agents.keys()].filter((name) => this.live(name));
	}

	/** Nothing at all is live. The assistant writing is something. */
	private idle(): boolean {
		return this.running().length === 0;
	}

	/**
	 * Something that speaks for itself is live. The assistant drafting a
	 * summary does not count: a close must not hold open the exchange it is
	 * closing. The assistant composing the room does count: that is the
	 * exchange's own work, and the exchange stays open until it has decided.
	 */
	private working(): boolean {
		const composing = this.assistant.composing() !== undefined;
		return this.running().some((name) => composing || !this.assistant.is(name));
	}

	/** Cut every activation in flight. Each seat side releases its lease, and the room hears how it ended. */
	abort(): void {
		for (const port of this.ports.values()) if (port instanceof SeatActor) port.abort();
	}

	async messages(options: { since?: Seq } = {}): Promise<Message[]> {
		await this.ready;
		return this.log.since(options.since);
	}

	seats(): SeatInfo[] {
		const seats: SeatInfo[] = [];
		for (const seat of this.agents.values()) {
			seats.push({
				kind: 'agent',
				name: seat.def.name,
				identity: seat.def.identity,
				status: this.live(seat.def.name) ? 'active' : 'idle',
				attention: seat.attention,
				sessionId: `${this.name}:${seat.def.name}`,
				...(this.assistant.is(seat.def.name) ? { assistant: true as const } : {}),
			});
		}
		for (const [name, identity] of this.here.known()) {
			seats.push({ kind: 'human', name, identity, presence: this.here.presenceOf(name) });
		}
		return seats;
	}

	// -- people -----------------------------------------------------------------

	/** Puts a person in the room. A second visit while they are here is the same visit. */
	async visit(human: HumanDefinition): Promise<Visit> {
		this.assertRunning();
		await this.ready;
		// Checked after the replay: a name the record knows is only known then.
		this.assertVisitable(human);
		const already = this.here.visitOf(human.name);
		if (already) return this.handle(already);
		// The room changes before the message does: a seat woken by the arrival
		// must read a roster that already agrees with it.
		const visit = this.here.enter(human);
		// How they read outlives the visit: an exchange they opened is finished
		// properly or not at all, and its message is written after they leave.
		this.assistant.serve(human.name, human.preferences);
		await this.commitPresence({ kind: 'arrived', from: human.name, identity: human.identity });
		return this.handle(visit);
	}

	private assertVisitable(human: HumanDefinition): void {
		if (this.agents.has(human.name) || this.reserve.has(human.name)) {
			throw new Error(
				`'${human.name}' is an agent in this session: one name names one participant.`,
			);
		}
		const known = this.here.known().get(human.name);
		if (known !== undefined && known !== human.identity) {
			throw new Error(
				`'${human.name}' is already in this session under a different identity: one name is one person.`,
			);
		}
	}

	private assertRunning(): void {
		if (this.stopped) throw new Error(`Session '${this.name}' is stopped.`);
	}

	private assertLive(visit: VisitRuntime): void {
		if (visit.gone) throw new Error(`${visit.human.name}'s visit has ended.`);
	}

	private async endVisit(visit: VisitRuntime): Promise<void> {
		if (visit.gone) return;
		visit.gone = true;
		this.here.leave(visit.human.name);
		await this.commitPresence({ kind: 'left', from: visit.human.name });
	}

	private handle(visit: VisitRuntime): Visit {
		const session = this;
		return {
			human: visit.human,
			get since() {
				return session.here.sinceOf(visit.human.name);
			},
			async deliver(input) {
				session.assertLive(visit);
				await session.deliverFrom(visit.human.name, input);
			},
			leave() {
				return session.endVisit(visit);
			},
		};
	}

	private async deliverFrom(
		from: string,
		input: { to?: Participant; text: string; key?: string },
	): Promise<void> {
		const to = input.to?.name;
		if (to !== undefined && !this.here.knows(to) && !this.agents.has(to)) {
			throw new Error(`Cannot direct a delivery to '${to}': not in this session.`);
		}
		await this.commitMessage<SpokenMessage>(input.key ?? crypto.randomUUID(), undefined, {
			kind: 'said',
			at: this.now(),
			from,
			...(to === undefined ? {} : { to }),
			text: input.text,
		});
	}

	/** Closes the run: what is mid-flight ends, what is present is marked gone. */
	async stop(): Promise<void> {
		if (this.stopped) return;
		// Stopped from here on: a visit that arrives during the shutdown is
		// refused rather than seated into a room that is going away.
		this.stopped = true;
		try {
			this.abort();
			await this.ready;
			// A deliberate shutdown observed everybody leaving, so the record
			// says so, and the host hears it. It wakes nobody: an activation
			// started to hear that the room is closing is an activation nobody reads.
			for (const visit of this.here.all()) {
				visit.gone = true;
				this.here.leave(visit.human.name);
				await this.commitUnrouted({ kind: 'left', from: visit.human.name });
			}
			// What the run added leaves with it, the same way: the next run begins
			// from the composition `startSession` was given.
			for (const seat of this.agents.values()) {
				if (!seat.added) continue;
				this.retire(seat);
				await this.commitUnrouted({ kind: 'unseated', from: seat.def.name });
			}
		} finally {
			// The name comes free whatever the repo did. A failed write must
			// not leave a room that can never be started again.
			if (this.runtime.running.get(this.name) === this) this.runtime.running.delete(this.name);
			// A stopped room never goes quiet on its own, so nobody waits on it.
			for (const resolve of this.quietWaiters.splice(0)) resolve();
		}
	}

	// -- commits ----------------------------------------------------------------

	/** A presence change the room commits under a fresh key, and routes. */
	private async commitPresence(change: Omit<PresenceMessage, 'seq' | 'at' | 'key'>): Promise<void> {
		await this.commitMessage<PresenceMessage>(crypto.randomUUID(), undefined, {
			...change,
			at: this.now(),
		});
	}

	/** A presence change the closing room commits and routes to nobody: an activation nobody reads. */
	private async commitUnrouted(change: Omit<PresenceMessage, 'seq' | 'at' | 'key'>): Promise<void> {
		await this.commitMessage<PresenceMessage>(
			crypto.randomUUID(),
			undefined,
			{ ...change, at: this.now() },
			{ route: false },
		);
	}

	/**
	 * One operation on the room's commit queue: the write, then what the room
	 * changes for a fresh message, then what it does with it, inside the same
	 * link of the queue. A repeated key lands nothing, so the room does
	 * nothing with it either.
	 */
	private commitMessage<T extends Message>(
		key: string,
		readThrough: Seq | undefined,
		draft: Omit<T, 'seq' | 'key'>,
		options: { route?: boolean; landed?: () => void } = {},
	) {
		return this.log.commit<T>(
			{ key, ...(readThrough === undefined ? {} : { readThrough }), draft },
			(message) => {
				options.landed?.();
				if (options.route ?? true) this.committed(message);
				else this.emit({ type: 'message', message });
			},
		);
	}

	/**
	 * What happens to every message once its write is confirmed: the host
	 * hears about it, and the room routes it. One message, one event, one
	 * order — stated here rather than at each of the commit sites.
	 */
	private committed(message: Message): void {
		// The message lands, then what it opened: an exchange is a fact about a
		// message the host has already seen. Both come before the routing, so
		// nothing wakes on a message the host has not heard about.
		this.emit({ type: 'message', message });
		this.noteExchange(message);
		this.dispatch(message);
		// A question that wakes no seat has no seat to stop, so the exchange it
		// opened would never close. The same check an ending activation runs,
		// and the same last word: the room was quiet, and it says so.
		if (this.exchanges.current() !== undefined && !this.working()) {
			this.settle();
			if (this.idle()) this.markQuiet();
		}
	}

	/**
	 * A person's question opens an exchange, and the room says so. When the
	 * room holds agents in reserve, the assistant composes the room for it: it
	 * reads the question while the seats do, and seats who the question needs.
	 */
	private noteExchange(message: Message): void {
		const opened = this.exchanges.note(message, this.here.knows(message.from));
		if (!opened) return;
		this.emit({ type: 'exchange_opened', exchange: opened });
		if (this.reserve.size === 0 || this.stopped) return;
		const assistant = this.assistant.name;
		const composing = this.assistant.compose(
			opened.owner,
			opened.from,
			this.reserve.size,
			this.live(assistant),
		);
		if (composing) this.activate(assistant, activationId(opened.from, assistant));
	}

	// -- routing ----------------------------------------------------------------

	/**
	 * Route a committed message — the room's whole policy in one place, and
	 * the same for what a person said, what a person did, and what a colleague
	 * said. Every colleague still at work hears it as a steer (rule 2). What
	 * wakes an idle seat is the attention it was seated at, against the reach
	 * of the message (rules 1, 4 and 6, in `wakes`).
	 */
	private dispatch(message: Message): void {
		// The author is excluded, and the seat a message names is its target. For
		// every kind but a seating the two are `from`; a seating is written by
		// `by`, or by nobody when the host did it, and names the seat in `from`.
		const author = authorOf(message);
		const target = targetOf(message);
		const fromAssistant = author !== undefined && this.assistant.is(author);
		for (const seat of this.agents.values()) {
			if (seat.def.name !== author) this.route(seat, message, target, fromAssistant);
		}
	}

	/** One seat hears one message: steered in while it is live, or woken when it is at rest. */
	private route(
		seat: Placed,
		message: Message,
		target: string | undefined,
		fromAssistant: boolean,
	): void {
		const name = seat.def.name;
		const id = activationId(message.seq, name);
		if (this.live(name)) {
			if (!this.hearsSteers(name)) return;
			this.send(id, name, { seq: message.seq, line: renderLine(message) });
		} else if (wakes({ name, attention: seat.attention }, target, message, fromAssistant)) {
			this.activate(name, id);
		}
	}

	/**
	 * A composing activation decides on the question as it was asked, and what
	 * the seats say while it decides is theirs to say: steering it in would
	 * hand the assistant answers to weigh and no hand to weigh them with.
	 */
	private hearsSteers(name: string): boolean {
		return !(this.assistant.is(name) && this.assistant.composing() !== undefined);
	}

	/** A wake that starts an activation: the seat is live from here until the lease it claims ends. */
	private activate(seat: string, id: string): void {
		this.pending.set(id, seat);
		this.send(id, seat);
	}

	/** One wake over the wire. A wake a message caused carries the line a running activation is steered with. */
	private send(id: string, seat: string, steer?: { seq: Seq; line: string }): void {
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
		if (this.stopped) return stale('the room is gone');
		await this.up();
		const held = this.leases.get(id);
		if (held === undefined) return stale('the lease ended');
		const seat = this.agents.get(held.seat);
		if (seat === undefined) return stale('the seat left the roster');
		return { view: this.viewOf(id, seat) };
	}

	/** The view one activation reads: two rendered strings, the model id, and the hand. */
	private viewOf(id: string, seat: Placed): ActivationView {
		const { hand, closing, composing } = this.handOf(id, seat);
		const speaking = this.speaking(seat, closing, composing);
		const room = this.roomView();
		return {
			activation: id,
			seat: seat.def.name,
			model: seat.def.model,
			lastSeq: this.log.lastSeq,
			systemPrompt: renderSystemPrompt(speaking, room),
			context: renderTurnContext(speaking, room),
			hand,
			...(closing ? { closing } : {}),
			...(composing ? { composing } : {}),
		};
	}

	/**
	 * What an activation is for: a draft closes an exchange, the assistant
	 * woken by a question composes the room for it, and every other seat
	 * speaks. The assistant woken for anything else holds nothing.
	 */
	private handOf(
		id: string,
		seat: Placed,
	): { hand: Hand; closing?: ActivationView['closing']; composing?: ActivationView['composing'] } {
		if (parseId(id)?.kind === 'draft') {
			const draft = this.assistant.closing();
			if (draft === undefined) return { hand: 'none' };
			return { hand: 'summarise', closing: { ...draft } };
		}
		if (!this.assistant.is(seat.def.name)) return { hand: 'say' };
		const composing = this.assistant.composing();
		return composing === undefined
			? { hand: 'none' }
			: { hand: 'seat', composing: { ...composing } };
	}

	/**
	 * What the prose is given of the seat taking this activation. The assistant
	 * holds every fact here; a seat holds none of them.
	 */
	private speaking(
		seat: Placed,
		closing: ActivationView['closing'],
		composing: ActivationView['composing'],
	): SeatSpeaking {
		const closingView: Closing | undefined = closing && {
			...closing,
			preferences: this.assistant.preferencesOf(closing.person),
		};
		const composingView: ComposingView | undefined = composing && {
			person: composing.person,
			from: composing.from,
			reserve: this.reserved(),
		};
		return {
			def: seat.def,
			assistant: this.assistant.is(seat.def.name),
			closing: closingView,
			composing: composingView,
		};
	}

	/** The reserve as the assistant reads it: a name and an identity per agent. */
	private reserved(): { name: string; identity: string }[] {
		return [...this.reserve.values()].map(({ def }) => ({
			name: def.name,
			identity: def.identity,
		}));
	}

	/** What the prose is given of this room, built fresh for each activation. */
	private roomView(): RoomView {
		const open = this.exchanges.current();
		return {
			name: this.name,
			goal: this.goal,
			now: this.runtime.clock.now(),
			seats: this.seats(),
			people: this.peopleViews(),
			record: this.record,
			exchange: open && { owner: open.owner, from: open.from },
		};
	}

	/** One entry per person the room knows, with their gap and what they missed. */
	private peopleViews(): PersonView[] {
		const views: PersonView[] = [];
		for (const [name, identity] of this.here.known()) {
			const since = this.here.sinceOf(name);
			views.push({
				name,
				identity,
				presence: this.here.presenceOf(name),
				changedAt: this.here.lastChangeAt(name),
				since,
				unseen: since === undefined ? 0 : this.log.since(since).length,
			});
		}
		return views;
	}

	/**
	 * Rule 5 for a say and for a summary: commit under `readThrough`, the seq
	 * the author has read. The queue refuses a commit the record moved past,
	 * and the loser is handed what it missed. The event names the author, not
	 * the seat: a say and a summary are refused the same way. A seating
	 * commits under no `readThrough`: it is decided on the question, whatever
	 * landed since.
	 */
	async commit(commit: Commit): Promise<CommitResponse> {
		if (this.stopped) return stale('the room is gone');
		await this.up();
		const held = this.leases.get(commit.activation);
		if (held === undefined) return stale('the lease ended');
		// Rule 5 comes first: a seat that has not read the record is told what
		// it missed before anything else is checked, so a say at a colleague
		// who left in the meantime reads the departure. The queue runs the same
		// check again where the write happens.
		const missed = this.unheard(commit.readThrough);
		if (missed !== undefined) {
			this.emit({ type: 'conflict', author: held.seat, missed });
			return { missed };
		}
		let drafted: Drafted;
		try {
			drafted = this.draft(commit, held.seat);
		} catch (error) {
			if (error instanceof RefusedError) return { refused: error.message };
			throw error;
		}
		// A seating changes the roster where the message lands, before it
		// routes: every seat the seating reaches reads a roster that already
		// agrees with it, and a repeated key changes nothing twice.
		const landed = drafted.kind === 'seated' ? () => this.admit(drafted.from) : undefined;
		const committed = await this.commitMessage<Message>(commit.key, commit.readThrough, drafted, {
			landed,
		});
		if ('missed' in committed) {
			this.emit({ type: 'conflict', author: held.seat, missed: committed.missed });
			return { missed: committed.missed };
		}
		held.spoke = true;
		return { committed: committed.message };
	}

	/** What the record holds past what the author read, or nothing when it read everything. */
	private unheard(readThrough: Seq | undefined): Message[] | undefined {
		if (readThrough === undefined || this.log.lastSeq <= readThrough) return undefined;
		return this.log.since(readThrough);
	}

	/** The message a seat's intent becomes, with everything the room stamps. */
	private draft(commit: Commit, seat: string): Drafted {
		const intent = commit.intent;
		const at = this.now();
		if (intent.kind === 'said') {
			this.assertAddressable(seat, intent.to);
			return {
				kind: 'said',
				at,
				from: seat,
				...(intent.to === undefined ? {} : { to: intent.to }),
				text: intent.text,
			};
		}
		if (intent.kind === 'summary') {
			return {
				kind: 'summary',
				at,
				from: seat,
				to: intent.to,
				text: intent.text,
				covers: intent.covers,
			};
		}
		const held = this.reserve.get(intent.name);
		if (held === undefined) {
			const names = [...this.reserve.keys()];
			throw new RefusedError(
				`'${intent.name}' is not in the reserve. ` +
					(names.length ? `Seat one of: ${names.join(', ')}.` : 'The reserve is empty.'),
			);
		}
		return { kind: 'seated', at, from: held.def.name, identity: held.def.identity, by: seat };
	}

	private assertAddressable(seat: string, to: string | undefined): void {
		if (to === undefined) return;
		const target = this.agents.get(to);
		if (!this.here.knows(to) && !target) {
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

	/**
	 * A claim, a renewal or a release. A release is answered whatever the
	 * room's state: the lease was held, and the room hears how the activation
	 * went. A claim or a renewal needs the seat on the roster.
	 */
	async lease(lease: Lease): Promise<LeaseResponse> {
		if (lease.phase === 'ended') return this.release(lease.activation, lease.reason ?? 'released');
		if (this.stopped) return stale('the room is gone');
		await this.up();
		const seat = seatOf(lease.activation, this.assistant.name);
		if (seat === undefined || !this.agents.has(seat)) return stale('the seat is not on the roster');
		return this.claim(lease.activation, seat);
	}

	/**
	 * A claim takes the lease for an activation that never ended; a renewal
	 * moves its expiry. The seat is live from the wake that was sent, and the
	 * claim is when the activation starts.
	 */
	private claim(id: string, seat: string): LeaseResponse {
		const ok = {
			ok: { expiry: this.runtime.clock.now() + LEASE_EXPIRY, lastSeq: this.log.lastSeq },
		};
		if (this.leases.has(id)) return ok;
		if (this.spent.has(id)) return stale('the lease ended');
		this.pending.delete(id);
		this.leases.set(id, { seat, spoke: false });
		if (parseId(id)?.kind !== 'draft') this.stirred = true;
		this.emit({ type: 'activation_start', agent: seat });
		return ok;
	}

	private release(id: string, reason: EndReason): LeaseResponse {
		const held = this.leases.get(id);
		if (held === undefined) return stale('the lease ended');
		this.leases.delete(id);
		this.spent.add(id);
		this.ended(held, reason);
		return { ok: { expiry: this.runtime.clock.now(), lastSeq: this.log.lastSeq } };
	}

	/** The seat stopped: what that closes, and what it frees. */
	private ended(held: Held, reason: EndReason): void {
		const seat = held.seat;
		const assistant = this.assistant.is(seat);
		const drafted = assistant && this.assistant.composing() === undefined;
		if (assistant) {
			this.assistant.activationEnded({
				wrote: held.spoke,
				failed: reason === 'failed' || reason === 'refused',
			});
		}
		this.emit({ type: 'activation_end', agent: seat, spoke: held.spoke });
		// An exchange ends when the seats stop, and a composing assistant is one
		// of them. The assistant writing about an exchange is not the room still
		// working on it, so a draft's end closes none — which also keeps a failing
		// assistant from retrying for ever. What a draft's end frees is the seat,
		// for whoever was owed while it drafted.
		if (drafted) this.draftNext(this.assistant.dueAfterDraft(...this.dueArgs()));
		else if (!this.working()) this.settle();
		else if (assistant) this.draftNext(this.assistant.dueAfterDraft(...this.dueArgs()));
		if (this.idle()) this.markQuiet();
	}

	// -- the assistant ------------------------------------------------------------

	/** The seats stopped: whoever waited hears it, and the exchange closes. */
	private settle(): void {
		for (const resolve of this.settledWaiters.splice(0)) resolve();
		const worked = this.stirred;
		this.stirred = false;
		this.closeExchange(worked);
	}

	/**
	 * The room went quiet, so the exchange it was working on is over. The host
	 * hears that before anything is written about it: the assistant is the first
	 * reader of a closed exchange and not the only one.
	 */
	private closeExchange(worked: boolean): void {
		const closing = this.exchanges.close(this.log.lastSeq);
		if (closing) this.emit({ type: 'exchange_closed', exchange: closing });
		this.summariseClosed(closing, worked);
	}

	/**
	 * What the assistant makes of a closed exchange: its owner is owed the one
	 * message that stands for it, and the room wakes the assistant for it.
	 * Nothing else in the room wakes for a close — the assistant is seated `none`,
	 * and the close is the one thing that reaches it.
	 *
	 * Every quiet room is a chance to write what is owed, whatever made the
	 * room busy. The assistant's own activation ends no exchange, so a failed draft
	 * waits for the next time the seats stop rather than retrying on itself —
	 * and a settle that no seat worked before is not the seats stopping again.
	 */
	private summariseClosed(closing: ClosedExchange | undefined, worked: boolean): void {
		if (closing) this.assistant.owe(closing.owner, closing.from);
		const due = worked
			? this.assistant.dueAtQuiescence(...this.dueArgs())
			: this.assistant.dueAfterDraft(...this.dueArgs());
		this.draftNext(due);
	}

	/** What the assistant reads to decide whether a range needs a message, and whether it is free to. */
	private dueArgs(): [readonly Message[], Seq, (name: string) => boolean, boolean] {
		return [
			this.record,
			this.log.lastSeq,
			(name) => this.speaksForItself(name),
			this.live(this.assistant.name),
		];
	}

	/** The assistant takes the draft it is due, unless the room is closing. Each draft is an activation of its own. */
	private draftNext(draft: Draft | undefined): void {
		if (draft === undefined || this.stopped) return;
		const attempt = (this.drafts.get(draft.through) ?? 0) + 1;
		this.drafts.set(draft.through, attempt);
		this.activate(this.assistant.name, draftId(draft.through, attempt));
	}

	/**
	 * A seat that speaks for itself: not a person, and not the assistant. It is
	 * what the threshold counts — what the room produced, not what a person said
	 * into it, and not what the assistant wrote about it. It reads the record
	 * rather than the roster, so an agent that spoke and was unseated before
	 * the close still counts.
	 */
	private speaksForItself(name: string): boolean {
		return !this.here.knows(name) && !this.assistant.is(name);
	}

	/**
	 * The room is quiet: no seat is live, and the assistant owes nobody.
	 * A summary that a race refused is not work in flight — it waits for the
	 * next quiescence, and the room is quiet in the meantime.
	 *
	 * A stopped room never reports this. Shutdown aborts the activations in flight
	 * and drains whoever waited, and a room that is closing is not a room that
	 * has gone quiet.
	 */
	private markQuiet(): void {
		if (this.stopped || !this.idle()) return;
		this.emit({ type: 'quiet' });
		for (const resolve of this.quietWaiters.splice(0)) resolve();
	}
}

/** The seat a message names: a directed say names who it addresses, a seating names who it seats. */
function targetOf(message: Message): string | undefined {
	if (isSpoken(message)) return message.to;
	return message.kind === 'seated' ? message.from : undefined;
}
