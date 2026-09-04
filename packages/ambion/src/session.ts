/**
 * The room: the one place where a record, the seats around it, the people
 * visiting it and the exchanges they open become behaviour.
 *
 * Everything with a life of its own has left. The record is `record.ts`, who
 * is here is `presence.ts`, a seat and what wakes it is `seat.ts`, one
 * activation is `activation.ts`, an exchange is `exchange.ts`, the assistant is
 * `assistant.ts`, and every sentence a participant reads is `render.ts`. What is
 * left is what only a room can do:
 *
 * - **Compose.** Seat the agents and the assistant, hold the reserve, admit the
 *   people, seat and unseat while it runs, and take it all down again.
 * - **Commit.** One lock, one seq at a time, for every author (rule 5), and
 *   one `message` event per message however it was written.
 * - **Route.** Who hears a message, and who wakes for it.
 * - **Give an activation what only the room knows.** The model, the prompt, the
 *   hands, and the room as it stands at that moment.
 * - **Say when it has stopped.** An exchange closed, and nothing running.
 */
import type {
	AgentTool,
	Session as PiSession,
	SessionRepo,
	StreamFn,
} from '@earendil-works/pi-agent-core';
import { Agent, InMemorySessionRepo } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { Activation } from './activation.ts';
import {
	Assistant,
	assertAssistant,
	type Composing,
	type Draft,
	seatTool,
	summariseTool,
} from './assistant.ts';
import { seated } from './define.ts';
import { type ClosedExchange, type Exchange, Exchanges } from './exchange.ts';
import { Attendance, type VisitRuntime } from './presence.ts';
import { openOrCreate, persistTurns, RecordStore } from './record.ts';
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
import { isActive, type SayRoom, type SeatRuntime, sayTool, toPiTool, wakes } from './seat.ts';
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
	type Participant,
	type PresenceMessage,
	type SeatInfo,
	type Seq,
	type SessionEvent,
	type SpokenMessage,
	type SummaryMessage,
} from './types.ts';
import { builtinTools } from './workspace.ts';

const defaultRepo = new InMemorySessionRepo();

/** One run per name: a second live room over one record would diverge from it. */
const running = new Map<string, SessionImpl>();

/** An agent held in reserve: the definition, and the attention it takes when seated. */
interface Reserved {
	def: AgentDefinition;
	attention: Attention;
}

/** Pi's model registry, built once on first use. */
let builtinRegistry: ReturnType<typeof builtinModels> | undefined;
const registry = () => (builtinRegistry ??= builtinModels());

/** The default model call: Pi's builtin registry, keyed from the provider's env var. */
const registryStream: StreamFn = (model, context, streamOptions) => {
	const envKey = process.env[`${model.provider.toUpperCase().replace(/-/g, '_')}_API_KEY`];
	const resolved =
		streamOptions?.apiKey || !envKey ? streamOptions : { ...streamOptions, apiKey: envKey };
	return registry().streamSimple(model, context, resolved);
};

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
	 * brings custom providers.
	 */
	streamFn?: StreamFn;
	/** Pi's own session repository. Defaults to a process-wide `InMemorySessionRepo`. */
	repo?: SessionRepo;
}

export interface ReadSessionOptions {
	repo?: SessionRepo;
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
	/** Resolves when no agent is active and nothing is queued. */
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
	deliver(input: { to?: Participant; text: string }): Promise<void>;
	leave(): Promise<void>;
}

/** Sets up the context where the agents work. */
export function startSession(options: StartSessionOptions): Session {
	if (running.has(options.name)) {
		throw new Error(
			`Session '${options.name}' is already running: stop it before starting it again.`,
		);
	}
	const session = new SessionImpl(options);
	running.set(options.name, session);
	return session;
}

/** Takes the room down: activations aborted, visits closed, timers cleared, writes drained. */
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
	return running.get(name) ?? new ReadOnlySession(name, options.repo ?? defaultRepo);
}

class ReadOnlySession implements SessionView {
	private readonly store: RecordStore;
	private readonly here: Attendance;

	constructor(
		readonly name: string,
		repo: SessionRepo,
	) {
		this.store = new RecordStore(repo, name);
		this.here = new Attendance(() => this.store.entries);
	}

	async messages(options: { since?: Seq } = {}): Promise<Message[]> {
		await this.store.ready;
		return this.store.since(options.since);
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

// -- the room ----------------------------------------------------------------

class SessionImpl implements Session {
	readonly name: string;
	private readonly goal?: string;
	private readonly repo: SessionRepo;
	private readonly store: RecordStore;
	private readonly agents = new Map<string, SeatRuntime>();
	/** The reserve: agents the room may seat later, held with the attention they will take. */
	private readonly reserve = new Map<string, Reserved>();
	/** The room's assistant: how each person reads, who is owed, what it is drafting or composing. */
	private readonly assistant: Assistant;
	private readonly here = new Attendance(() => this.record);
	private readonly listeners = new Set<(event: SessionEvent) => void>();
	private readonly settledWaiters: (() => void)[] = [];
	private readonly quietWaiters: (() => void)[] = [];
	private readonly streamFn: StreamFn;
	private readonly customStream: boolean;
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

	constructor(options: StartSessionOptions) {
		this.name = options.name;
		this.goal = options.goal?.trim() || undefined;
		this.repo = options.repo ?? defaultRepo;
		this.store = new RecordStore(this.repo, this.name);
		for (const seat of options.agents ?? []) this.place(seat);
		// Seated at the narrow end: nothing said in the room wakes the assistant;
		// the open and the close of an exchange do, and it is here for the whole run.
		this.assistant = new Assistant(this.place(seated(assertAssistant(options.assistant), 'none')));
		for (const seat of options.available ?? []) this.hold(seat);
		this.customStream = options.streamFn !== undefined;
		this.streamFn = options.streamFn ?? registryStream;
	}

	private get record(): Message[] {
		return this.store.entries;
	}

	/** Seat one agent, refusing a name the room already knows. */
	private place(seat: AgentSeat): SeatRuntime {
		const { def, attention } = this.unwrap(seat);
		this.assertFreeName(def.name);
		const placed: SeatRuntime = { def, attention };
		this.agents.set(def.name, placed);
		return placed;
	}

	/** Hold one agent in reserve, refusing a name the room already knows. */
	private hold(seat: AgentSeat): void {
		const held = this.unwrap(seat);
		this.assertFreeName(held.def.name);
		this.reserve.set(held.def.name, held);
	}

	private unwrap(seat: AgentSeat): Reserved {
		const def = isSeatedAgent(seat) ? seat.agent : seat;
		if (!isAgent(def)) {
			throw new Error('Agents must come from defineAgent or seated().');
		}
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
		await this.store.ready;
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
		await this.store.ready;
		const seat = this.agents.get(agent.name);
		if (!seat) throw new Error(`'${agent.name}' is not seated in this session.`);
		if (this.assistant.is(agent.name)) {
			throw new Error(`'${agent.name}' is the assistant: a room cannot run without one.`);
		}
		this.retire(seat);
		await this.commitPresence({ kind: 'unseated', from: agent.name });
	}

	/** Off the roster: what was mid-flight ends, and a reserve agent goes back to the reserve. */
	private retire(seat: SeatRuntime): void {
		seat.activation?.abort();
		this.agents.delete(seat.def.name);
		if (seat.reserved)
			this.reserve.set(seat.def.name, { def: seat.def, attention: seat.attention });
	}

	/** The assistant seats one name from the reserve. The roster changes before the message lands. */
	private admit(name: string): void {
		const held = this.reserve.get(name);
		if (!held) throw new Error(`'${name}' is not in the reserve.`);
		this.reserve.delete(name);
		const placed = this.place(seated(held.def, held.attention));
		placed.added = true;
		placed.reserved = true;
	}

	/**
	 * The seat's downstream Pi session, `<room>:<agent>`, parented to the
	 * room's — where every activation's full turns land, so hands stay
	 * auditable after the fact even though working views reset at idle.
	 */
	private seatSession(seat: SeatRuntime): Promise<PiSession> {
		seat.piSeat ??= (async () => {
			await this.store.ready;
			return openOrCreate(this.repo, `${this.name}:${seat.def.name}`, this.name);
		})();
		return seat.piSeat;
	}

	subscribe(listener: (event: SessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	exchange(): Exchange | undefined {
		return this.exchanges.current();
	}

	settled(): Promise<void> {
		if (!this.working()) return Promise.resolve();
		return new Promise((resolve) => this.settledWaiters.push(resolve));
	}

	/**
	 * What is running. One fact, kept in one place: a seat holds its own
	 * activation, so nothing counts them alongside and nothing can drift.
	 */
	private running(): SeatRuntime[] {
		return [...this.agents.values()].filter(isActive);
	}

	/** Nothing at all is taking an activation. The assistant writing is something. */
	private idle(): boolean {
		return this.running().length === 0;
	}

	/**
	 * Something that speaks for itself is taking one. The assistant drafting a
	 * summary does not count: a close must not hold open the exchange it is
	 * closing. The assistant composing the room does count: that is the
	 * exchange's own work, and the exchange stays open until it has decided.
	 */
	private working(): boolean {
		const composing = this.assistant.composing() !== undefined;
		return this.running().some((seat) => composing || !this.assistant.is(seat.def.name));
	}

	quiet(): Promise<void> {
		// The same condition the `quiet` event reports. A summary a race left
		// owed is not work in flight: it waits for the next quiet room, and the
		// room is quiet in the meantime.
		if (this.idle()) return Promise.resolve();
		return new Promise((resolve) => this.quietWaiters.push(resolve));
	}

	abort(): void {
		for (const seat of this.agents.values()) seat.activation?.abort();
	}

	async messages(options: { since?: Seq } = {}): Promise<Message[]> {
		await this.store.ready;
		return this.store.since(options.since);
	}

	seats(): SeatInfo[] {
		const seats: SeatInfo[] = [];
		for (const seat of this.agents.values()) {
			seats.push({
				kind: 'agent',
				name: seat.def.name,
				identity: seat.def.identity,
				status: isActive(seat) ? 'active' : 'idle',
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

	/** Puts a person in the room. A second visit while they are here is the same visit. */
	async visit(human: HumanDefinition): Promise<Visit> {
		this.assertRunning();
		this.assertVisitable(human);
		await this.store.ready;
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

	private async commitPresence(change: Omit<PresenceMessage, 'seq' | 'at'>): Promise<void> {
		await this.publish(this.store.append<PresenceMessage>(change));
	}

	/**
	 * What happens to every message once it holds a seq: it persists, the host
	 * hears about it, and the room routes it. One message, one event, one
	 * order — stated here rather than at each of the commit sites.
	 */
	private async publish(message: Message): Promise<void> {
		await this.store.drained();
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
		const composing = this.assistant.compose(opened.owner, opened.from, this.reserve.size);
		if (composing) this.activate(this.assistant.seat);
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

	/** Closes the run: what is mid-flight ends, what is present is marked gone. */
	async stop(): Promise<void> {
		if (this.stopped) return;
		// Stopped from here on: a visit that arrives during the shutdown is
		// refused rather than seated into a room that is going away.
		this.stopped = true;
		try {
			this.abort();
			await this.store.ready;
			// A deliberate shutdown observed everybody leaving, so the record
			// says so, and the host hears it. It wakes nobody: an activation
			// started to hear that the room is closing is an activation nobody reads.
			for (const visit of this.here.all()) {
				visit.gone = true;
				this.here.leave(visit.human.name);
				this.commitUnrouted({ kind: 'left', from: visit.human.name });
			}
			// What the run added leaves with it, the same way: the next run begins
			// from the composition `startSession` was given.
			for (const seat of this.agents.values()) {
				if (!seat.added) continue;
				this.retire(seat);
				this.commitUnrouted({ kind: 'unseated', from: seat.def.name });
			}
			await this.store.drained();
		} finally {
			// The name comes free whatever the repo did. A failed write must
			// not leave a room that can never be started again.
			if (running.get(this.name) === this) running.delete(this.name);
			// A stopped room never goes quiet on its own, so nobody waits on it.
			for (const resolve of this.quietWaiters.splice(0)) resolve();
		}
	}

	/** A presence change the closing room commits and routes to nobody: an activation nobody reads. */
	private commitUnrouted(change: Omit<PresenceMessage, 'seq' | 'at'>): void {
		this.emit({ type: 'message', message: this.store.append<PresenceMessage>(change) });
	}

	// -- messages ------------------------------------------------------------

	private async deliverFrom(
		from: string,
		input: { to?: Participant; text: string },
	): Promise<void> {
		const to = input.to?.name;
		if (to !== undefined && !this.here.knows(to) && !this.agents.has(to)) {
			throw new Error(`Cannot direct a delivery to '${to}': not in this session.`);
		}
		await this.publish(
			this.store.append<SpokenMessage>({
				kind: 'said',
				from,
				...(to === undefined ? {} : { to }),
				text: input.text,
			}),
		);
	}

	private emit(event: SessionEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// A listener's failure is the listener's problem, never the room's.
			}
		}
	}

	/**
	 * Route a committed message — the room's whole policy in one place, and
	 * the same for what a person said, what a person did, and what a colleague
	 * said. Every colleague still at work hears it as a steer (rule 2). What
	 * wakes an idle seat is the attention it was seated at, against the reach
	 * of the message (rules 1, 4 and 6, in `wakes` below).
	 */
	private dispatch(message: Message): void {
		// The author is excluded, and the seat a message names is its target. For
		// every kind but a seating the two are `from`; a seating is written by
		// `by`, or by nobody when the host did it, and names the seat in `from`.
		const author = authorOf(message);
		const target = this.targetOf(message);
		const fromAssistant = author !== undefined && this.assistant.is(author);
		for (const seat of this.agents.values()) {
			if (seat.def.name !== author) this.route(seat, message, target, fromAssistant);
		}
	}

	/** One seat hears one message: steered in while it works, or woken when it is at rest. */
	private route(
		seat: SeatRuntime,
		message: Message,
		target: SeatRuntime | undefined,
		fromAssistant: boolean,
	): void {
		if (seat.activation) {
			if (this.hearsSteers(seat)) seat.activation.steer(message, renderLine(message));
		} else if (wakes(seat, target, message, fromAssistant)) {
			this.activate(seat);
		}
	}

	/**
	 * A composing activation decides on the question as it was asked, and what
	 * the seats say while it decides is theirs to say: steering it in would
	 * hand the assistant answers to weigh and no hand to weigh them with.
	 */
	private hearsSteers(seat: SeatRuntime): boolean {
		return !(this.assistant.is(seat.def.name) && this.assistant.composing() !== undefined);
	}

	/** The seat a message names: a directed say names who it addresses, a seating names who it seats. */
	private targetOf(message: Message): SeatRuntime | undefined {
		if (isSpoken(message))
			return message.to === undefined ? undefined : this.agents.get(message.to);
		return message.kind === 'seated' ? this.agents.get(message.from) : undefined;
	}

	private activate(seat: SeatRuntime): void {
		const activation = new Activation(seat.def.name, this.store.lastSeq, {
			open: (running) => this.open(seat, running),
			persist: (agent) => persistTurns(this.seatSession(seat), agent),
			emit: (event) => this.emit(event),
		});
		// The seat holding it is what makes the room busy: there is no count to
		// keep in step, and so none to drift.
		seat.activation = activation;
		if (this.closingOf(seat) === undefined) this.stirred = true;
		this.emit({ type: 'activation_start', agent: seat.def.name });
		// The assistant's activations are one pass: a summary answers a room that
		// moved with a redraft inside its own tool, and a composition decides on
		// the question as it was asked.
		const rebuilds = !this.assistant.is(seat.def.name);
		void activation
			.run(rebuilds, () => this.store.lastSeq)
			.finally(() => this.ended(seat, activation));
	}

	/** The seat stopped: what that closes, and what it frees. */
	private ended(seat: SeatRuntime, activation: Activation): void {
		seat.activation = undefined;
		const assistant = this.assistant.is(seat.def.name);
		const drafted = assistant && this.assistant.composing() === undefined;
		if (assistant) {
			this.assistant.activationEnded({ wrote: activation.spoke, failed: activation.failed });
		}
		this.emit({ type: 'activation_end', agent: seat.def.name, spoke: activation.spoke });
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

	/** The seats stopped: whoever waited hears it, and the exchange closes. */
	private settle(): void {
		for (const resolve of this.settledWaiters.splice(0)) resolve();
		const worked = this.stirred;
		this.stirred = false;
		this.closeExchange(worked);
	}

	/** The range the assistant is closing, when this seat is the assistant and it is closing one. */
	private closingOf(seat: SeatRuntime): Draft | undefined {
		return this.assistant.is(seat.def.name) ? this.assistant.closing() : undefined;
	}

	/**
	 * What the prose is given of the seat taking this activation. The assistant
	 * holds every fact here; a seat holds none of them.
	 */
	private speaking(seat: SeatRuntime): SeatSpeaking {
		const assistant = this.assistant.is(seat.def.name);
		const draft = this.closingOf(seat);
		const closing: Closing | undefined = draft && {
			person: draft.person,
			preferences: this.assistant.preferencesOf(draft.person),
			from: draft.from,
			through: draft.through,
		};
		const composition = assistant ? this.assistant.composing() : undefined;
		const composing: ComposingView | undefined = composition && {
			person: composition.person,
			from: composition.from,
			reserve: this.reserved(),
		};
		return { def: seat.def, assistant, closing, composing };
	}

	/** The reserve as the assistant reads it: a name and an identity per agent. */
	private reserved(): { name: string; identity: string }[] {
		return [...this.reserve.values()].map(({ def }) => ({
			name: def.name,
			identity: def.identity,
		}));
	}

	/** What the prose is given of this room, built fresh for each activation. */
	private view(): RoomView {
		const open = this.exchanges.current();
		return {
			name: this.name,
			goal: this.goal,
			seats: this.seats(),
			people: this.peopleViews(),
			record: this.record,
			exchange: open && { owner: open.owner, from: open.from },
		};
	}

	/**
	 * What an activation is given: the model it runs on, the prompt it is addressed
	 * by, the hands it holds, and the room as it stands right now. Only the
	 * room knows any of that, and it builds them fresh for every pass.
	 */
	private open(seat: SeatRuntime, activation: Activation): { agent: Agent; context: string } {
		const speaking = this.speaking(seat);
		const view = this.view();
		const agent = new Agent({
			streamFn: this.streamFn,
			initialState: {
				systemPrompt: renderSystemPrompt(speaking, view),
				model: this.resolveModel(seat.def),
				thinkingLevel: 'off',
				tools: this.handsFor(seat, activation),
				messages: [],
			},
		});
		return { agent, context: renderTurnContext(speaking, view) };
	}

	/**
	 * What an activation holds. A seat speaks, reaches its workspace through the
	 * four built-in tools when it names one, and uses its own tools; the assistant
	 * closing an exchange holds one hand, and it reaches the record. `startSession`
	 * refuses an assistant that carries tools or a workspace of its own, so there
	 * is nothing else to leave out.
	 */
	private handsFor(seat: SeatRuntime, activation: Activation): AgentTool[] {
		// The assistant's hands are the runtime's, and it holds one for the
		// activation it was woken for: `seat` at an open, `summarise` at a close.
		// Nothing else wakes the assistant today; when something does — a wider
		// attention, per planning/backlog.md — it must arrive with empty hands until
		// somebody adds a `say` here on purpose. assistant.md §12 makes that a
		// deliberate decision.
		if (this.assistant.is(seat.def.name)) {
			const composing = this.assistant.composing();
			if (composing) return [this.seatHand(seat, activation, composing)];
			const closing = this.assistant.closing();
			return closing ? [this.summarise(seat, activation, closing)] : [];
		}
		return [
			sayTool(seat, activation, this.sayRoom(seat)),
			...builtinTools(seat.def),
			...seat.def.tools.map((tool) => toPiTool(tool, seat.def)),
		];
	}

	/** The one hand the assistant is given at an open, bound to the reserve. */
	private seatHand(seat: SeatRuntime, activation: Activation, composing: Composing): AgentTool {
		return seatTool(seat.def.name, composing, {
			stopped: () => this.stopped,
			reserve: () => this.reserved(),
			seat: (name) => this.admit(name),
			commit: (draft) => this.store.append<PresenceMessage>(draft),
			publish: (message) => this.publish(message),
			written: () => {
				activation.spoke = true;
			},
		});
	}

	/** The one hand the assistant is given, bound to the range it must stand for. */
	private summarise(seat: SeatRuntime, activation: Activation, closing: Draft): AgentTool {
		return summariseTool(seat.def.name, closing, {
			stopped: () => this.stopped,
			lastSeq: () => this.store.lastSeq,
			claim: (author, draft) => this.claim<SummaryMessage>(author, draft),
			publish: (message) => this.publish(message),
			written: () => {
				activation.spoke = true;
			},
		});
	}

	/** What the say tool is given of the room: the lock, the roster, and the record. */
	private sayRoom(seat: SeatRuntime): SayRoom {
		return {
			lastSeq: () => this.store.lastSeq,
			missed: (readThrough) => this.refuse(seat.def.name, readThrough),
			addressable: (to) => this.assertAddressable(seat, to),
			commit: (draft) => this.store.append<SpokenMessage>(draft),
			publish: (message) => this.publish(message),
		};
	}

	/**
	 * Rule 5's refusal, as the host hears it: what an author has not read, and
	 * a `conflict` event when there is anything. A say and a summary are refused
	 * at the same boundary, which is why the event names the author.
	 */
	private refuse(author: string, readThrough: Seq): Message[] {
		const missed = this.store.missed(readThrough);
		if (missed.length > 0) this.emit({ type: 'conflict', author, missed });
		return missed;
	}

	private assertAddressable(seat: SeatRuntime, to: string | undefined): void {
		if (to === undefined) return;
		const target = this.agents.get(to);
		if (!this.here.knows(to) && !target) {
			throw new Error(`Unknown participant '${to}'. Address someone from the roster.`);
		}
		if (to === seat.def.name) throw new Error('You cannot address yourself.');
		// A seat at the narrow end wakes for nothing said, so addressing it
		// would leave a message nobody reads. Say it to the room instead.
		if (target?.attention === 'none') {
			throw new Error(`'${to}' wakes for nothing said. Say it to the room, or to somebody else.`);
		}
	}

	/**
	 * Rule 5 for a summary: the record's own lock, and the host hears the
	 * refusal the way it hears a refused say.
	 */
	private claim<T extends Message>(
		author: { name: string; readThrough: Seq },
		draft: Omit<T, 'seq' | 'at'>,
	): { message: T } | { missed: Message[] } {
		const claimed = this.store.claim<T>(author.readThrough, draft);
		if ('missed' in claimed) {
			this.emit({ type: 'conflict', author: author.name, missed: claimed.missed });
		}
		return claimed;
	}

	// -- the assistant ------------------------------------------------------------

	/**
	 * The room went quiet, so the exchange it was working on is over. The host
	 * hears that before anything is written about it: the assistant is the first
	 * reader of a closed exchange and not the only one.
	 */
	private closeExchange(worked: boolean): void {
		const closing = this.exchanges.close(this.store.lastSeq);
		if (closing) this.emit({ type: 'exchange_closed', exchange: closing });
		this.summariseClosed(closing, worked);
	}

	/**
	 * What the assistant makes of a closed exchange: its owner is owed the one
	 * message that stands for it, and the room activates the assistant for it.
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

	/** What the assistant reads to decide whether a range needs a message. */
	private dueArgs(): [readonly Message[], Seq, (name: string) => boolean] {
		return [this.record, this.store.lastSeq, (name) => this.speaksForItself(name)];
	}

	/** The assistant takes the draft it is due, unless the room is closing. */
	private draftNext(draft: Draft | undefined): void {
		if (draft === undefined || this.stopped) return;
		this.activate(this.assistant.seat);
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
	 * The room is quiet: no seat is taking an activation, and the assistant owes nobody.
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

	// -- what an agent reads -------------------------------------------------

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
				unseen: since === undefined ? 0 : this.store.since(since).length,
			});
		}
		return views;
	}

	private resolveModel(def: AgentDefinition): Model<Api> {
		if (this.customStream) {
			// A custom streamFn never reads the model; a stub keeps Pi's loop satisfied.
			return {
				id: def.model,
				name: def.model,
				api: 'scripted',
				provider: 'scripted',
			} as unknown as Model<Api>;
		}
		const slash = def.model.indexOf('/');
		if (slash > 0) {
			const model = registry().getModel(def.model.slice(0, slash), def.model.slice(slash + 1));
			if (model) return model;
		}
		throw new Error(
			`Unknown model '${def.model}' for agent '${def.name}': expected 'provider/model-id'.`,
		);
	}
}
