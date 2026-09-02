/**
 * The vocabulary: what a room is made of, as types.
 *
 * Every name here is one a host reads or writes — a message on the record, a
 * seat in the roster, an event on the stream, a definition it wrote itself.
 * Nothing in this file does anything; the files beside it are what happens.
 */
import type { AgentToolResult, ExecutionEnv } from '@earendil-works/pi-agent-core';
import type { Static, TSchema } from 'typebox';
import type { ClosedExchange, Exchange } from './exchange.ts';

/** A position on the record: monotonic, assigned at commit, never reused. */
export type Seq = number;

/** What a participant said. */
export interface SpokenMessage {
	kind: 'said';
	seq: Seq;
	/** ISO timestamp, stamped by the runtime at the moment it landed. */
	at: string;
	/** A participant's name — stamped by the runtime, never claimed. */
	from: string;
	/** Present when the delivery or say was directed. */
	to?: string;
	text: string;
}

/** The two ways a person's presence changes. */
export type PresenceChange = 'arrived' | 'left';

/**
 * What a person did. It carries no text, because they said nothing: writing
 * words under their name is what rule 7 exists to prevent.
 */
export interface PresenceMessage {
	kind: PresenceChange;
	seq: Seq;
	at: string;
	/** The person, stamped from the visit the runtime observed. */
	from: string;
	/**
	 * How the room knew them, on `arrived` alone. Replay rebuilds the roster
	 * from the record, and a name without an identity is not a roster line.
	 */
	identity?: string;
}

/**
 * What one exchange came to. An assistant writes it. Nobody speaks it, so it is not
 * a `said`: a person did not hear it in a room.
 */
export interface SummaryMessage {
	kind: 'summary';
	seq: Seq;
	at: string;
	/** The assistant that wrote it. */
	from: string;
	/** The person whose question opened the exchange. Always present. */
	to: string;
	text: string;
	/** The range it stands for, contiguous and ending just before this seq. */
	covers: { from: Seq; through: Seq };
}

/**
 * A reminder that came due. The agent that set it wrote the text, at an
 * earlier time, for its later self; the room's clock decides when it lands.
 * It is not a `said`: nobody spoke at the moment it landed.
 */
export interface ReminderMessage {
	kind: 'reminder';
	seq: Seq;
	at: string;
	/** The agent that set it — stamped by the runtime from the reminder's owner. */
	from: string;
	text: string;
	/** When the agent set it, ISO. */
	setAt: string;
}

/** One entry on a session's record. */
export type Message = SpokenMessage | PresenceMessage | SummaryMessage | ReminderMessage;

export function isSpoken(message: Message): message is SpokenMessage {
	return message.kind === 'said';
}

export function isSummary(message: Message): message is SummaryMessage {
	return message.kind === 'summary';
}

export function isReminder(message: Message): message is ReminderMessage {
	return message.kind === 'reminder';
}

/** Whether a seat is taking an activation. Runtime state, not a seating choice. */
export type SeatStatus = 'active' | 'idle';

/**
 * What wakes a seat, as the widest kind of message it activates for. One
 * widening scale, not a set of flags: `none` is woken by nothing said in the
 * room, `named` hears a message addressed to it, `broadcast` also hears
 * anything a participant said, and `presence` also hears somebody arriving or
 * leaving.
 *
 * `none` is the seat that is present and unreachable — an assistant, which writes
 * for one person and wakes only when their exchange closes. Widening it is
 * what lets an assistant take part in the room like any other agent.
 */
export type Attention = 'none' | 'named' | 'broadcast' | 'presence';

/** A person is in the room or they are not. */
export type PresenceStatus = 'present' | 'absent';

export interface AgentSeatInfo {
	kind: 'agent';
	name: string;
	identity: string;
	status: SeatStatus;
	attention: Attention;
	/** The id of the seat's downstream Pi session, `<room>:<agent>`. */
	sessionId: string;
	/** The person this seat writes for, when it is their assistant. */
	owner?: string;
}

export interface HumanSeatInfo {
	kind: 'human';
	name: string;
	identity: string;
	presence: PresenceStatus;
	/**
	 * The name of the assistant they brought. Absent when the room is read, not
	 * run, and after a restart before they visit again: the assistant is seated
	 * as run state, like an exchange.
	 */
	assistant?: string;
}

export type SeatInfo = AgentSeatInfo | HumanSeatInfo;

/** The session's event stream: room-level facts, one event per fact. */
export type SessionEvent =
	/**
	 * A message landed on the record. Exactly one of these per message,
	 * whoever wrote it: what a person delivered, what an agent said, what an
	 * assistant wrote, and a person arriving or leaving all reach a host the same
	 * way.
	 */
	| { type: 'message'; message: Message }
	/**
	 * The room woke a seat. One per activation, however many requests to a
	 * provider it takes: an activation is the room's span, and Pi's own `turn`
	 * — one request and the tools it calls — never surfaces here.
	 */
	| { type: 'activation_start'; agent: string }
	/**
	 * The lock refused a message drafted against a record that had moved. It
	 * names the author rather than the seat: a seat's say and an assistant's summary
	 * are refused the same way, for the same reason.
	 */
	| { type: 'conflict'; author: string; missed: Message[] }
	| { type: 'tool_execution_start'; agent: string; toolName: string }
	| { type: 'tool_execution_end'; agent: string; toolName: string }
	/** The seat stopped, and `spoke` says whether it left a mark on the record. */
	| { type: 'activation_end'; agent: string; spoke: boolean }
	| { type: 'error'; agent: string; error: Error }
	/**
	 * A person's question opened an exchange: the room has an exchange to work on,
	 * and one person owns it. A client that folds the working under the
	 * question it answered starts here, whatever the person's assistant makes
	 * of it later.
	 */
	| { type: 'exchange_opened'; exchange: Exchange }
	/**
	 * The room went quiet with an exchange open, so that exchange is over and
	 * holds the range it turned out to cover. It arrives after `settled` and
	 * before any summary: an assistant is the first reader of this, not the only
	 * one.
	 */
	| { type: 'exchange_closed'; exchange: ClosedExchange }
	/**
	 * Nothing is running: no seat is taking an activation, and no assistant still owes a
	 * message. The room's own last word on a stretch of work.
	 *
	 * There is no event for the seats stopping. A host that wants the exchange is
	 * told by `exchange_closed`, which says whose it was and what it covered;
	 * a host that wants to act in the window before a summary lands waits on
	 * `settled()`, because that is a caller's concern rather than something
	 * that happened to the room.
	 */
	| { type: 'quiet' };

export const TOOL_BRAND = Symbol.for('ambion.tool');
export const AGENT_BRAND = Symbol.for('ambion.agent');
export const HUMAN_BRAND = Symbol.for('ambion.human');
export const SEAT_BRAND = Symbol.for('ambion.seat');
export const WORKSPACE_BRAND = Symbol.for('ambion.workspace');

/**
 * What a tool's `execute` is handed beside its parameters: the calling
 * agent's workspace, resolved fresh on every call, and the abort signal Pi
 * gives the tool call.
 */
export interface ToolContext {
	/** The calling agent's workspace, or undefined if it has none or it is destroyed. */
	workspace(): Promise<Workspace | undefined>;
	readonly signal?: AbortSignal;
}

/** A tool defined with Ambion's `defineTool` facade. */
export interface AmbionTool<TParameters extends TSchema = TSchema> {
	readonly [TOOL_BRAND]: true;
	readonly name: string;
	readonly description: string;
	readonly parameters: TParameters;
	readonly execute: (
		params: Static<TParameters>,
		ctx: ToolContext,
	) => Promise<string | AgentToolResult<unknown>> | string | AgentToolResult<unknown>;
}

/**
 * The identity and data boundary an agent connects to when it is defined.
 * `name` is the durable identity; the backend and the destroyed mark sit
 * behind the brand, where `workspace.ts` reads them.
 */
export interface WorkspaceHandle {
	readonly [WORKSPACE_BRAND]: true;
	readonly name: string;
}

/**
 * What a tool receives from `ctx.workspace()`: the workspace's name, the
 * environment the backend built for the calling agent, and the reminders the
 * calling agent holds. `env` is one property so a later kind of entity gets a
 * property beside it; `reminders` is the second such kind.
 */
export interface Workspace {
	readonly name: string;
	readonly env: ExecutionEnv;
	readonly reminders: Reminders;
}

/**
 * A reminder: a text an agent wrote for its later self, held in a workspace
 * until it is due, and delivered into one session as a message that wakes the
 * agent that set it.
 */
export interface Reminder {
	/** The store's own id for it, assigned when it is set. */
	readonly id: string;
	/** The agent that set it, and the only one it wakes. */
	readonly owner: string;
	/** The session it is delivered into: the one it was set in. */
	readonly session: string;
	readonly text: string;
	/** When it is next due, ISO. */
	readonly due: string;
	/** The interval it repeats at, in milliseconds. Absent for a reminder delivered once. */
	readonly every?: number;
	/** When it was set, ISO. */
	readonly setAt: string;
}

/** What a caller gives to set a reminder. Exactly one of `at` and `after`. */
export interface ReminderInput {
	readonly text: string;
	/** When it is due, ISO 8601, in the future. */
	readonly at?: string;
	/** How long from now: a count and a unit, such as `'90s'`, `'20m'`, `'2h'`, `'3d'`. */
	readonly after?: string;
	/** Repeat at this interval once due, in the same form. At least one minute. */
	readonly every?: string;
}

/**
 * The calling agent's reminders in its workspace, bound to the session the
 * tool call runs in. `set` holds the reminder in the workspace and arms it in
 * that session; `list` and `cancel` reach the agent's own reminders alone.
 */
export interface Reminders {
	set(input: ReminderInput): Promise<Reminder>;
	list(): Promise<Reminder[]>;
	/** True when a reminder of the calling agent's was removed. */
	cancel(id: string): Promise<boolean>;
}

/**
 * Where a backend holds reminders. `list` returns every reminder in the
 * workspace, `put` writes one by its id, and `remove` deletes one. The room
 * reads the store back at the moment a reminder is due, so the store is what
 * decides whether one is still set.
 */
export interface ReminderStore {
	list(): Promise<Reminder[]>;
	put(reminder: Reminder): Promise<void>;
	remove(id: string): Promise<void>;
}

/**
 * What backs a workspace: one function that builds an agent's environment,
 * and one that deletes everything held under the workspace's name.
 */
export interface WorkspaceBackend {
	/**
	 * Build the environment for one agent, rooted at its own home and carrying
	 * whatever identity the backend gives an agent. Called on every
	 * `ctx.workspace()`; it creates what is missing and remembers nothing.
	 */
	connect(agent: AgentDefinition, signal?: AbortSignal): Promise<ExecutionEnv>;
	/** Delete everything the backend holds for this workspace. Called once. */
	destroy(): Promise<void>;
	/** The reminders the workspace holds, for every agent that connects to it. */
	readonly reminders: ReminderStore;
}

export interface AgentDefinition {
	readonly [AGENT_BRAND]: true;
	readonly name: string;
	readonly identity: string;
	readonly instructions: string;
	readonly model: string;
	readonly tools: readonly unknown[];
	/** The workspace this agent reaches through its tools, when it has one. */
	readonly workspace?: WorkspaceHandle;
}

export interface HumanDefinition {
	readonly [HUMAN_BRAND]: true;
	readonly name: string;
	readonly identity: string;
	/**
	 * The person's counterpart in a room: it holds how they read, writes the one
	 * message they read at the end of an exchange, and never speaks for them.
	 * Every person brings one.
	 */
	readonly assistant: AgentDefinition;
}

/** An agent with its attention chosen, from `seated()` or its two shorthands. */
export interface SeatedAgent {
	readonly [SEAT_BRAND]: true;
	readonly agent: AgentDefinition;
	readonly attention: Attention;
}

/** What `startSession` seats: an agent on its own, or one with an attention. */
export type AgentSeat = AgentDefinition | SeatedAgent;

/** Who may be addressed by name. */
export type Participant = AgentDefinition | HumanDefinition;

export function isAgent(p: unknown): p is AgentDefinition {
	return typeof p === 'object' && p !== null && AGENT_BRAND in p;
}

export function isSeatedAgent(p: unknown): p is SeatedAgent {
	return typeof p === 'object' && p !== null && SEAT_BRAND in p;
}

export function isAmbionTool(t: unknown): t is AmbionTool {
	return typeof t === 'object' && t !== null && TOOL_BRAND in t;
}

export function isWorkspace(w: unknown): w is WorkspaceHandle {
	return typeof w === 'object' && w !== null && WORKSPACE_BRAND in w;
}
