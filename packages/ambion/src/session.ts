import type {
	AgentEvent,
	AgentTool,
	AgentToolResult,
	Session as PiSession,
	SessionRepo,
	StreamFn,
} from '@earendil-works/pi-agent-core';
import { Agent, InMemorySessionRepo } from '@earendil-works/pi-agent-core';
import type { Api, Model, UserMessage } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { Type } from 'typebox';
import {
	type PersonView,
	renderAgents,
	renderClock,
	renderLine,
	renderPeople,
	renderRecord,
} from './render.ts';
import {
	type AgentDefinition,
	type AgentSeat,
	type Attention,
	type HumanDefinition,
	isAgent,
	isAmbionTool,
	isSeatedAgent,
	isSpoken,
	type Message,
	type Participant,
	type PresenceChange,
	type PresenceMessage,
	type PresenceStatus,
	type SeatInfo,
	type Seq,
	type SessionEvent,
	type SpokenMessage,
} from './types.ts';

/** The record lives as custom entries of this type in a Pi session. */
const MESSAGE_ENTRY = 'ambion/message';

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
	/** Resolves when no agent is active and nothing is queued. */
	settled(): Promise<void>;
	/** Cancel every active turn. The room keeps running; `stopSession` ends it. */
	abort(): void;
}

export interface Visit {
	readonly human: HumanDefinition;
	/** The seq of this person's last `left`, or undefined the first time. A live read. */
	readonly since: Seq | undefined;
	deliver(input: { to?: Participant; text: string }): Promise<void>;
	leave(): Promise<void>;
}

interface SeatRuntime {
	def: AgentDefinition;
	/** What wakes this seat. Chosen at seating, not by the definition. */
	attention: Attention;
	active: boolean;
	spoke: boolean;
	/** Pi's abort() cancels the run but not its queues; this stops the rebuild loop too. */
	aborted: boolean;
	/**
	 * How much of the record this seat has provably heard: the seq its view
	 * rendered, advanced as steers land in the transcript and by its own says.
	 */
	viewSeq: Seq;
	/** Record seqs of steers enqueued to the live agent, awaiting their drain (FIFO). */
	pendingSteers: Seq[];
	agent?: Agent;
	piSeat?: Promise<PiSession>;
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

/** Takes the room down: turns aborted, visits closed, timers cleared, writes drained. */
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

// -- the record --------------------------------------------------------------

/**
 * The replayed record. Both a run and a read need it, and neither needs the
 * other's machinery, so it is the one thing they share.
 */
class RecordStore {
	readonly entries: Message[] = [];
	readonly ready: Promise<PiSession>;
	nextSeq = 0;
	private tail: Promise<void> = Promise.resolve();

	constructor(
		private readonly repo: SessionRepo,
		private readonly name: string,
	) {
		this.ready = this.open();
	}

	private async open(): Promise<PiSession> {
		const piSession = await openOrCreate(this.repo, this.name);
		const found = await piSession.findEntries();
		// findEntries does not promise append order; seq does.
		found.sort((a, b) => a.seq - b.seq);
		for (const entry of found) {
			if (entry.type !== 'custom' || entry.customType !== MESSAGE_ENTRY) continue;
			this.entries.push(restore(entry.data as Partial<Message>, this.entries.length + 1));
		}
		this.nextSeq = this.entries.at(-1)?.seq ?? 0;
		return piSession;
	}

	/**
	 * Claim the record's next seq, synchronously — the say tool's conflict
	 * check and this push must share one tick, or a rival say could slip
	 * between them. Persistence follows in commit order on a write chain.
	 */
	append<T extends Message>(message: Omit<T, 'seq'>): T {
		const stamped = { ...message, seq: ++this.nextSeq } as T;
		this.entries.push(stamped);
		this.tail = this.tail.then(async () => {
			const piSession = await this.ready;
			await piSession.appendCustomEntry(MESSAGE_ENTRY, stamped);
		});
		return stamped;
	}

	drained(): Promise<void> {
		return this.tail;
	}

	since(cursor: Seq | undefined): Message[] {
		if (cursor === undefined) return [...this.entries];
		return this.entries.filter((message) => message.seq > cursor);
	}
}

/** Records written before kinds and seqs read as what they were: things said. */
function restore(data: Partial<Message>, fallbackSeq: Seq): Message {
	return { kind: 'said', ...data, seq: data.seq ?? fallbackSeq } as Message;
}

/** One person in the room, for as long as they are in it. */
interface VisitRuntime {
	human: HumanDefinition;
	gone: boolean;
}

/**
 * Who is in the room, and where each of them stopped reading. The record is
 * the store. This holds the one fact a replay cannot rebuild: who is here
 * now. Everything else it answers, it reads off the record.
 */
class Attendance {
	private readonly inRoom = new Map<string, VisitRuntime>();

	constructor(private readonly record: () => readonly Message[]) {}

	enter(human: HumanDefinition): VisitRuntime {
		const visit: VisitRuntime = { human, gone: false };
		this.inRoom.set(human.name, visit);
		return visit;
	}

	leave(name: string): void {
		this.inRoom.delete(name);
	}

	visitOf(name: string): VisitRuntime | undefined {
		return this.inRoom.get(name);
	}

	all(): VisitRuntime[] {
		return [...this.inRoom.values()];
	}

	presenceOf(name: string): PresenceStatus {
		return this.inRoom.has(name) ? 'present' : 'absent';
	}

	/** Every person the room knows: the arrivals on the record, and who is here. */
	known(): Map<string, string> {
		const known = new Map<string, string>();
		for (const message of this.record()) {
			if (message.kind !== 'arrived') continue;
			known.set(message.from, message.identity ?? '');
		}
		for (const visit of this.inRoom.values()) known.set(visit.human.name, visit.human.identity);
		return known;
	}

	knows(name: string): boolean {
		return this.known().has(name);
	}

	/** The seq of this person's last `left`, or undefined before their first. */
	sinceOf(name: string): Seq | undefined {
		return this.lastPresence(name)?.seq;
	}

	/** When this person's presence last changed, ISO. */
	lastChangeAt(name: string): string | undefined {
		const record = this.record();
		for (let i = record.length - 1; i >= 0; i -= 1) {
			const message = record[i];
			if (message && message.kind !== 'said' && message.from === name) return message.at;
		}
		return undefined;
	}

	private lastPresence(name: string): PresenceMessage | undefined {
		const record = this.record();
		for (let i = record.length - 1; i >= 0; i -= 1) {
			const message = record[i];
			if (message?.kind === 'left' && message.from === name) return message;
		}
		return undefined;
	}
}

class ReadOnlySession implements SessionView {
	private readonly store: RecordStore;

	constructor(
		readonly name: string,
		repo: SessionRepo,
	) {
		this.store = new RecordStore(repo, name);
	}

	async messages(options: { since?: Seq } = {}): Promise<Message[]> {
		await this.store.ready;
		return this.store.since(options.since);
	}

	/** A room that is not running has no agents standing up, and nobody in it. */
	seats(): SeatInfo[] {
		const seen = new Map<string, SeatInfo>();
		for (const message of this.store.entries) {
			if (message.kind !== 'arrived') continue;
			seen.set(message.from, {
				kind: 'human',
				name: message.from,
				identity: message.identity ?? '',
				presence: 'absent',
			});
		}
		return [...seen.values()];
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
	private readonly here = new Attendance(() => this.record);
	private readonly listeners = new Set<(event: SessionEvent) => void>();
	private readonly settledWaiters: (() => void)[] = [];
	private readonly streamFn: StreamFn;
	private readonly customStream: boolean;
	private activeCount = 0;
	private stopped = false;

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
	private seat(seat: AgentSeat): void {
		const def = isSeatedAgent(seat) ? seat.agent : seat;
		if (!isAgent(def)) {
			throw new Error('Agents must come from defineAgent or passive().');
		}
		if (this.agents.has(def.name)) {
			throw new Error(`Duplicate agent name '${def.name}': one name names one participant.`);
		}
		this.agents.set(def.name, {
			def,
			attention: isSeatedAgent(seat) ? seat.attention : 'broadcast',
			active: false,
			spoke: false,
			aborted: false,
			viewSeq: 0,
			pendingSteers: [],
		});
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

	settled(): Promise<void> {
		if (this.activeCount === 0) return Promise.resolve();
		return new Promise((resolve) => this.settledWaiters.push(resolve));
	}

	abort(): void {
		for (const seat of this.agents.values()) {
			if (!seat.active) continue;
			seat.aborted = true;
			seat.agent?.abort();
		}
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
				status: seat.active ? 'active' : 'idle',
				attention: seat.attention,
				sessionId: `${this.name}:${seat.def.name}`,
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
		await this.commitPresence(human.name, 'arrived', human.identity);
		return this.handle(visit);
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
		const message = this.store.append<PresenceMessage>({
			kind,
			at: new Date().toISOString(),
			from: name,
			...(identity === undefined ? {} : { identity }),
		});
		await this.store.drained();
		this.emit({ type: 'delivery', message });
		this.dispatch(message);
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
		this.abort();
		await this.store.ready;
		// A deliberate shutdown observed everybody leaving, so the record says
		// so — but it wakes nobody: a turn started to hear that the room is
		// closing is a turn nobody reads.
		for (const visit of this.here.all()) {
			visit.gone = true;
			this.here.leave(visit.human.name);
			this.store.append<PresenceMessage>({
				kind: 'left',
				at: new Date().toISOString(),
				from: visit.human.name,
			});
		}
		this.stopped = true;
		await this.store.drained();
		if (running.get(this.name) === this) running.delete(this.name);
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
		const message = this.store.append<SpokenMessage>({
			kind: 'said',
			at: new Date().toISOString(),
			from,
			...(to === undefined ? {} : { to }),
			text: input.text,
		});
		await this.store.drained();
		this.emit({ type: 'delivery', message });
		this.dispatch(message);
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
	 * said. Every colleague still at work hears it as a steer (rule 2). A
	 * broadcast wakes the idle room, passive seats excepted (rule 1); a
	 * directed message wakes exactly its target, passive included (rule 4).
	 */
	private dispatch(message: Message): void {
		const to = isSpoken(message) ? message.to : undefined;
		const target = to === undefined ? undefined : this.agents.get(to);
		for (const seat of this.agents.values()) {
			if (seat.def.name === message.from) continue;
			if (seat.active) this.steerInto(seat, message);
			else if (wakes(seat, target, message)) this.activate(seat);
		}
	}

	private steerInto(seat: SeatRuntime, message: Message): void {
		seat.pendingSteers.push(message.seq);
		seat.agent?.steer(userMessage(`[new] ${renderLine(message)}`));
	}

	private activate(seat: SeatRuntime): void {
		seat.active = true;
		seat.spoke = false;
		seat.aborted = false;
		this.activeCount += 1;
		this.emit({ type: 'agent_start', agent: seat.def.name });
		void this.run(seat).finally(() => {
			seat.active = false;
			seat.agent = undefined;
			this.emit({ type: 'agent_end', agent: seat.def.name, spoke: seat.spoke });
			this.activeCount -= 1;
			if (this.activeCount > 0) return;
			this.emit({ type: 'settled' });
			for (const resolve of this.settledWaiters.splice(0)) resolve();
		});
	}

	private async run(seat: SeatRuntime): Promise<void> {
		for (;;) {
			try {
				// A fresh view hands the seat the whole record: heard up to here.
				seat.viewSeq = this.store.nextSeq;
				seat.pendingSteers = [];
				const agent = this.buildAgent(seat);
				seat.agent = agent;
				await agent.prompt(userMessage(this.renderContext(seat)));
				await this.persistRun(seat, agent);
				const failure = runFailure(agent);
				if (failure) {
					this.emit({ type: 'error', agent: seat.def.name, error: failure });
					return;
				}
				// An aborted turn stays cancelled: Pi's abort() ends the run but
				// leaves its queues, and a queued steer must not rebuild the turn.
				if (seat.aborted) return;
				// A steer that raced past the run's last drain is not lost: the
				// message is already on the record, so a fresh view carries it.
				if (!agent.hasQueuedMessages()) return;
				agent.clearAllQueues();
			} catch (error) {
				this.emit({ type: 'error', agent: seat.def.name, error: toError(error) });
				return;
			}
		}
	}

	private async persistRun(seat: SeatRuntime, agent: Agent): Promise<void> {
		const piSeat = await this.seatSession(seat);
		await piSeat.appendCustomEntry('ambion/activation', { at: new Date().toISOString() });
		for (const message of agent.state.messages) {
			// Provider messages may carry undefined-valued fields, which Pi's
			// durability check rejects; a JSON round-trip drops them.
			await piSeat.appendMessage(JSON.parse(JSON.stringify(message)));
		}
	}

	private buildAgent(seat: SeatRuntime): Agent {
		const agent = new Agent({
			streamFn: this.streamFn,
			initialState: {
				systemPrompt: this.systemPrompt(seat),
				model: this.resolveModel(seat.def),
				thinkingLevel: 'off',
				tools: [this.sayTool(seat), ...seat.def.tools.map(toPiTool)],
				messages: [],
			},
		});
		agent.subscribe((event) => {
			this.noteSteer(seat, event);
			this.relayToolUse(seat, event);
		});
		return agent;
	}

	/**
	 * A steer has landed in the transcript: the seat has now heard it. Steers
	 * drain FIFO, so the oldest pending seq is the one that landed.
	 */
	private noteSteer(seat: SeatRuntime, event: AgentEvent): void {
		if (event.type !== 'message_start' || event.message.role !== 'user') return;
		const content = event.message.content;
		if (typeof content !== 'string' || !content.startsWith('[new] ')) return;
		const seq = seat.pendingSteers.shift();
		if (seq !== undefined) seat.viewSeq = Math.max(seat.viewSeq, seq);
	}

	/** The room sees that hands moved; `say` is the room's own event, not a tool's. */
	private relayToolUse(seat: SeatRuntime, event: AgentEvent): void {
		if (event.type !== 'tool_execution_start' && event.type !== 'tool_execution_end') return;
		if (event.toolName === 'say') return;
		this.emit({ type: event.type, agent: seat.def.name, toolName: event.toolName });
	}

	private sayTool(seat: SeatRuntime): AgentTool {
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
				const conflict = this.conflict(seat);
				if (conflict) throw conflict;
				const message = this.store.append<SpokenMessage>({
					kind: 'said',
					at: new Date().toISOString(),
					from: seat.def.name,
					...(to === undefined ? {} : { to }),
					text: params.text,
				});
				seat.viewSeq = message.seq;
				seat.spoke = true;
				await this.store.drained();
				// A say is atomic: one event, the whole message, exactly as it landed.
				this.emit({ type: 'say', agent: seat.def.name, message });
				this.dispatch(message);
				const result: AgentToolResult<Record<string, never>> = {
					content: [{ type: 'text', text: 'delivered' }],
					details: {},
				};
				return result;
			},
		};
	}

	private assertAddressable(seat: SeatRuntime, to: string | undefined): void {
		if (to === undefined) return;
		if (!this.here.knows(to) && !this.agents.has(to)) {
			throw new Error(`Unknown participant '${to}'. Address someone from the roster.`);
		}
		if (to === seat.def.name) throw new Error('You cannot address yourself.');
	}

	/**
	 * Optimistic locking: a say commits only against a record its seat has
	 * heard in full. The check and the append share one tick, so exactly one
	 * of two racing says wins; the loser's failure carries what it missed.
	 */
	private conflict(seat: SeatRuntime): Error | undefined {
		if (this.store.nextSeq <= seat.viewSeq) return undefined;
		const missed = this.store.since(seat.viewSeq);
		seat.viewSeq = this.store.nextSeq;
		this.emit({ type: 'say_conflict', agent: seat.def.name, missed });
		return new Error(
			[
				'Not delivered — the room moved while you were speaking. New on the record:',
				...missed.map(renderLine),
				'Speak again only if your reply still adds something the room has not heard; otherwise end your turn.',
			].join('\n'),
		);
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

	private systemPrompt(seat: SeatRuntime): string {
		const lines = [
			`You are '${seat.def.name}', an agent seated in the session '${this.name}' — a shared`,
			`room with a record. Every participant sees what is said; nobody sees your tool use.`,
			``,
		];
		if (this.goal) lines.push(`This session exists to: ${this.goal}`, ``);
		lines.push(
			`Speaking is the say tool. Silence is the default: if this does not concern you, end`,
			`your turn without saying anything, and no mark is left. Speak only when your reply`,
			`adds something the record does not already hold — new information, a decision moved`,
			`forward, or a genuinely different perspective. A point already made does not need a`,
			`second voice; restating it in your own words is repetition, not contribution — stay`,
			`silent instead. A directed say (to: a name) calls that agent in; use it deliberately —`,
			`attention costs money. When a colleague holds the answer, ask them directly with one`,
			`directed say — never announce to the room what you are about to do, and never pose a`,
			`question undirected that only one participant can answer: a say is a message, not a`,
			`thought. Messages arriving mid-turn are marked [new]; fold them into what you are`,
			`doing — and if a colleague has just made your point, let it stand. A say fails if`,
			`the room moved while you were speaking: the failure lists what you missed — read`,
			`it, and speak again only if your reply still adds something.`,
			``,
		);
		lines.push(...AUDIENCE_PARAGRAPH, ``);
		lines.push(
			`Your identity, as the room knows it: ${seat.def.identity}`,
			``,
			`Your instructions:`,
			seat.def.instructions.trim(),
		);
		return lines.join('\n');
	}

	private renderContext(seat: SeatRuntime): string {
		const now = Date.now();
		const people = this.peopleViews();
		return [
			renderClock(now),
			``,
			`The agents (active: taking a turn now; idle: at rest. A seat marked "named only"`,
			`hears nothing but a say addressed to it; one marked "watches arrivals" also wakes`,
			`when somebody arrives or leaves; the rest wake on anything said):`,
			renderAgents(this.seats()),
			``,
			`The people (present: in the room now; absent: not in the room):`,
			renderPeople(people, now),
			``,
			`The record of '${this.name}' so far:`,
			renderRecord(this.record, people, now),
			``,
			`Take your turn, ${seat.def.name}: say something, or end your turn to stay silent.`,
		].join('\n');
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

/** What a seat does with a presence line that lands while it is working. */
const AUDIENCE_PARAGRAPH = [
	`Who is reading can change while you work. An arrival or a departure reaches you as a`,
	`[new] line mid-turn, and wakes you outright if your seat watches for it. It is never a`,
	`request — nobody asked you anything by opening the workspace —`,
	`so it never means start something new, and you`,
	`never greet, never say that you noticed, and never summarise the record back to the`,
	`room. Use it to aim what you were already going to say: pitch it at whoever is`,
	`actually reading now, say the part that needs them while they are still there, and`,
	`drop what only mattered to somebody who has gone. If it changes nothing about your`,
	`turn, ignore it. When nobody is in the room, work for the record: state what you`,
	`decided and why, and do not wait for an answer that nobody is there to give.`,
];

/**
 * A directed message wakes its target alone. A broadcast wakes every idle seat
 * whose attention is wide enough for it — rule 1 routes, rule 6 decides who
 * sits out, and a presence message is routed like any other.
 */
function wakes(seat: SeatRuntime, target: SeatRuntime | undefined, message: Message): boolean {
	if (isSpoken(message) && message.to !== undefined) return seat === target;
	if (seat.attention === 'named') return false;
	return isSpoken(message) || seat.attention === 'presence';
}

/** Open an id into its Pi session, creating it on first open. */
async function openOrCreate(
	repo: SessionRepo,
	id: string,
	parentSessionId?: string,
): Promise<PiSession> {
	const known = (await repo.list()).find((metadata) => metadata.id === id);
	if (known) return repo.open(known);
	return repo.create(parentSessionId ? { id, parentSessionId } : { id });
}

function userMessage(text: string): UserMessage {
	return { role: 'user', content: text, timestamp: Date.now() };
}

function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

function runFailure(agent: Agent): Error | undefined {
	const last = agent.state.messages.at(-1);
	if (last && 'stopReason' in last && last.stopReason === 'error') {
		return new Error(('errorMessage' in last && last.errorMessage) || 'The turn failed.');
	}
	return undefined;
}

function toPiTool(tool: unknown): AgentTool {
	if (isAmbionTool(tool)) {
		return {
			name: tool.name,
			label: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			execute: async (_toolCallId, params, signal) => {
				const result = await tool.execute(params, signal);
				return typeof result === 'string'
					? { content: [{ type: 'text', text: result }], details: {} }
					: result;
			},
		};
	}
	const raw = tool as AgentTool & { label?: string };
	if (typeof raw?.name !== 'string' || typeof raw?.execute !== 'function') {
		throw new Error('Tools must come from defineTool (Ambion or Pi).');
	}
	return raw.label ? raw : { ...raw, label: raw.name };
}
