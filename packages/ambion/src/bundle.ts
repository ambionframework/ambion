/**
 * The tool bundle: tools, the guidance that explains their use, and the
 * reminder that a bundle gives each activation of a seat. The shape of one
 * tool, what a call receives, and what it hands back live here too. The core
 * flattens bundles at definition time (`define.ts`).
 */
import type { Static, TSchema } from 'typebox';
import type { ComposeMacro } from './compose.ts';
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
	 * The activation this call ran in: the id every activation event and every
	 * recorded message carries. Absent for a call made outside a room.
	 */
	readonly activation?: string;
	/**
	 * The exchange that was open when the activation read the record. Absent
	 * outside a room, and absent when no exchange was open.
	 */
	readonly exchange?: Pick<ExchangeRef, 'person' | 'from'>;
	/** When the room ends the activation, in ms since the epoch on the wall clock. Absent outside a room. */
	readonly deadline?: number;
	/**
	 * The id of the `compose` call that made this call. Absent for a direct
	 * call. `compose` sets it, and code cannot set it. It changes no
	 * permission and no effect. A tool records no step: the core records the
	 * steps of a nested call.
	 */
	readonly composeCall?: string;
}

/** One normalized tool definition used by the room executor. */
export interface AmbionTool {
	readonly name: string;
	readonly description: string;
	readonly parameters: TSchema;
	readonly label: string;
	readonly prepareArguments?: (args: unknown) => unknown;
	readonly executionMode?: ToolConcurrency;
	/**
	 * How the `compose` tool binds this tool. `false` leaves the tool out of
	 * the catalog. `{ output }` declares the shape of `details`, and the
	 * binding returns `details`. Absent, the binding returns the text of
	 * `content`.
	 */
	readonly compose?: false | { readonly output: TSchema };
	readonly invoke: (
		params: unknown,
		ctx: ToolContext,
	) => Promise<string | ToolResult> | string | ToolResult;
}

/** The fields that every tool definition holds, whether or not it declares an output. */
export interface BaseToolOptions<TParameters extends TSchema> {
	name: string;
	description: string;
	parameters: TParameters;
	label?: string;
	prepareArguments?: (args: unknown) => Static<TParameters>;
	executionMode?: ToolConcurrency;
}

/**
 * A tool with no declared output. `compose` binds it as text, or leaves it out
 * when `compose` is `false`.
 */
export interface PlainToolOptions<
	TParameters extends TSchema,
> extends BaseToolOptions<TParameters> {
	compose?: false;
	/**
	 * Return a string (or the full content shape when needed). Throw on failure.
	 * `ctx.agent` identifies the calling agent and `ctx.signal` is the abort
	 * signal the executor gives the tool call. `ctx.room`, `ctx.activation`, and
	 * `ctx.exchange` name the room, the activation, and the open exchange the
	 * call ran in.
	 */
	execute: (
		params: Static<TParameters>,
		ctx: ToolContext,
	) => Promise<string | ToolResult> | string | ToolResult;
}

/**
 * A tool that declares its output. `execute` returns a tool result whose
 * `details` match the schema, and `compose` binds those `details`. The
 * compiler infers `TDetails` from the result and checks it against the
 * schema, so a literal in the result keeps its literal type.
 */
export interface DeclaredToolOptions<
	TParameters extends TSchema,
	TOutput extends TSchema,
	TDetails extends Static<TOutput> = Static<TOutput>,
> extends BaseToolOptions<TParameters> {
	compose: { readonly output: TOutput };
	execute: (
		params: Static<TParameters>,
		ctx: ToolContext,
	) => Promise<ToolResult<TDetails>> | ToolResult<TDetails>;
}

/** Whether an executor runs the calls of one activation in turn or together. */
export type ToolConcurrency = 'sequential' | 'parallel';

/** One part of what a tool hands back to the model. */
export type ToolContent =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'image'; readonly data: string; readonly mimeType: string };

/** The text parts of a tool result, joined. An image part adds nothing. */
export function contentText(content: readonly ToolContent[]): string {
	return content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/** What a tool hands back to the model: content it reads, and details it does not. */
export interface ToolResult<TDetails = unknown> {
	readonly content: ToolContent[];
	readonly details: TDetails;
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
	 * The compose programs that the bundle carries, as data. A seat with the
	 * `compose` option runs one by name. A seat without it ignores them.
	 */
	readonly macros?: readonly ComposeMacro[];
	/**
	 * Text for one respond activation of one seat, or undefined for none. The
	 * executor calls it once, at the start of the activation, and the text
	 * joins the context. A throw, a rejection, or no answer within 5
	 * seconds gives no text. At that bound the executor aborts
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
