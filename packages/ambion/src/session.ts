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
	type SummaryMessage,
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

/**
 * One person's aide, for the life of the run. It is not a seat: no message
 * activates it, and it takes a turn only when an exchange it owns closes.
 */
interface AideRuntime {
	def: AgentDefinition;
	/** The person it holds. Its summaries are addressed to them and to nobody else. */
	person: string;
	/** Whether this turn's draft reached the record. The aide's own `spoke`. */
	wrote: boolean;
	/** How often the lock refused this turn. Two drafts, and then it stands down. */
	refusals: number;
	/** How often it called its tool this turn. Nothing else bounds the turn. */
	calls: number;
	agent?: Agent;
	piSeat?: Promise<PiSession>;
}

/**
 * The range one summary stands for. It is read off the record when the aide
 * starts, and it widens when a race refuses the draft: the retry covers what
 * it covered before, plus whatever won.
 */
interface SummaryRange {
	from: Seq;
	through: Seq;
	messages: Message[];
}

/** One draft, and one redraft after a race. Then the room keeps moving without it. */
const AIDE_DRAFTS = 2;

/**
 * How often an aide may call its tool in one turn. A model that keeps calling
 * a tool that keeps refusing would run for ever, and nothing else here bounds
 * a turn — the same gap `agent.md` §7 records for the room, closed where it
 * can be closed.
 */
const AIDE_CALLS = 4;

/** What one aide's turn came to. Only a race or a failure is worth retrying. */
type DraftOutcome = 'written' | 'declined' | 'refused';

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
	/** The first write that failed since the last report. See `drained`. */
	private failure: Error | undefined;

	constructor(
		private readonly repo: SessionRepo,
		private readonly name: string,
	) {
		this.ready = this.open();
		// A host can hold a session and read nothing from it for hours, so
		// nothing may await `ready` for a long time. Mark the rejection handled
		// here: a repo that cannot open must surface at the call that needs the
		// store, and never as an unhandled rejection that ends the process.
		void this.ready.catch(() => {});
	}

	private async open(): Promise<PiSession> {
		const piSession = await openOrCreate(this.repo, this.name);
		const found = await piSession.findEntries();
		// findEntries does not promise append order; seq does.
		found.sort((a, b) => a.seq - b.seq);
		for (const entry of found) {
			if (entry.type !== 'custom' || entry.customType !== MESSAGE_ENTRY) continue;
			this.entries.push(entry.data as Message);
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
		this.tail = this.tail
			.then(async () => {
				const piSession = await this.ready;
				await piSession.appendCustomEntry(MESSAGE_ENTRY, stamped);
			})
			// One write that fails must not stop the next one. The chain keeps
			// its order and remembers the failure; a repo that recovers writes
			// again. Without this catch the chain stays rejected for good.
			.catch((error: unknown) => {
				this.failure ??= toError(error);
			});
		return stamped;
	}

	/**
	 * Wait for the writes in flight, then report a failed one. The report
	 * clears it: the caller waiting on that write learns the record is
	 * incomplete, and the room keeps running rather than failing for ever.
	 */
	async drained(): Promise<void> {
		await this.tail;
		const failure = this.failure;
		if (failure === undefined) return;
		this.failure = undefined;
		throw failure;
	}

	since(cursor: Seq | undefined): Message[] {
		if (cursor === undefined) return [...this.entries];
		return this.entries.filter((message) => message.seq > cursor);
	}
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
	/** One aide per person who brought one, keyed by the person's name. */
	private readonly aides = new Map<string, AideRuntime>();
	/** The aides' own names, read on every dispatch to keep them from waking anybody. */
	private readonly aideNames = new Set<string>();
	private readonly here = new Attendance(() => this.record);
	private readonly listeners = new Set<(event: SessionEvent) => void>();
	private readonly settledWaiters: (() => void)[] = [];
	private readonly streamFn: StreamFn;
	private readonly customStream: boolean;
	private activeCount = 0;
	private stopped = false;
	/** The person who owns the open exchange, while one is open. Run state. */
	private exchange: string | undefined;
	/** People whose summary a race refused. Each drafts again at the next quiescence. */
	private readonly refused = new Set<string>();
	/** Aides write one at a time, so a second summary drafts against the first. */
	private aideTail: Promise<void> = Promise.resolve();

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
		// An aide's turn is not a seat's, and it is still a turn in flight. A
		// cancelled draft writes nothing, which is the safe direction.
		for (const aide of this.aides.values()) aide.agent?.abort();
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
			const aide = this.aides.get(name)?.def.name;
			seats.push({
				kind: 'human',
				name,
				identity,
				presence: this.here.presenceOf(name),
				...(aide === undefined ? {} : { aide }),
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
		this.bringAide(human);
		await this.commitPresence(human.name, 'arrived', human.identity);
		return this.handle(visit);
	}

	/**
	 * An aide joins the room with its person and stays for the run: it outlives
	 * their visit by one exchange, because an exchange that opened is finished
	 * properly or not at all.
	 */
	private bringAide(human: HumanDefinition): void {
		if (!human.aide || this.aides.has(human.name)) return;
		this.aides.set(human.name, {
			def: human.aide,
			person: human.name,
			wrote: false,
			refusals: 0,
			calls: 0,
		});
		this.aideNames.add(human.aide.name);
	}

	private assertVisitable(human: HumanDefinition): void {
		if (this.agents.has(human.name)) {
			throw new Error(
				`'${human.name}' is an agent in this session: one name names one participant.`,
			);
		}
		this.assertAideNameFree(human);
		const known = this.here.known().get(human.name);
		if (known !== undefined && known !== human.identity) {
			throw new Error(
				`'${human.name}' is already in this session under a different identity: one name is one person.`,
			);
		}
	}

	/** An aide writes on the record, so its name is one name like any other. */
	private assertAideNameFree(human: HumanDefinition): void {
		const aide = human.aide;
		if (!aide || this.aides.get(human.name)?.def.name === aide.name) return;
		const taken =
			this.agents.has(aide.name) || this.here.knows(aide.name) || this.aideNames.has(aide.name);
		if (taken) {
			throw new Error(
				`Aide name '${aide.name}' is taken in this session: one name names one participant.`,
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
		this.noteExchange(message);
		this.emit({ type: 'message', message });
		this.dispatch(message);
	}

	/**
	 * A person's question opens an exchange and owns it, when no exchange is
	 * open. An exchange closes when the room goes quiet, so in an idle room
	 * that is always true; a seat woken by an arrival is working on nothing
	 * anybody asked for, and the question that lands on top of it still owns
	 * what follows. A message that lands into an open exchange steers the seats
	 * already working and changes nothing — not the owner, and not which aide
	 * writes at the close. Arriving and leaving open no exchange: nobody asked
	 * anything by opening the workspace.
	 */
	private noteExchange(message: Message): void {
		if (this.exchange !== undefined) return;
		if (!isSpoken(message) || !this.here.knows(message.from)) return;
		this.exchange = message.from;
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
			// says so, and the host hears it. It wakes nobody: a turn started
			// to hear that the room is closing is a turn nobody reads.
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
	 * said. Every colleague still at work hears it as a steer (rule 2). A
	 * broadcast wakes the idle room, passive seats excepted (rule 1); a
	 * directed message wakes exactly its target, passive included (rule 4).
	 */
	private dispatch(message: Message): void {
		const to = isSpoken(message) ? message.to : undefined;
		const target = to === undefined ? undefined : this.agents.get(to);
		const fromAide = this.aideNames.has(message.from);
		for (const seat of this.agents.values()) {
			if (seat.def.name === message.from) continue;
			if (seat.active) this.steerInto(seat, message);
			else if (wakes(seat, target, message, fromAide)) this.activate(seat);
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
			// The room is quiet, so the exchange is over. `settled()` has already
			// resolved: the room is never held busy while an aide writes.
			this.closeExchange();
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
		await this.persistTurns(this.seatSession(seat), agent);
	}

	/** Every turn a model took, in the downstream session that owns it. */
	private async persistTurns(open: Promise<PiSession>, agent: Agent): Promise<void> {
		const piSeat = await open;
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
				const claimed = this.claim<SpokenMessage>(
					{ name: seat.def.name, readThrough: seat.viewSeq },
					{
						kind: 'said',
						at: new Date().toISOString(),
						from: seat.def.name,
						...(to === undefined ? {} : { to }),
						text: params.text,
					},
				);
				if ('missed' in claimed) {
					// Refused, and now heard: the seat decides again against the record as it stands.
					seat.viewSeq = this.store.nextSeq;
					throw new Error(
						refusal(
							'Not delivered — the room moved while you were speaking. New on the record:',
							claimed.missed,
							'Speak again only if your reply still adds something the room has not heard; otherwise end your turn.',
						),
					);
				}
				// The seat has heard its own say before anybody else hears of it.
				seat.viewSeq = claimed.message.seq;
				seat.spoke = true;
				await this.publish(claimed.message);
				return delivered();
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
	 * Rule 5, in one place: claim the record's next seq for an author that has
	 * read everything before it. The check and the append share one tick, so
	 * exactly one of two racing authors wins, and the loser is handed what it
	 * missed. A seat's say and an aide's summary are refused the same way, for
	 * the same reason — which is why the event names the author, not the seat.
	 */
	private claim<T extends Message>(
		author: { name: string; readThrough: Seq },
		draft: Omit<T, 'seq'>,
	): { message: T } | { missed: Message[] } {
		if (this.store.nextSeq > author.readThrough) {
			const missed = this.store.since(author.readThrough);
			this.emit({ type: 'conflict', author: author.name, missed });
			return { missed };
		}
		return { message: this.store.append<T>(draft) };
	}

	// -- the aide ------------------------------------------------------------

	/**
	 * The exchange is over. Its owner's aide writes the one message that stands
	 * for it, and any summary a race refused drafts again. Aides write in turn
	 * on one chain, so a second summary drafts against a record the first has
	 * already moved rather than racing it.
	 */
	private closeExchange(): void {
		const owner = this.exchange;
		this.exchange = undefined;
		const owed = [...this.refused];
		if (owner !== undefined && !owed.includes(owner)) owed.push(owner);
		if (owed.length === 0) return;
		this.aideTail = this.aideTail.then(() => this.summariseFor(owed));
	}

	private async summariseFor(owed: string[]): Promise<void> {
		for (const person of owed) {
			if (this.stopped) return;
			await this.summarise(person);
		}
	}

	/**
	 * One exchange, one message — when the room said more than one thing. One
	 * answer is left as it was given, in the voice that gave it, and an
	 * exchange the agents said nothing into writes nothing at all.
	 */
	private async summarise(person: string): Promise<void> {
		this.refused.delete(person);
		const aide = this.aides.get(person);
		if (!aide) return;
		const range = this.summaryRange(person);
		if (!range) return;
		this.emit({ type: 'agent_start', agent: aide.def.name });
		const outcome = await this.runAide(aide, range);
		// An aide that stood down judged the room; it is not owed anything. A
		// race or a failed turn is, and drafts again at the next quiescence.
		if (outcome === 'refused') this.refused.add(person);
		this.emit({ type: 'agent_end', agent: aide.def.name, spoke: outcome === 'written' });
	}

	/**
	 * What this person's next summary would stand for, or nothing when one
	 * message already serves. A live read of the record, not a cursor kept
	 * beside it.
	 */
	private summaryRange(person: string): SummaryRange | undefined {
		const from = this.coversFrom(person);
		if (from === undefined) return undefined;
		const through = this.store.nextSeq;
		const messages = this.record.filter((m) => m.seq >= from && m.seq <= through);
		const said = messages.filter((m) => isSpoken(m) && this.agents.has(m.from));
		return said.length > 1 ? { from, through, messages } : undefined;
	}

	/**
	 * Where this person's summary starts: the seq after their last summary, or
	 * their first question when they have none. It never reaches back past a
	 * summary they have already read.
	 */
	private coversFrom(person: string): Seq | undefined {
		for (let i = this.record.length - 1; i >= 0; i -= 1) {
			const message = this.record[i];
			if (message?.kind === 'summary' && message.to === person) return message.seq + 1;
		}
		return this.record.find((m) => isSpoken(m) && m.from === person)?.seq;
	}

	/**
	 * One turn, with one tool in it. An aide writes the way a seat speaks: it
	 * calls the tool that commits, or it ends its turn and leaves no mark.
	 */
	private async runAide(aide: AideRuntime, range: SummaryRange): Promise<DraftOutcome> {
		aide.wrote = false;
		aide.refusals = 0;
		aide.calls = 0;
		const agent = new Agent({
			streamFn: this.streamFn,
			initialState: {
				systemPrompt: this.aidePrompt(aide),
				model: this.resolveModel(aide.def),
				thinkingLevel: 'off',
				// One tool, and it writes to the record. An aide holds no hands
				// into a product's state: `defineHuman` refuses one that carries
				// any, so §12's rule is a fact about the definition.
				tools: [this.summariseTool(aide, range)],
				messages: [],
			},
		});
		aide.agent = agent;
		try {
			await agent.prompt(userMessage(this.aideContext(aide.person, range.messages)));
			await this.persistTurns(this.aideSession(aide), agent);
			const failure = runFailure(agent);
			if (failure) throw failure;
			if (aide.wrote) return 'written';
			return aide.refusals > 0 ? 'refused' : 'declined';
		} catch (error) {
			this.emit({ type: 'error', agent: aide.def.name, error: toError(error) });
			return 'refused';
		} finally {
			aide.agent = undefined;
		}
	}

	/**
	 * The aide's one hand, and it reaches the record and nothing else. It
	 * commits under the same lock a say commits under, so a summary drafted
	 * against a record that has moved is refused — and the refusal reaches the
	 * aide inside its own turn, carrying what it missed, so the redraft happens
	 * now rather than at the next quiescence.
	 */
	private summariseTool(aide: AideRuntime, range: SummaryRange): AgentTool {
		return {
			name: 'summarise',
			label: 'summarise',
			description:
				`Write the one message ${aide.person} reads for this exchange. Call it once. ` +
				'Ending your turn without calling it leaves the range whole, for whoever reads it.',
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, rawParams) => {
				const text = (rawParams as { text: string }).text.trim();
				aide.calls += 1;
				const stop = this.standDown(aide);
				if (stop) return stop;
				if (text === '') {
					throw new Error(
						`The message is empty. Write what ${aide.person} reads, or end your turn.`,
					);
				}
				const claimed = this.claim<SummaryMessage>(
					{ name: aide.def.name, readThrough: range.through },
					{
						kind: 'summary',
						at: new Date().toISOString(),
						from: aide.def.name,
						to: aide.person,
						text,
						covers: { from: range.from, through: range.through },
					},
				);
				if ('missed' in claimed) throw this.widen(aide, range, claimed.missed);
				aide.wrote = true;
				await this.publish(claimed.message);
				return delivered();
			},
		};
	}

	/**
	 * Why this turn cannot come good, when it cannot. Telling a model to stop
	 * is not enough — one that keeps calling the tool would draft for ever —
	 * so the result ends the turn itself. `terminate` is Pi's own way for a
	 * tool to say that the loop is over, and the reason still reaches the
	 * transcript, where rule 8 keeps it.
	 */
	private standDown(aide: AideRuntime): AgentToolResult<Record<string, never>> | undefined {
		const why = this.stoppingReason(aide);
		if (why === undefined) return undefined;
		return {
			content: [{ type: 'text', text: `${why} This turn is over.` }],
			details: {},
			terminate: true,
		};
	}

	private stoppingReason(aide: AideRuntime): string | undefined {
		if (this.stopped) return 'The room is closing.';
		if (aide.wrote) return `You have already written ${aide.person}'s message for this exchange.`;
		if (aide.refusals >= AIDE_DRAFTS) {
			return 'The room is still moving. The range stays whole, and you write it when the room is quiet again.';
		}
		if (aide.calls > AIDE_CALLS) return 'You have tried this enough times.';
		return undefined;
	}

	/**
	 * A refused draft widens the range it covers. The messages that won the
	 * race are now inside it, so the redraft stands for them too and the
	 * summary stays contiguous with what it covers.
	 */
	private widen(aide: AideRuntime, range: SummaryRange, missed: Message[]): Error {
		range.through = this.store.nextSeq;
		range.messages.push(...missed);
		aide.refusals += 1;
		return new Error(
			refusal(
				'Not written — the room moved while you were drafting. It is now yours to cover too:',
				missed,
				`Write ${aide.person}'s message again, over the range as it now stands.`,
			),
		);
	}

	/** An aide's turns land beside the seats' own, in `<room>:<person>`. */
	private aideSession(aide: AideRuntime): Promise<PiSession> {
		aide.piSeat ??= (async () => {
			await this.store.ready;
			return openOrCreate(this.repo, `${this.name}:${aide.person}`, this.name);
		})();
		return aide.piSeat;
	}

	private aidePrompt(aide: AideRuntime): string {
		const person = aide.person;
		const lines = [
			`You are '${aide.def.name}', ${person}'s aide in the session '${this.name}' — a shared`,
			`room with a record. You are not seated in it. ${person} asked a question, the agents`,
			`worked it out between them, and the room is quiet again.`,
			``,
		];
		if (this.goal) lines.push(`This session exists to: ${this.goal}`, ``);
		lines.push(...AIDE_PARAGRAPH, ``);
		lines.push(
			`Your identity, as the room knows it: ${aide.def.identity}`,
			``,
			`Your instructions:`,
			aide.def.instructions.trim(),
		);
		return lines.join('\n');
	}

	/**
	 * What an aide is handed: the room, the roster, and the range it is about
	 * to cover. Not the record before that range — a summary its person has
	 * already read is theirs, not its.
	 */
	private aideContext(person: string, range: readonly Message[]): string {
		const now = Date.now();
		return [
			renderClock(now),
			``,
			`The agents in the room:`,
			renderAgents(this.seats()),
			``,
			`The people (present: in the room now; absent: not in the room):`,
			renderPeople(this.peopleViews(), now),
			``,
			`What the room did, from ${person}'s question to the moment it went quiet:`,
			renderRecord(range, [], now),
			``,
			`Write ${person}'s message.`,
		].join('\n');
	}

	// -- what an agent reads -------------------------------------------------

	/** One entry per person the room knows, with their gap and what they missed. */
	private peopleViews(): PersonView[] {
		const views: PersonView[] = [];
		for (const [name, identity] of this.here.known()) {
			const since = this.here.sinceOf(name);
			const aide = this.aides.get(name)?.def.name;
			views.push({
				name,
				identity,
				presence: this.here.presenceOf(name),
				changedAt: this.here.lastChangeAt(name),
				since,
				unseen: since === undefined ? 0 : this.store.since(since).length,
				...(aide === undefined ? {} : { aide }),
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
		if (this.aides.size > 0) lines.push(...SUMMARY_PARAGRAPH, ``);
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

/** What an aide is asked for, and the whole of what it may do. */
const AIDE_PARAGRAPH = [
	`Writing is the summarise tool. Give it the one message your person reads instead of the`,
	`working: what they asked, answered once, for somebody who has not read a line of it. Keep`,
	`the facts a colleague needs to act on it — quantities, dates, owners, what is still`,
	`unknown, and who holds the decision. Leave out who said what, and in which order. Pass the`,
	`message and nothing else: no preamble, no heading, no sign-off, and never a note about how`,
	`you wrote it.`,
	``,
	`Ending your turn without calling summarise leaves the range whole, and every reader still`,
	`sees all of it. Do that when there is nothing to consolidate — when what the room said`,
	`already reads as one answer, and standing between your person and it would only add a`,
	`voice. The tool fails if the room moved while you were drafting: it lists what landed,`,
	`which your message now covers as well, so write it again over the range as it now stands.`,
	``,
	`What you write is not something you said in the room. Nobody hears it, no agent wakes`,
	`because of it, and it never carries your person's name — the room stamps it as yours.`,
	`You hold their brief; they hold the decision. You decide nothing, you act on nothing,`,
	`and you never answer in their place.`,
];

/** What a seat makes of a range that has left its context. */
const SUMMARY_PARAGRAPH = [
	`Part of the record may read as "── N messages, summarised below ──", followed by one`,
	`message from somebody's aide. An aide is that person's own counterpart: it wrote the one`,
	`message that stands for what the room worked out, and you read it in place of those`,
	`messages. Treat it as what happened. It asks you for nothing and it addresses one person,`,
	`not you. If you need a fact it left out, read it again from your own tools rather than`,
	`asking the room to repeat itself.`,
];

/**
 * A directed message wakes its target alone. A broadcast wakes every idle seat
 * whose attention is wide enough for it — rule 1 routes, rule 6 decides who
 * sits out, and a presence message is routed like any other.
 */
function wakes(
	seat: SeatRuntime,
	target: SeatRuntime | undefined,
	message: Message,
	fromAide: boolean,
): boolean {
	// Nothing an aide writes wakes anybody: a room that woke because somebody's
	// aide wanted something is a room run by a proxy. The guard is on the
	// author rather than on what it wrote, so it holds for anything an aide
	// ever writes. Every seat still reads it.
	if (fromAide) return false;
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

/**
 * What a refused author is told. The runtime states what it missed; the
 * sentences around that belong to the kind of writing it was doing.
 */
function refusal(opening: string, missed: Message[], advice: string): string {
	return [opening, ...missed.map(renderLine), advice].join('\n');
}

/** What a write tool returns when the record took it. */
function delivered(): AgentToolResult<Record<string, never>> {
	return { content: [{ type: 'text', text: 'delivered' }], details: {} };
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
