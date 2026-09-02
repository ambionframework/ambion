/**
 * The room: the one place where a record, the seats around it, the people
 * visiting it and the exchanges they open become behaviour.
 *
 * Everything with a life of its own has left. The record is `record.ts`, who
 * is here is `presence.ts`, a seat and what wakes it is `seat.ts`, one
 * activation is `activation.ts`, an exchange is `exchange.ts`, a person's assistant is
 * `assistant.ts`, and every sentence a participant reads is `render.ts`. What is
 * left is what only a room can do:
 *
 * - **Compose.** Seat the agents, admit the people, bring the assistants they
 *   bring, and take it all down again.
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
import { Type } from 'typebox';
import { Activation } from './activation.ts';
import { Assistants, type Draft, summariseTool } from './assistant.ts';
import { seated } from './define.ts';
import { type ClosedExchange, type Exchange, Exchanges } from './exchange.ts';
import { Attendance, type VisitRuntime } from './presence.ts';
import { openOrCreate, persistTurns, RecordStore } from './record.ts';
import {
	type PersonView,
	type RoomView,
	refusal,
	renderLine,
	renderSystemPrompt,
	renderTurnContext,
	type SeatSpeaking,
} from './render.ts';
import { delivered, isActive, type SeatRuntime, toPiTool, wakes } from './seat.ts';
import {
	type AgentDefinition,
	type AgentSeat,
	type HumanDefinition,
	isAgent,
	isSeatedAgent,
	isSpoken,
	type Message,
	type Participant,
	type PresenceChange,
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
	agents: readonly AgentSeat[];
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
	/** The assistants in this room: who writes for whom, who is owed, who is drafting. */
	private readonly assistants = new Assistants();
	private readonly here = new Attendance(() => this.record);
	private readonly listeners = new Set<(event: SessionEvent) => void>();
	private readonly settledWaiters: (() => void)[] = [];
	private readonly quietWaiters: (() => void)[] = [];
	private readonly streamFn: StreamFn;
	private readonly customStream: boolean;
	private stopped = false;
	/** The room's exchanges: what a question opened, and what quiescence closes. */
	private readonly exchanges = new Exchanges();

	constructor(options: StartSessionOptions) {
		this.name = options.name;
		this.goal = options.goal?.trim() || undefined;
		this.repo = options.repo ?? defaultRepo;
		this.store = new RecordStore(this.repo, this.name);
		for (const seat of options.agents) this.seat(seat);
		this.customStream = options.streamFn !== undefined;
		this.streamFn = options.streamFn ?? registryStream;
	}

	private get record(): Message[] {
		return this.store.entries;
	}

	/** Seat one agent, refusing a name the room already knows. */
	private seat(seat: AgentSeat): SeatRuntime {
		const def = isSeatedAgent(seat) ? seat.agent : seat;
		if (!isAgent(def)) {
			throw new Error('Agents must come from defineAgent or seated().');
		}
		if (this.agents.has(def.name) || this.here.knows(def.name)) {
			throw new Error(`Duplicate agent name '${def.name}': one name names one participant.`);
		}
		const seated: SeatRuntime = {
			def,
			attention: isSeatedAgent(seat) ? seat.attention : 'broadcast',
		};
		this.agents.set(def.name, seated);
		return seated;
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

	/** Nothing at all is taking an activation. An assistant writing is something. */
	private idle(): boolean {
		return this.running().length === 0;
	}

	/** Something that speaks for itself is taking one. An assistant does not. */
	private working(): boolean {
		return this.running().some((seat) => !this.assistants.isAssistant(seat.def.name));
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
			const owner = this.assistants.ownerOf(seat.def.name);
			seats.push({
				kind: 'agent',
				name: seat.def.name,
				identity: seat.def.identity,
				status: isActive(seat) ? 'active' : 'idle',
				attention: seat.attention,
				sessionId: `${this.name}:${seat.def.name}`,
				...(owner === undefined ? {} : { owner }),
			});
		}
		for (const [name, identity] of this.here.known()) {
			const assistant = this.assistants.forPerson(name)?.def.name;
			seats.push({
				kind: 'human',
				name,
				identity,
				presence: this.here.presenceOf(name),
				...(assistant === undefined ? {} : { assistant }),
			});
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
		this.bringAssistant(human);
		await this.commitPresence(human.name, 'arrived', human.identity);
		return this.handle(visit);
	}

	/**
	 * An assistant joins the room with its person and stays for the run: it outlives
	 * their visit by one exchange, because an exchange that opened is finished
	 * properly or not at all.
	 */
	private bringAssistant(human: HumanDefinition): void {
		if (this.assistants.has(human.name)) return;
		// Seated at the narrow end: nothing said in the room wakes an assistant;
		// only the close of its person's exchange does.
		this.assistants.bring(this.seat(seated(human.assistant, 'none')), human.name);
	}

	private assertVisitable(human: HumanDefinition): void {
		if (this.agents.has(human.name)) {
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

	private async commitPresence(
		name: string,
		kind: PresenceChange,
		identity?: string,
	): Promise<void> {
		await this.publish(
			this.store.append<PresenceMessage>({
				kind,
				at: new Date().toISOString(),
				from: name,
				...(identity === undefined ? {} : { identity }),
			}),
		);
	}

	/**
	 * What happens to every message once it holds a seq: it persists, the host
	 * hears about it, and the room routes it. One message, one event, one
	 * order — stated here rather than at each of the three commit sites.
	 */
	private async publish(message: Message): Promise<void> {
		await this.store.drained();
		// The message lands, then what it opened: an exchange is a fact about a
		// message the host has already seen. Both come before the routing, so
		// nothing wakes on a message the host has not heard about.
		this.emit({ type: 'message', message });
		this.noteExchange(message);
		this.dispatch(message);
	}

	/** A person's question opens an exchange, and the room says so. */
	private noteExchange(message: Message): void {
		const opened = this.exchanges.note(message, this.here.knows(message.from));
		if (opened) this.emit({ type: 'exchange_opened', exchange: opened });
	}

	private assertLive(visit: VisitRuntime): void {
		if (visit.gone) throw new Error(`${visit.human.name}'s visit has ended.`);
	}

	private async endVisit(visit: VisitRuntime): Promise<void> {
		if (visit.gone) return;
		visit.gone = true;
		this.here.leave(visit.human.name);
		await this.commitPresence(visit.human.name, 'left');
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
				this.emit({
					type: 'message',
					message: this.store.append<PresenceMessage>({
						kind: 'left',
						at: new Date().toISOString(),
						from: visit.human.name,
					}),
				});
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
				at: new Date().toISOString(),
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
		const to = isSpoken(message) ? message.to : undefined;
		const target = to === undefined ? undefined : this.agents.get(to);
		const fromAssistant = this.assistants.isAssistant(message.from);
		for (const seat of this.agents.values()) {
			if (seat.def.name === message.from) continue;
			if (seat.activation) seat.activation.steer(message, renderLine(message));
			else if (wakes(seat, target, message, fromAssistant)) this.activate(seat);
		}
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
		this.emit({ type: 'activation_start', agent: seat.def.name });
		// A summarising activation is one pass: it answers a room that moved with
		// a redraft inside its own tool rather than a fresh activation.
		const rebuilds = this.assistants.draftOf(seat.def.name) === undefined;
		void activation
			.run(rebuilds, () => this.store.lastSeq)
			.finally(() => {
				seat.activation = undefined;
				this.assistants.activationEnded(seat, {
					wrote: activation.spoke,
					failed: activation.failed,
				});
				this.emit({ type: 'activation_end', agent: seat.def.name, spoke: activation.spoke });
				// An exchange ends when the seats stop. An assistant writing about one
				// is not the room still working on it, so its own activation ends
				// none — which also keeps a failing assistant from retrying for ever.
				if (!this.assistants.isAssistant(seat.def.name) && !this.working()) {
					for (const resolve of this.settledWaiters.splice(0)) resolve();
					this.closeExchange();
				}
				if (this.idle()) this.markQuiet();
			});
	}

	/**
	 * What the prose is given of the seat taking this activation. The assistants hold both
	 * facts; a seat holds neither.
	 */
	private speaking(seat: SeatRuntime): SeatSpeaking {
		return {
			def: seat.def,
			owner: this.assistants.ownerOf(seat.def.name),
			closing: this.assistants.draftOf(seat.def.name),
		};
	}

	/** What the prose is given of this room, built fresh for each activation. */
	private view(): RoomView {
		return {
			name: this.name,
			goal: this.goal,
			seats: this.seats(),
			people: this.peopleViews(),
			record: this.record,
			hasAssistants: this.assistants.size > 0,
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
	 * four built-in tools when it names one, and uses its own tools; an assistant
	 * closing an exchange holds one hand, and it reaches the record. `defineHuman`
	 * refuses an assistant that carries tools or a workspace of its own, so there
	 * is nothing else to leave out.
	 */
	private handsFor(seat: SeatRuntime, activation: Activation): AgentTool[] {
		// An assistant's hands are the runtime's, and it holds them only for the activation
		// it was woken for. Nothing wakes an assistant today but the close of its
		// person's exchange; when something else does — a wider attention, per
		// FOLLOW_WORK.md — it must arrive with empty hands until somebody adds a
		// `say` here on purpose. assistant.md §12 makes that a deliberate decision.
		const owner = this.assistants.ownerOf(seat.def.name);
		if (owner !== undefined) {
			const closing = this.assistants.draftOf(seat.def.name);
			return closing ? [this.summarise(seat, activation, owner, closing)] : [];
		}
		return [
			this.sayTool(seat, activation),
			...builtinTools(seat.def),
			...seat.def.tools.map((tool) => toPiTool(tool, seat.def)),
		];
	}

	/** The one hand an assistant is given, bound to the range it must stand for. */
	private summarise(
		seat: SeatRuntime,
		activation: Activation,
		person: string,
		closing: Draft,
	): AgentTool {
		return summariseTool(seat.def.name, person, closing, {
			stopped: () => this.stopped,
			lastSeq: () => this.store.lastSeq,
			claim: (author, draft) => this.claim<SummaryMessage>(author, draft),
			publish: (message) => this.publish(message),
			written: () => {
				activation.spoke = true;
			},
		});
	}

	private sayTool(seat: SeatRuntime, activation: Activation): AgentTool {
		return {
			name: 'say',
			label: 'say',
			description:
				'Speak on the record. Omit `to` to address the room; set `to` to a participant name ' +
				'to address them directly — a directed say to an agent also calls them in. ' +
				'Ending your turn without calling say is declining to speak.',
			parameters: Type.Object({
				to: Type.Optional(Type.String({ description: 'A participant name from the roster.' })),
				text: Type.String(),
			}),
			execute: async (_toolCallId, rawParams) => {
				const params = rawParams as { to?: string; text: string };
				const to = params.to?.trim() ? params.to.trim() : undefined;
				this.assertAddressable(seat, to);
				const text = params.text.trim();
				// A message with nothing in it still takes a seq, renders in
				// every context after it, and stands inside whatever range a
				// summary covers. Saying nothing is ending the activation.
				if (text === '') {
					throw new Error('The message is empty. Say something, or end your turn instead.');
				}
				const claimed = this.claim<SpokenMessage>(
					{ name: seat.def.name, readThrough: activation.readThrough },
					{
						kind: 'said',
						at: new Date().toISOString(),
						from: seat.def.name,
						...(to === undefined ? {} : { to }),
						text,
					},
				);
				if ('missed' in claimed) {
					// Refused, and now heard: the seat decides again against the record as it stands.
					activation.heard(this.store.lastSeq);
					throw new Error(
						refusal(
							'Not delivered — the room moved while you were speaking. New on the record:',
							claimed.missed,
							'Speak again only if your reply still adds something the room has not heard; otherwise end your turn.',
						),
					);
				}
				// The seat has heard its own say before anybody else hears of it.
				activation.heard(claimed.message.seq);
				activation.spoke = true;
				await this.publish(claimed.message);
				return delivered();
			},
		};
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
	 * Rule 5, in one place: claim the record's next seq for an author that has
	 * read everything before it. The check and the append share one tick, so
	 * exactly one of two racing authors wins, and the loser is handed what it
	 * missed. A seat's say and an assistant's summary are refused the same way, for
	 * the same reason — which is why the event names the author, not the seat.
	 */
	private claim<T extends Message>(
		author: { name: string; readThrough: Seq },
		draft: Omit<T, 'seq'>,
	): { message: T } | { missed: Message[] } {
		if (this.store.lastSeq > author.readThrough) {
			const missed = this.store.since(author.readThrough);
			this.emit({ type: 'conflict', author: author.name, missed });
			return { missed };
		}
		return { message: this.store.append<T>(draft) };
	}

	// -- the assistant ------------------------------------------------------------

	/**
	 * The room went quiet, so the exchange it was working on is over. The host
	 * hears that before anything is written about it: an assistant is the first
	 * reader of a closed exchange and not the only one.
	 */
	private closeExchange(): void {
		const closing = this.exchanges.close(this.store.lastSeq);
		if (closing) this.emit({ type: 'exchange_closed', exchange: closing });
		this.summariseClosed(closing);
	}

	/**
	 * What an assistant makes of a closed exchange: its owner is owed the one
	 * message that stands for it, and the room activates every assistant owed one.
	 * Nothing else in the room wakes for a close — an assistant is seated `none`,
	 * and the close is the one thing that reaches it.
	 *
	 * Every quiet room is a chance to write what is owed, whatever made the
	 * room busy. An assistant's own activation ends no exchange, so a failed draft waits for
	 * the next time the seats stop rather than retrying on itself.
	 */
	private summariseClosed(closing: ClosedExchange | undefined): void {
		if (closing) this.assistants.owe(closing.owner, closing.from);
		const due = this.assistants.activationsDue(this.record, this.store.lastSeq, (name) =>
			this.speaksForItself(name),
		);
		for (const { seat } of due) this.activate(seat);
	}

	/**
	 * A seat that speaks for itself: an agent in this room, and not somebody's
	 * assistant. It is what the threshold counts — what the room produced, not what
	 * a person said into it, and not what an assistant wrote about it.
	 */
	private speaksForItself(name: string): boolean {
		return this.agents.has(name) && !this.assistants.isAssistant(name);
	}

	/**
	 * The room is quiet: no seat is taking an activation, and no assistant still owes one.
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
			const assistant = this.assistants.forPerson(name)?.def.name;
			views.push({
				name,
				identity,
				presence: this.here.presenceOf(name),
				changedAt: this.here.lastChangeAt(name),
				since,
				unseen: since === undefined ? 0 : this.store.since(since).length,
				...(assistant === undefined ? {} : { assistant }),
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
