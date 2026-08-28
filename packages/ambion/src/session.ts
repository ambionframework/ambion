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
	type HumanDefinition,
	isAgent,
	isAmbionTool,
	isPassiveSeat,
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
	type VisitInfo,
	type VisitStatus,
} from './types.ts';

/** The record lives as custom entries of this type in a Pi session. */
const MESSAGE_ENTRY = 'ambion/message';

/** Fifteen minutes without an act, unless the room or the visit says otherwise. */
export const DEFAULT_IDLE_TIMEOUT = 15 * 60_000;

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
	/** The house default for visits that do not set their own. */
	idleTimeout?: number;
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

export interface VisitOptions {
	/** Milliseconds without an act, after which the visit turns away. `Infinity` never. */
	idleTimeout?: number;
	/** A label the host chooses. The runtime stores it and gives it back. */
	via?: string;
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
	visits(): VisitInfo[];
}

export interface Visit {
	readonly human: HumanDefinition;
	readonly id: string;
	readonly status: VisitStatus;
	/** Where this person stopped reading last. A live read of the record. */
	readonly since: Seq | undefined;
	deliver(input: { to?: Participant; text: string }): Promise<void>;
	/** The host reports that the person acted. Returns an away visit to present. */
	acted(): void;
	leave(): Promise<void>;
}

interface SeatRuntime {
	def: AgentDefinition;
	passive: boolean;
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

interface VisitRuntime {
	id: string;
	human: HumanDefinition;
	via?: string;
	idleTimeout: number;
	enteredAt: string;
	lastActedAt: number;
	gone: boolean;
	timer?: ReturnType<typeof setTimeout>;
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

/** Puts a person in a running room. */
export function visitSession(
	session: Session,
	human: HumanDefinition,
	options: VisitOptions = {},
): Promise<Visit> {
	if (!(session instanceof SessionImpl)) {
		throw new Error('visitSession takes a session from startSession.');
	}
	return session.visit(human, options);
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
				visits: 0,
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
	private readonly idleTimeout: number;
	private readonly repo: SessionRepo;
	private readonly store: RecordStore;
	private readonly agents = new Map<string, SeatRuntime>();
	private readonly people = new Map<string, HumanDefinition>();
	private readonly visitsByName = new Map<string, VisitRuntime[]>();
	private readonly listeners = new Set<(event: SessionEvent) => void>();
	private readonly settledWaiters: (() => void)[] = [];
	private readonly streamFn: StreamFn;
	private readonly customStream: boolean;
	private activeCount = 0;
	private visitCount = 0;
	private stopped = false;

	constructor(options: StartSessionOptions) {
		this.name = options.name;
		this.goal = options.goal?.trim() || undefined;
		this.idleTimeout = options.idleTimeout ?? DEFAULT_IDLE_TIMEOUT;
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
		const def = isPassiveSeat(seat) ? seat.agent : seat;
		if (!isAgent(def)) {
			throw new Error('Agents must come from defineAgent or passive().');
		}
		if (this.agents.has(def.name)) {
			throw new Error(`Duplicate agent name '${def.name}': one name names one participant.`);
		}
		this.agents.set(def.name, {
			def,
			passive: isPassiveSeat(seat),
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
				status: seat.active ? 'active' : seat.passive ? 'passive' : 'idle',
				sessionId: `${this.name}:${seat.def.name}`,
			});
		}
		for (const [name, identity] of this.knownPeople()) {
			seats.push({
				kind: 'human',
				name,
				identity,
				presence: this.presenceOf(name),
				visits: (this.visitsByName.get(name) ?? []).length,
			});
		}
		return seats;
	}

	visits(): VisitInfo[] {
		const now = Date.now();
		const all: VisitInfo[] = [];
		for (const [name, visits] of this.visitsByName) {
			for (const visit of visits) {
				all.push({
					id: visit.id,
					human: name,
					status: statusOf(visit, now),
					via: visit.via,
					enteredAt: visit.enteredAt,
					lastActedAt: new Date(visit.lastActedAt).toISOString(),
					since: this.sinceOf(name),
				});
			}
		}
		return all;
	}

	// -- presence ------------------------------------------------------------

	/**
	 * Every name the room knows: the arrivals on its record, and whoever holds
	 * a visit now. A run does not carry its people over from the last one —
	 * the record does, which is why a `say` to somebody who was here yesterday
	 * still lands.
	 */
	private knownPeople(): Map<string, string> {
		const known = new Map<string, string>();
		for (const message of this.record) {
			if (message.kind === 'arrived' && message.identity) known.set(message.from, message.identity);
		}
		for (const [name, human] of this.people) known.set(name, human.identity);
		return known;
	}

	private knows(name: string): boolean {
		if (this.people.has(name)) return true;
		return this.record.some((message) => message.kind === 'arrived' && message.from === name);
	}

	/** Present if any visit is present, away if all are, absent with none. */
	private presenceOf(name: string): PresenceStatus {
		const visits = this.visitsByName.get(name) ?? [];
		if (visits.length === 0) return 'absent';
		const now = Date.now();
		return visits.some((visit) => statusOf(visit, now) === 'present') ? 'present' : 'away';
	}

	/** The seq of this person's most recent `away` or `left`. */
	private sinceOf(name: string): Seq | undefined {
		for (let i = this.record.length - 1; i >= 0; i -= 1) {
			const message = this.record[i];
			if (!message || message.from !== name) continue;
			if (message.kind === 'away' || message.kind === 'left') return message.seq;
		}
		return undefined;
	}

	async visit(human: HumanDefinition, options: VisitOptions): Promise<Visit> {
		this.assertRunning();
		this.assertVisitable(human);
		await this.store.ready;
		const before = this.presenceOf(human.name);
		this.visitCount += 1;
		const runtime: VisitRuntime = {
			id: `${human.name}#${this.visitCount}`,
			human,
			via: options.via,
			idleTimeout: options.idleTimeout ?? this.idleTimeout,
			enteredAt: new Date().toISOString(),
			lastActedAt: Date.now(),
			gone: false,
		};
		// The room changes before the message does: a seat woken by the arrival
		// must read a roster that already agrees with it.
		this.visitsByName.set(human.name, [...(this.visitsByName.get(human.name) ?? []), runtime]);
		this.people.set(human.name, human);
		this.emit({
			type: 'visit_enter',
			human: human.name,
			visit: runtime.id,
			presence: this.presenceOf(human.name),
		});
		await this.notePresence(human.name, before, 'arrived', human.identity);
		this.arm(runtime);
		return this.handle(runtime);
	}

	private assertVisitable(human: HumanDefinition): void {
		if (this.agents.has(human.name)) {
			throw new Error(
				`'${human.name}' is an agent in this session: one name names one participant.`,
			);
		}
		const known = this.people.get(human.name);
		if (known && known.identity !== human.identity) {
			throw new Error(
				`'${human.name}' is already in this session under a different identity: one name is one person.`,
			);
		}
	}

	private assertRunning(): void {
		if (this.stopped) throw new Error(`Session '${this.name}' is stopped.`);
	}

	/**
	 * Commit a presence message when — and only when — the person's own status
	 * changed. A second tab is host bookkeeping and never reaches the record.
	 */
	private async notePresence(
		name: string,
		before: PresenceStatus,
		kind: PresenceChange,
		identity?: string,
	): Promise<void> {
		const after = this.presenceOf(name);
		if (after === before) return;
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

	private arm(visit: VisitRuntime): void {
		clearTimeout(visit.timer);
		visit.timer = undefined;
		if (!Number.isFinite(visit.idleTimeout)) return;
		const timer = setTimeout(() => void this.turnAway(visit), visit.idleTimeout);
		timer.unref?.();
		visit.timer = timer;
	}

	private async turnAway(visit: VisitRuntime): Promise<void> {
		if (visit.gone || this.stopped) return;
		visit.timer = undefined;
		// The clock already made this visit away; the message only reports it.
		await this.notePresence(visit.human.name, 'present', 'away');
	}

	private act(visit: VisitRuntime): void {
		this.assertRunning();
		if (visit.gone) throw new Error(`This visit has ended: ${visit.id}.`);
		const before = this.presenceOf(visit.human.name);
		visit.lastActedAt = Date.now();
		this.arm(visit);
		void this.notePresence(visit.human.name, before, 'returned');
	}

	private async endVisit(visit: VisitRuntime, silent: boolean): Promise<void> {
		if (visit.gone) return;
		const name = visit.human.name;
		const before = this.presenceOf(name);
		clearTimeout(visit.timer);
		visit.timer = undefined;
		visit.gone = true;
		const rest = (this.visitsByName.get(name) ?? []).filter((other) => other !== visit);
		if (rest.length === 0) this.visitsByName.delete(name);
		else this.visitsByName.set(name, rest);
		this.emit({
			type: 'visit_leave',
			human: name,
			visit: visit.id,
			presence: this.presenceOf(name),
		});
		if (silent) return;
		await this.notePresence(name, before, 'left');
	}

	private handle(visit: VisitRuntime): Visit {
		const session = this;
		return {
			human: visit.human,
			id: visit.id,
			get status() {
				return statusOf(visit, Date.now());
			},
			get since() {
				return session.sinceOf(visit.human.name);
			},
			async deliver(input) {
				session.act(visit);
				await session.deliverFrom(visit.human.name, input);
			},
			acted() {
				session.act(visit);
			},
			leave() {
				return session.endVisit(visit, false);
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
		for (const name of [...this.visitsByName.keys()]) {
			if (this.presenceOf(name) === 'absent') continue;
			this.store.append<PresenceMessage>({
				kind: 'left',
				at: new Date().toISOString(),
				from: name,
			});
		}
		for (const visits of [...this.visitsByName.values()]) {
			for (const visit of [...visits]) await this.endVisit(visit, true);
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
		if (to !== undefined && !this.knows(to) && !this.agents.has(to)) {
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
		const target = to !== undefined ? this.agents.get(to) : undefined;
		for (const seat of this.agents.values()) {
			if (seat.def.name === message.from) continue;
			if (seat.active) this.steerInto(seat, message);
			else if (wakes(seat, target, to)) this.activate(seat);
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
		if (!this.knows(to) && !this.agents.has(to)) {
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
		for (const [name, identity] of this.knownPeople()) {
			const since = this.sinceOf(name);
			views.push({
				name,
				identity,
				presence: this.presenceOf(name),
				changedAt: this.lastChangeAt(name),
				since,
				unseen: since === undefined ? 0 : this.store.since(since).length,
			});
		}
		return views;
	}

	private lastChangeAt(name: string): string | undefined {
		for (let i = this.record.length - 1; i >= 0; i -= 1) {
			const message = this.record[i];
			if (message && message.kind !== 'said' && message.from === name) return message.at;
		}
		return undefined;
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
		if (this.goal) lines.push(...ARRIVAL_PARAGRAPH, ``);
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
			`The agents (active: taking a turn now; idle: hears every message; passive: hears`,
			`only a say directed at them):`,
			renderAgents(this.seats()),
			``,
			`The people (present: reading now; away: here, not reading; absent: not here):`,
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

/** What an agent does when somebody walks in. Rendered only when a goal is set. */
const ARRIVAL_PARAGRAPH = [
	`An arrival is a message like any other, and the bar for speaking is higher, not lower.`,
	`Somebody opening the workspace is not a request for a briefing, and they can read the`,
	`record themselves. Stay idle unless one of two things is true: something needs their`,
	`input before anybody can move, or something they have not seen changes what they do`,
	`next. If neither holds, end your turn without speaking. When one does hold, say the one`,
	`thing and name what you need from them, in a sentence or two. Never greet, never say`,
	`that you noticed them, never summarise the record back to the room, and never speak`,
	`only because a colleague spoke. When nobody is in the room, work for the record: state`,
	`what you decided and why, and do not wait for an answer that nobody is there to give.`,
];

/** A directed message wakes its target alone; a broadcast wakes every idle seat. */
function wakes(
	seat: SeatRuntime,
	target: SeatRuntime | undefined,
	to: string | undefined,
): boolean {
	if (to !== undefined) return seat === target;
	return !seat.passive;
}

function statusOf(visit: VisitRuntime, now: number): VisitStatus {
	return now - visit.lastActedAt < visit.idleTimeout ? 'present' : 'away';
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
