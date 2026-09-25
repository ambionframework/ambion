/**
 * The tool bundle: tools, the guidance that explains their use, and the
 * reminder that a bundle gives each activation of a seat. The shape of one
 * tool, what a call receives, and what it hands back live here too. The core
 * flattens bundles at definition time (`define.ts`).
 */
import type { TSchema } from 'typebox';
import type { ExchangeRef } from './types.ts';

/**
 * What a tool's `execute` is handed beside its parameters: the calling agent
 * and the abort signal the executor gives the tool call.
 */
export interface ToolContext {
	/** Stable identity of the agent making this tool call. */
	readonly agent: { readonly name: string; readonly identity: string };
	readonly signal?: AbortSignal;
	readonly callId: string;
	readonly onUpdate?: ToolUpdate;
	/** Name of the room this call ran in. Absent for a call made outside a room. */
	readonly room?: string;
	/**
	 * The activation this call ran in: the id every execution event and every
	 * recorded message carries. Absent for a call made outside a room.
	 */
	readonly activation?: string;
	/**
	 * The exchange that was open when the activation read the record. Absent
	 * outside a room, and absent when no exchange was open.
	 */
	readonly exchange?: Pick<ExchangeRef, 'owner' | 'from'>;
	/** When the room ends the activation, in ms since the epoch on the wall clock. Absent outside a room. */
	readonly deadline?: number;
}

/** One normalized tool definition used by the room executor. */
export interface AmbionTool {
	readonly name: string;
	readonly description: string;
	readonly parameters: TSchema;
	readonly label: string;
	readonly prepareArguments?: (args: unknown) => unknown;
	readonly executionMode?: ToolExecutionMode;
	readonly invoke: (
		params: unknown,
		ctx: ToolContext,
	) => Promise<string | ToolResult> | string | ToolResult;
}

/** Whether an executor runs the calls of one activation in turn or together. */
export type ToolExecutionMode = 'sequential' | 'parallel';

/** What a tool hands back to the model: content it reads, and details it does not. */
export interface ToolResult {
	readonly content: (
		| { readonly type: 'text'; readonly text: string }
		| { readonly type: 'image'; readonly data: string; readonly mimeType: string }
	)[];
	readonly details: unknown;
	/** Ends the activation after this result when every call of the batch sets it. */
	readonly terminate?: boolean;
}

/** A tool's progress report while it runs. */
export type ToolUpdate = (partial: ToolResult) => void;

/** A composable set of tools and the guidance that explains their use. */
export interface ToolBundle {
	readonly tools: readonly AmbionTool[];
	readonly guidance?: string;
	/**
	 * Text for one respond activation of one seat, or undefined for none. The
	 * executor calls it once, at the start of the activation, and the text
	 * joins the turn context. A throw, a rejection, or no answer within
	 * `REMINDER_TIMEOUT_MS` gives no text. At that bound the executor aborts
	 * `signal`, so a reminder that records what it showed records nothing.
	 */
	readonly remind?: Reminder;
}

/** The seat and the activation that a reminder writes for. */
export interface ReminderSeat {
	/** The name of the agent that the seat runs. */
	readonly agent: string;
	/** The room of the activation. */
	readonly room: string;
	/** The id of the activation. */
	readonly activation: string;
}

/** A bundle's text for one activation. It runs where the executor runs, and it can read I/O. */
export type Reminder = (
	seat: ReminderSeat,
	signal: AbortSignal,
) => string | undefined | Promise<string | undefined>;
