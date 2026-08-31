import type {
	AgentEvent,
	AgentTool,
	Session as PiSession,
	SessionRepo,
	StreamFn,
} from '@earendil-works/pi-agent-core';
import { Agent, InMemorySessionRepo } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { Type } from 'typebox';
import {
	AIDE_PARAGRAPH,
	aideHeader,
	type Draft,
	draftOver,
	SUMMARY_PARAGRAPH,
	summariseTool,
} from './aide.ts';
import { seated } from './define.ts';
import { type ClosedExchange, type Exchange, Exchanges } from './exchange.ts';
import {
	type PersonView,
	renderAgents,
	renderClock,
	renderLine,
	renderPeople,
	renderRecord,
} from './render.ts';
import {
	delivered,
	openOrCreate,
	persistTurns,
	refusal,
	runFailure,
	toError,
	userMessage,
} from './turn.ts';
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
	/**
	 * The person this seat writes for, when it is their aide. It is what makes
	 * a seat an aide: nothing it writes wakes anybody, a closed exchange of
	 * theirs is what wakes it, and the summary it writes is addressed to them.
	 */
	owner?: string;
	/**
	 * The exchange this activation is closing, on a summarising turn. It holds
	 * one tool instead of its own, and the range that tool commits against.
	 */
	closing?: Draft;
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
	lastSeq = 0;
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
		this.lastSeq = this.entries.at(-1)?.seq ?? 0;
		return piSession;
	}

	/**
	 * Take the next seq, synchronously — the say tool's conflict check and this
	 * push must share one tick, or a rival say could slip between them.
	 * Persistence follows in commit order on a write chain.
	 */
	append<T extends Message>(message: Omit<T, 'seq'>): T {
		const stamped = { ...message, seq: ++this.lastSeq } as T;
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
	/** The aide each person brought, keyed by the person. Aides are seats too. */
	private readonly aideOf = new Map<string, SeatRuntime>();
	private readonly here = new Attendance(() => this.record);
	private readonly listeners = new Set<(event: SessionEvent) => void>();
	private readonly settledWaiters: (() => void)[] = [];
	private readonly quietWaiters: (() => void)[] = [];
	private readonly streamFn: StreamFn;
	private readonly customStream: boolean;
	private activeCount = 0;
	private stopped = false;
	/** The room's rounds: what a question opened, and what quiescence closes. */
	private readonly exchanges = new Exchanges();
	/**
	 * People who are owed a summary, and the seq their range starts at. A race
	 * or a failed turn leaves one owed; the next quiet room writes it.
	 */
	private readonly owed = new Map<string, Seq>();

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
			active: false,
			spoke: false,
			aborted: false,
			viewSeq: 0,
			pendingSteers: [],
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

	/** Whether a seat that speaks for itself is taking a turn. An aide is not one. */
	private working(): boolean {
		for (const seat of this.agents.values()) {
			if (seat.active && seat.owner === undefined) return true;
		}
		return false;
	}

	quiet(): Promise<void> {
		// The same condition the `quiet` event reports. A summary a race left
		// owed is not work in flight: it waits for the next quiet room, and the
		// room is quiet in the meantime.
		if (this.activeCount === 0) return Promise.resolve();
		return new Promise((resolve) => this.quietWaiters.push(resolve));
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
				...(seat.owner === undefined ? {} : { owner: seat.owner }),
			});
		}
		for (const [name, identity] of this.here.known()) {
			const aide = this.aideOf.get(name)?.def.name;
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
		if (!human.aide || this.aideOf.has(human.name)) return;
		// Seated at the narrow end: nothing said in the room wakes an aide, and
		// only the close of its person's exchange does. §12's rung 3 is this
		// line widened, and a `say` in its hands.
		const seat = this.seat(seated(human.aide, 'none'));
		seat.owner = human.name;
		this.aideOf.set(human.name, seat);
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
		// The message lands, then what it opened: a round is a fact about a
		// message the host has already seen. Both come before the routing, so
		// nothing wakes on a message the host has not heard about.
		this.emit({ type: 'message', message });
		this.noteExchange(message);
		this.dispatch(message);
	}

	/** A person's question opens a round, and the room says so. */
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
		const fromAide = this.agents.get(message.from)?.owner !== undefined;
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
		const closing = seat.closing;
		void this.run(seat).finally(() => {
			seat.active = false;
			seat.agent = undefined;
			if (closing) this.closedTurn(seat, closing);
			this.emit({ type: 'agent_end', agent: seat.def.name, spoke: seat.spoke });
			this.activeCount -= 1;
			// A round ends when the seats stop. An aide writing about the round
			// is not the room still working on it, so its own turn ends no round
			// — which is also what keeps a failing aide from retrying for ever.
			if (seat.owner === undefined && !this.working()) {
				this.emit({ type: 'settled' });
				for (const resolve of this.settledWaiters.splice(0)) resolve();
				this.closeExchange();
			}
			if (this.activeCount === 0) this.markQuiet();
		});
	}

	private async run(seat: SeatRuntime): Promise<void> {
		// A turn rebuilds while the room keeps moving under it, and ends when it
		// has nothing left to read.
		while (await this.takeTurn(seat)) {
			// nothing: the next pass reads the record as it now stands.
		}
	}

	/** One pass at a turn. True when a message landed and it must read again. */
	private async takeTurn(seat: SeatRuntime): Promise<boolean> {
		try {
			// A fresh view hands the seat the whole record: heard up to here.
			seat.viewSeq = this.store.lastSeq;
			seat.pendingSteers = [];
			const agent = this.buildAgent(seat);
			seat.agent = agent;
			await agent.prompt(userMessage(this.renderContext(seat)));
			await this.persistRun(seat, agent);
			const failure = runFailure(agent);
			if (failure) return this.turnFailed(seat, failure);
			// An aborted turn stays cancelled: Pi's abort() ends the run but
			// leaves its queues, and a queued steer must not rebuild the turn.
			// A summarising turn is one pass either way: its answer to a room
			// that moved is the redraft inside `summarise`, not a fresh turn.
			if (seat.aborted || seat.closing) return false;
			// A steer that raced past the run's last drain is not lost: the
			// message is already on the record, so a fresh view carries it.
			if (!agent.hasQueuedMessages()) return false;
			agent.clearAllQueues();
			return true;
		} catch (error) {
			return this.turnFailed(seat, toError(error));
		}
	}

	/** A turn that never reached the record. The room hears it and moves on. */
	private turnFailed(seat: SeatRuntime, error: Error): false {
		if (seat.closing) seat.closing.failed = true;
		this.emit({ type: 'error', agent: seat.def.name, error });
		return false;
	}

	private async persistRun(seat: SeatRuntime, agent: Agent): Promise<void> {
		await persistTurns(this.seatSession(seat), agent);
	}

	private buildAgent(seat: SeatRuntime): Agent {
		const agent = new Agent({
			streamFn: this.streamFn,
			initialState: {
				systemPrompt: this.systemPrompt(seat),
				model: this.resolveModel(seat.def),
				thinkingLevel: 'off',
				tools: this.handsFor(seat),
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
	 * What a turn holds. A seat speaks and uses its own tools; an aide closing
	 * an exchange holds one hand, and it reaches the record. `defineHuman`
	 * refuses an aide that carries tools of its own, so there is nothing else
	 * to leave out.
	 */
	private handsFor(seat: SeatRuntime): AgentTool[] {
		// An aide's hands are the runtime's, and it holds them only for the turn
		// it was woken for. Nothing wakes an aide today but the close of its
		// person's exchange; when something else does — a wider attention, per
		// FOLLOW_WORK.md — it must arrive with empty hands until somebody adds a
		// `say` here on purpose. §12's rung 3 is a decision, not a consequence.
		if (seat.owner !== undefined) {
			return seat.closing ? [this.summarise(seat, seat.owner, seat.closing)] : [];
		}
		return [this.sayTool(seat), ...seat.def.tools.map(toPiTool)];
	}

	/** The one hand an aide is given, bound to the range it must stand for. */
	private summarise(seat: SeatRuntime, person: string, closing: Draft): AgentTool {
		return summariseTool(seat.def.name, person, closing, {
			stopped: () => this.stopped,
			lastSeq: () => this.store.lastSeq,
			claim: (author, draft) => this.claim<SummaryMessage>(author, draft),
			publish: (message) => this.publish(message),
			written: () => {
				seat.spoke = true;
			},
		});
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
				const text = params.text.trim();
				// A message with nothing in it still takes a seq, renders in
				// every context after it, and stands inside whatever range a
				// summary covers. Saying nothing is ending the turn.
				if (text === '') {
					throw new Error('The message is empty. Say something, or end your turn instead.');
				}
				const claimed = this.claim<SpokenMessage>(
					{ name: seat.def.name, readThrough: seat.viewSeq },
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
					seat.viewSeq = this.store.lastSeq;
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
	 * missed. A seat's say and an aide's summary are refused the same way, for
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

	// -- the aide ------------------------------------------------------------

	/**
	 * The room went quiet, so the round it was working on is over. The host
	 * hears that before anything is written about it: an aide is the first
	 * reader of a closed exchange and not the only one.
	 */
	private closeExchange(): void {
		const closing = this.exchanges.close(this.store.lastSeq);
		if (closing) this.emit({ type: 'exchange_closed', exchange: closing });
		this.summariseClosed(closing);
	}

	/**
	 * What an aide makes of a closed exchange: its owner's aide wakes, and so
	 * does any whose summary a race or a failure left owed. Nothing else in the
	 * room wakes for a close — an aide is seated `none`, and the close is the
	 * one thing that reaches it.
	 */
	private summariseClosed(closing: ClosedExchange | undefined): void {
		if (closing) this.oweSummary(closing.owner, closing.from);
		// Every quiet room is a chance to write what is owed, whatever made the
		// room busy. An aide's own turn ends no round, so a failed draft waits
		// for the next time the seats stop rather than retrying on itself.
		for (const [person, from] of [...this.owed]) this.wakeAide(person, from);
	}

	/**
	 * One person may be owed one summary. A second exchange that closes while
	 * the first is still owed widens the range back to the earlier question,
	 * because that is what its person has not read.
	 */
	private oweSummary(person: string, from: Seq): void {
		if (!this.aideOf.has(person)) return;
		const already = this.owed.get(person);
		this.owed.set(person, already === undefined ? from : Math.min(already, from));
	}

	/**
	 * One exchange, one message — when the room said more than one thing. One
	 * answer is left as it was given, in the voice that gave it, and an
	 * exchange the agents said nothing into wakes nobody at all.
	 */
	private wakeAide(person: string, from: Seq): void {
		const seat = this.aideOf.get(person);
		if (!seat || seat.active) return;
		const draft = draftOver(this.record, from, this.store.lastSeq, (name) =>
			this.speaksForItself(name),
		);
		this.owed.delete(person);
		if (!draft) return;
		seat.closing = draft;
		this.activate(seat);
	}

	/** A seat that speaks for itself: an agent in the room, and not somebody's aide. */
	private speaksForItself(name: string): boolean {
		const seat = this.agents.get(name);
		return seat !== undefined && seat.owner === undefined;
	}

	/**
	 * A summarising turn is over. It wrote, or it judged that one message
	 * already served; a race or a failed turn leaves the range owed, and the
	 * next closed exchange is another chance.
	 */
	private closedTurn(seat: SeatRuntime, draft: Draft): void {
		seat.closing = undefined;
		if (seat.spoke || seat.owner === undefined) return;
		if (draft.refusals > 0 || draft.failed) this.oweSummary(seat.owner, draft.from);
	}

	/**
	 * The room is quiet: no seat is taking a turn, and no aide still owes one.
	 * A summary that a race refused is not work in flight — it waits for the
	 * next quiescence, and the room is quiet in the meantime.
	 *
	 * A stopped room never reports this. Shutdown aborts the turns in flight
	 * and drains whoever waited, and a room that is closing is not a room that
	 * has gone quiet.
	 */
	private markQuiet(): void {
		if (this.stopped || this.activeCount > 0) return;
		this.emit({ type: 'quiet' });
		for (const resolve of this.quietWaiters.splice(0)) resolve();
	}

	// -- what an agent reads -------------------------------------------------

	/** One entry per person the room knows, with their gap and what they missed. */
	private peopleViews(): PersonView[] {
		const views: PersonView[] = [];
		for (const [name, identity] of this.here.known()) {
			const since = this.here.sinceOf(name);
			const aide = this.aideOf.get(name)?.def.name;
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
		const lines =
			seat.owner === undefined
				? [
						`You are '${seat.def.name}', an agent seated in the session '${this.name}' — a shared`,
						`room with a record. Every participant sees what is said; nobody sees your tool use.`,
						``,
					]
				: [...aideHeader(seat.def.name, seat.owner, this.name), ``];
		if (this.goal) lines.push(`This session exists to: ${this.goal}`, ``);
		lines.push(...this.duties(seat), ``);
		lines.push(
			`Your identity, as the room knows it: ${seat.def.identity}`,
			``,
			`Your instructions:`,
			seat.def.instructions.trim(),
		);
		return lines.join('\n');
	}

	/** What this seat is for: an aide writes one message, a seat speaks or does not. */
	private duties(seat: SeatRuntime): string[] {
		if (seat.owner !== undefined) return AIDE_PARAGRAPH;
		const lines = [
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
			...AUDIENCE_PARAGRAPH,
		];
		// A fold only renders in a room where somebody brought an aide, so only
		// such a room tells its seats how to read one.
		if (this.aideOf.size > 0) lines.push(``, ...SUMMARY_PARAGRAPH);
		return lines;
	}

	private renderContext(seat: SeatRuntime): string {
		const now = Date.now();
		const people = this.peopleViews();
		return [
			renderClock(now),
			``,
			`The agents. Each is seated at one point of a scale — the widest kind of message`,
			`that wakes it. Unmarked: anything said. "named only": a say addressed to it.`,
			`"watches arrivals": also somebody arriving or leaving. "wakes for nothing said":`,
			`nothing reaches it and you cannot address it. "writes for <name>" is that`,
			`person's aide, which writes the one message they read when their exchange closes.`,
			`(active: taking a turn now; idle: at rest.)`,
			renderAgents(this.seats()),
			``,
			`The people (present: in the room now; absent: not in the room):`,
			renderPeople(people, now),
			``,
			`The record of '${this.name}' so far:`,
			renderRecord(this.record, people, now),
			``,
			this.askOf(seat),
		].join('\n');
	}

	/** What this turn is for, in the last line the model reads. */
	private askOf(seat: SeatRuntime): string {
		const closing = seat.closing;
		if (seat.owner !== undefined) {
			// An aide woken by anything but a close has nothing to do with the
			// turn, and no hands to do it with. See `handsFor`.
			return closing
				? `${seat.owner}'s exchange is over: messages ${closing.from} to ${closing.through}. ` +
						`Write the one message they read for it, or end your turn to leave the range whole.`
				: `Nothing is asked of you: read the room, and end your turn.`;
		}
		return `Take your turn, ${seat.def.name}: say something, or end your turn to stay silent.`;
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

/** The attention scale, narrowest first. A seat hears what it is wide enough for. */
const WIDTH: Record<Attention, number> = { none: 0, named: 1, broadcast: 2, presence: 3 };

/**
 * How wide a seat's attention has to be for this message to reach it: a
 * directed say reaches the one it names, anything else said reaches the room,
 * and a person arriving or leaving reaches the widest end.
 */
function reachOf(message: Message): Attention {
	if (!isSpoken(message)) return 'presence';
	return message.to === undefined ? 'broadcast' : 'named';
}

/**
 * One rule, read off the scale: a seat wakes when its attention is at least as
 * wide as the message's reach — and a directed message additionally wakes the
 * one it names and nobody else. Rule 1 routes, rule 6 decides who sits out,
 * and a presence message is routed like any other.
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
	const reach = reachOf(message);
	if (WIDTH[seat.attention] < WIDTH[reach]) return false;
	return reach === 'named' ? seat === target : true;
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
