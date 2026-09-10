/**
 * The room: the one place where a log, the seats around it, the people
 * visiting it and the exchanges they open become behaviour.
 *
 * Everything with a life of its own has left. The log is `log/log.ts`, and
 * every fact the log holds about the room is a fold over it in
 * `room/fold.ts`: the roster, the reserve, the people, the open exchange
 * and the closes. A seat, what wakes it and the seat's side of the wire is
 * `seat/seat.ts`, one activation is `seat/activation.ts`, the hands it
 * holds are `seat/hands.ts`, the assistant is `room/assistant.ts`, what an
 * activation reads is `room/view.ts`, and every sentence a participant
 * reads is `render.ts`. What is left is what only a room can do:
 *
 * - **Compose.** Write the composition, admit the people, seat and unseat
 *   while it runs, and take it all down again.
 * - **Commit.** One queue, one seq at a time, for every author (rule 5), and
 *   one `message` event per message however it was written.
 * - **Route.** Who hears a message, and who wakes for it.
 * - **Answer a seat.** The view an activation reads, the commit it asks for,
 *   and the lease it holds — the three calls in `wire.ts`. The room answers
 *   them from a lease table it keeps in memory. A lease ends when the seat
 *   side releases it; the room cuts an activation it ends, and the seat side
 *   releases the lease then. The expiry the room hands out is what the seat
 *   side renews against.
 * - **Say when it has stopped.** An exchange closed, with a row on the log,
 *   and nothing live.
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
import { RoomLog } from './log/log.ts';
import { renderLine } from './render.ts';
import { Assistant, assertAssistant, type Draft } from './room/assistant.ts';
import { foldRoom, type RoomState } from './room/fold.ts';
import { activationId, draftId, parseId, seatOf } from './room/lease.ts';
import type { VisitRuntime } from './room/presence.ts';
import { type RoomFacts, seatsOf, viewOf } from './room/view.ts';
import { inProcessTransport, SeatActor, wakes } from './seat/seat.ts';
import {
	type AgentDefinition,
	type AgentSeat,
	type Attention,
	authorOf,
	type ClosedExchange,
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
	CompositionRow,
	EndReason,
	Lease,
	LeaseResponse,
	SeatPort,
	SeatRow,
	ViewResponse,
	Without,
} from './wire.ts';

/** How long a lease runs between renewals. The seat side renews at half of it. */
const LEASE_EXPIRY = 60_000;

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

/** A presence change before the room stamps when it happened. */
type PresenceDraft = Omit<PresenceMessage, 'seq' | 'key' | 'at'>;

/** The exchange the room went quiet on, and the record as it stood then. */
interface Observed {
	from: Seq;
	through: Seq;
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

/** A read needs the log and nothing else: every identity it reports is on the log. */
class ReadOnlySession implements SessionView {
	private readonly log: RoomLog;

	constructor(
		readonly name: string,
		sessions: SessionOpener,
	) {
		this.log = new RoomLog(sessions.open(name));
	}

	async messages(options: { since?: Seq } = {}): Promise<Message[]> {
		await this.log.ready;
		return this.log.since(options.since);
	}

	/** The roster the log folds, and everybody the record knows. Nothing stands up. */
	seats(): SeatInfo[] {
		return seatsOf({ name: this.name, state: foldRoom(this.log.entries), live: new Set() });
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
	private readonly runtime: Runtime;
	/** How this room reaches a seat: what the runtime holds, or every seat as an actor in this process. */
	private readonly transport: Transport;
	private readonly log: RoomLog;
	/** The replay, the composition on the log, and the close of an exchange the last run left open. Every operation waits here. */
	private readonly ready: Promise<void>;
	/** Every definition this room can seat, by name. */
	private readonly defs = new Map<string, AgentDefinition>();
	/** The row this run writes about itself. Before the replay, `seats()` folds this row alone. */
	private readonly starting: Without<CompositionRow, 'after'>;
	/** The handles the host delivers through. Presence itself is a fold over the log. */
	private readonly visits = new Map<string, VisitRuntime>();
	/** The room's assistant: who is owed, and what it is drafting or composing. */
	private readonly assistant: Assistant;
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
	/** The settle in flight: the close row it writes, and whoever it wakes. A caller that asks waits for it. */
	private settling: Promise<void> = Promise.resolve();
	private fold: { length: number; state: RoomState } | undefined;
	/** The record is replayed and the composition is on the log: a seat's call is answered on the spot. */
	private replayed = false;
	private stopped = false;
	/**
	 * Whether a seat has worked since the room last settled. A failed draft
	 * waits for the seats to stop again, and a second settle at one quiescence
	 * — an aborted activation ending after an unseat closed the exchange, a
	 * question that woke nobody — is not the seats stopping again.
	 */
	private stirred = false;

	constructor(options: StartSessionOptions, runtime: Runtime) {
		const composition = composeFrom(options);
		this.name = options.name;
		this.runtime = runtime;
		this.transport = runtime.transport ?? inProcessTransport();
		this.sessions = options.repo ? sessionsOver(options.repo) : runtime.sessions;
		this.log = new RoomLog(this.sessions.open(this.name));
		this.stream = options.streamFn ?? runtime.stream;
		this.model = options.streamFn ? stubModel : runtime.model;
		this.assistant = new Assistant(composition.assistant.name);
		this.starting = compositionRow(composition, this.now());
		this.know(...composition.agents, ...composition.available, {
			def: composition.assistant,
			attention: 'none',
		});
		this.ready = this.compose();
		void this.ready.catch(() => {});
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
	 * the refusal. The row is what the roster folds from. An exchange the last
	 * run left open closes now: the seats that worked on it are gone with it.
	 */
	private async compose(): Promise<void> {
		await this.log.ready;
		const people = this.state().people;
		for (const name of this.defs.keys()) {
			if (people.has(name)) {
				throw new Error(`Duplicate agent name '${name}': one name names one participant.`);
			}
		}
		await this.log.write('composition', this.starting);
		this.replayed = true;
		if (this.state().exchange !== undefined) await this.settle();
	}

	/**
	 * A seat's call waits for the room to be up, and for nothing else once it
	 * is: a view taken in the same tick as the wake reads the record the wake
	 * was decided on, before anything lands on top of it.
	 */
	private async up(): Promise<void> {
		if (!this.replayed) await this.ready;
	}

	// -- what the room holds --------------------------------------------------

	/** The room's clock, as an ISO stamp for the record. */
	private now(): string {
		return new Date(this.runtime.clock.now()).toISOString();
	}

	/** Every fact the log holds about the room, folded over it as it stands. */
	private state(): RoomState {
		const length = this.log.entries.length;
		if (this.fold?.length !== length) this.fold = { length, state: foldRoom(this.log.entries) };
		return this.fold.state;
	}

	private get record(): readonly Message[] {
		return this.log.messages;
	}

	private onRoster(name: string, state = this.state()): boolean {
		return state.roster.some((seat) => seat.name === name);
	}

	private assertRunning(): void {
		if (this.stopped) throw new Error(`Session '${this.name}' is stopped.`);
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
		return this.state().exchange;
	}

	/**
	 * Both answers wait for the room to be up, then for every settle in
	 * flight: a run over a log with an exchange open closes it as it starts,
	 * and the close and whoever it wakes are on the record before either
	 * answers. A release that lands while one settle is awaited chains the
	 * next, and the answer waits for that one too.
	 */
	async settled(): Promise<void> {
		await this.up();
		await this.stilled();
		if (!this.working()) return;
		return new Promise((resolve) => this.settledWaiters.push(resolve));
	}

	async quiet(): Promise<void> {
		// The same condition the `quiet` event reports. A summary a race left
		// owed is not work in flight: it waits for the next quiet room, and the
		// room is quiet in the meantime.
		await this.up();
		await this.stilled();
		if (this.idle()) return;
		return new Promise((resolve) => this.quietWaiters.push(resolve));
	}

	/** Resolves once the settle chain stands still: nothing was chained while it was awaited. */
	private async stilled(): Promise<void> {
		let awaited: Promise<void>;
		do {
			awaited = this.settling;
			await awaited;
		} while (awaited !== this.settling);
	}

	/** Whether a seat is live: it holds a lease, or a wake was sent to it and not yet claimed. */
	private live(name: string): boolean {
		for (const held of this.leases.values()) if (held.seat === name) return true;
		for (const of of this.pending.values()) if (of === name) return true;
		return false;
	}

	/** The seats live now, on the roster. */
	private liveSeats(state = this.state()): Set<string> {
		return new Set(state.roster.map((seat) => seat.name).filter((name) => this.live(name)));
	}

	/** Nothing at all is live. The assistant writing is something. */
	private idle(): boolean {
		return this.liveSeats().size === 0;
	}

	/**
	 * Something that speaks for itself is live. The assistant drafting a
	 * summary does not count: a close must not hold open the exchange it is
	 * closing. The assistant composing the room does count: that is the
	 * exchange's own work, and the exchange stays open until it has decided.
	 */
	private working(): boolean {
		const composing = this.assistant.composing() !== undefined;
		return [...this.liveSeats()].some((name) => composing || !this.assistant.is(name));
	}

	/** Cut every activation in flight. Each seat side releases its lease, and the room hears how it ended. */
	abort(): void {
		for (const port of this.ports.values()) if (port instanceof SeatActor) port.abort();
	}

	async messages(options: { since?: Seq } = {}): Promise<Message[]> {
		await this.ready;
		return this.log.since(options.since);
	}

	/** The roster and the people off the fold. Before the replay, the fold is over the row this run writes. */
	seats(): SeatInfo[] {
		if (!this.replayed) {
			const composition = { ...this.starting, after: 0 };
			const state = foldRoom([{ type: 'composition', composition }]);
			return seatsOf({ name: this.name, state, live: new Set() });
		}
		const state = this.state();
		return seatsOf({ name: this.name, state, live: this.liveSeats(state) });
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
		// A person the log holds as present is here already: the last run wrote
		// no `left`, and the host's word is what says otherwise. Nothing commits.
		if (this.state().people.get(human.name)?.presence !== 'present') {
			await this.commitPresence({
				kind: 'arrived',
				from: human.name,
				identity: human.identity,
				...(human.preferences === undefined ? {} : { preferences: human.preferences }),
			});
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
		if (to !== undefined && !state.people.has(to) && !this.onRoster(to, state)) {
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
		if (this.assistant.is(agent.name)) {
			throw new Error(`'${agent.name}' is the assistant: a room cannot run without one.`);
		}
		this.retire(agent.name);
		await this.commitPresence({ kind: 'unseated', from: agent.name });
	}

	/**
	 * Off the roster: what was mid-flight is cut, and a wake it was sent and
	 * never claimed is forgotten. The lease it holds ends when the seat side
	 * releases it, and the roster changes when the `unseated` lands.
	 */
	private retire(name: string): void {
		const port = this.ports.get(name);
		if (port instanceof SeatActor) port.abort();
		for (const [id, of] of this.pending) if (of === name) this.pending.delete(id);
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
			for (const person of this.state().people.values()) {
				if (person.presence !== 'present') continue;
				const visit = this.visits.get(person.name);
				if (visit) visit.gone = true;
				await this.commitPresence({ kind: 'left', from: person.name }, false);
			}
		} finally {
			// The name comes free whatever the storage did. A failed write must
			// not leave a room that can never be started again.
			if (this.runtime.running.get(this.name) === this) this.runtime.running.delete(this.name);
			// A stopped room never goes quiet on its own, so nobody waits on it.
			for (const resolve of this.quietWaiters.splice(0)) resolve();
		}
	}

	// -- commits ----------------------------------------------------------------

	/**
	 * One operation on the room's commit queue: the write, and then what the
	 * room does with a fresh message, inside the same link of the queue. A
	 * repeated key lands nothing, so the room does nothing with it either.
	 */
	private commitMessage<T extends Message>(
		key: string,
		readThrough: Seq | undefined,
		draft: Omit<T, 'seq' | 'key'>,
		route = true,
	) {
		return this.log.commit<T>(
			{ key, ...(readThrough === undefined ? {} : { readThrough }), draft },
			(message) => (route ? this.committed(message) : this.emit({ type: 'message', message })),
		);
	}

	/** A presence change the room observed, under a fresh key: the room's own word, never a retry. */
	private commitPresence(change: PresenceDraft, route = true) {
		const draft = { ...change, at: this.now() };
		return this.commitMessage<PresenceMessage>(crypto.randomUUID(), undefined, draft, route);
	}

	/**
	 * What happens to every message once its write is confirmed: the host
	 * hears about it, then what it opened, and the room routes it. One
	 * message, one event, one order — stated here rather than at each of the
	 * commit sites.
	 */
	private committed(message: Message): void {
		// The message lands, then what it opened: an exchange is a fact about a
		// message the host has already seen. Both come before the routing, so
		// nothing wakes on a message the host has not heard about.
		this.emit({ type: 'message', message });
		this.noteExchange(message.seq);
		this.dispatch(message);
		// A question that wakes no seat has no seat to stop, so the exchange it
		// opened would never close. The same check an ending activation runs,
		// and the same last word: the room was quiet, and it says so.
		if (this.state().exchange !== undefined && !this.working()) void this.settle();
	}

	/**
	 * The question at `seq` opened an exchange, and the room says so. When the
	 * room holds agents in reserve, the assistant composes the room for it: it
	 * reads the question while the seats do, and seats who the question needs.
	 */
	private noteExchange(seq: Seq): void {
		const state = this.state();
		if (state.exchange?.from !== seq) return;
		this.emit({ type: 'exchange_opened', exchange: state.exchange });
		if (state.reserve.length === 0 || this.stopped) return;
		const assistant = this.assistant.name;
		// One seat, one activation per seq: a wake the question itself sent
		// to the assistant, live or ended, is the activation for this seq, and
		// the roster stands for the exchange.
		const id = activationId(seq, assistant);
		const taken = this.live(assistant) || this.spent.has(id);
		const composing = this.assistant.compose(
			state.exchange.owner,
			state.exchange.from,
			state.reserve.length,
			taken,
		);
		if (composing) this.activate(assistant, id);
	}

	// -- routing ----------------------------------------------------------------

	/**
	 * Route a committed message — the room's whole policy in one place, and
	 * the same for what a person said, what a person did, and what a colleague
	 * said. Every colleague still at work hears it as a steer (rule 2). What
	 * wakes an idle seat is the attention it was seated at, against the reach
	 * of the message (rules 1, 4 and 6, in `wakes`). The roster the routing
	 * reads folds the message itself, so a seating wakes the seat it seats.
	 */
	private dispatch(message: Message): void {
		// The author is excluded, and the seat a message names is its target. For
		// every kind but a seating the two are `from`; a seating is written by
		// `by`, or by nobody when the host did it, and names the seat in `from`.
		const author = authorOf(message);
		const target = targetOf(message);
		const fromAssistant = author !== undefined && this.assistant.is(author);
		for (const seat of this.state().roster) {
			if (seat.name !== author) this.route(seat, message, target, fromAssistant);
		}
	}

	/** One seat hears one message: steered in while it is live, or woken when it is at rest. */
	private route(
		seat: { name: string; attention: Attention },
		message: Message,
		target: string | undefined,
		fromAssistant: boolean,
	): void {
		const id = activationId(message.seq, seat.name);
		if (this.live(seat.name)) {
			if (!this.hearsSteers(seat.name)) return;
			this.send(id, seat.name, { seq: message.seq, line: renderLine(message) });
		} else if (wakes(seat, target, message, fromAssistant)) {
			this.activate(seat.name, id);
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
		const state = this.state();
		const def = this.defs.get(held.seat);
		if (def === undefined || !this.onRoster(held.seat, state)) {
			return stale('the seat left the roster');
		}
		return { view: viewOf(id, held.seat, def, this.facts(state)) };
	}

	/** What a view is built from: the fold, and what the room holds beside it. */
	private facts(state: RoomState): RoomFacts {
		return {
			name: this.name,
			now: this.runtime.clock.now(),
			assistant: this.assistant.name,
			state,
			live: this.liveSeats(state),
			drafting: this.assistant.closing(),
			unseen: (since) => this.log.since(since).length,
		};
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
		const committed = await this.commitMessage<Message>(commit.key, commit.readThrough, drafted);
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
		const state = this.state();
		if (intent.kind === 'said') {
			assertAddressable(seat, intent.to, state);
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
			at,
			from: held.name,
			identity: held.identity,
			by: seat,
			attention: held.attention,
		};
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
		if (seat === undefined || !this.onRoster(seat)) return stale('the seat is not on the roster');
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
		// A wake the seat side answered is pending no longer, however it is answered.
		this.pending.delete(id);
		if (this.spent.has(id)) return stale('the lease ended');
		this.leases.set(id, { seat, spoke: false });
		if (parseId(id)?.kind !== 'draft') this.stirred = true;
		this.emit({ type: 'activation_start', agent: seat });
		return ok;
	}

	private async release(id: string, reason: EndReason): Promise<LeaseResponse> {
		const held = this.leases.get(id);
		if (held === undefined) return stale('the lease ended');
		this.leases.delete(id);
		this.spent.add(id);
		await this.ended(held, reason);
		return { ok: { expiry: this.runtime.clock.now(), lastSeq: this.log.lastSeq } };
	}

	/** The seat stopped: what that closes, and what it frees. */
	private async ended(held: Held, reason: EndReason): Promise<void> {
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
		if (!drafted && !this.working()) {
			await this.settle();
			return;
		}
		if (assistant) this.draftNext(this.assistant.dueAfterDraft(...this.dueArgs()));
		this.markQuiet();
	}

	// -- the assistant ------------------------------------------------------------

	/**
	 * The seats stopped: the exchange open now closes at the record as it
	 * stands now, the room says it is quiet when it is, and whoever waited
	 * hears it after both. One settle at a time; a seat woken in the meantime
	 * keeps whoever waited waiting. The exchange and the range are taken
	 * here, when the quiet is observed: a question that lands before the
	 * close is written opens the next exchange, and a settle observed for one
	 * exchange never closes another.
	 */
	private settle(): Promise<void> {
		const state = this.state();
		const observed = state.exchange && { from: state.exchange.from, through: state.lastSeq };
		this.settling = this.settling.then(() => this.settleOnce(observed)).catch(() => {});
		return this.settling;
	}

	private async settleOnce(observed: Observed | undefined): Promise<void> {
		const worked = this.stirred;
		this.stirred = false;
		try {
			await this.closeExchange(observed, worked);
		} finally {
			// A close the storage refused leaves the exchange open, and the next
			// settle writes it again. The room still says what holds now, and
			// nobody waiting on it waits for a write that failed.
			this.markQuiet();
			if (!this.working()) for (const resolve of this.settledWaiters.splice(0)) resolve();
		}
	}

	/**
	 * The room went quiet on `observed`, so that exchange ends at the record
	 * as it stood: the close is a row on the log, written where the fold still
	 * says the same exchange is open. A stopped room writes no close; the next
	 * run over the log closes the exchange at its start. The host hears the
	 * close before anything is written about it: the assistant is the first
	 * reader of a closed exchange and not the only one.
	 */
	private async closeExchange(observed: Observed | undefined, worked: boolean): Promise<void> {
		let closing: ClosedExchange | undefined;
		await this.log.write('close', () => {
			const exchange = this.state().exchange;
			if (observed === undefined || exchange?.from !== observed.from || this.stopped) {
				return undefined;
			}
			closing = { ...exchange, through: observed.through };
			return {
				owner: exchange.owner,
				from: exchange.from,
				through: observed.through,
				at: this.now(),
			};
		});
		if (closing) this.emit({ type: 'exchange_closed', exchange: closing });
		// A question that landed after the quiet was observed opened the next
		// exchange the moment this one closed, and the room says so now, before
		// the assistant is woken for what the closed one owes. The same check
		// a commit runs follows: an exchange nobody works on closes at once.
		const next = this.state().exchange;
		if (closing && next !== undefined) {
			this.noteExchange(next.from);
			if (!this.working()) void this.settle();
		}
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
		return !this.state().people.has(name) && !this.assistant.is(name);
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

/** The composition as the row the log holds: every seat by name, identity and attention. */
function compositionRow(composition: Composition, at: string): Without<CompositionRow, 'after'> {
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
