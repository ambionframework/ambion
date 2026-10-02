/**
 * The vocabulary of the `compose` tool: the option that a seat opts in with,
 * the evaluator that runs the code, and the result and the ledger that a
 * compose call reports. The tool joins the tools of a seat into one call
 * (`docs/compose.md`). The checks of the option and of the tool field live
 * here too.
 */
import { IsSchema } from 'typebox';
import type { ToolContext } from './bundle.ts';

/** A value that JSON holds. */
export type JsonValue =
	null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** What `compose` gives an evaluator for one compose call. */
export interface EvaluatorInput {
	/** The body of an asynchronous function. */
	readonly code: string;
	/** The names of the tools that the code can call as `tools.<name>`. */
	readonly bindings: readonly string[];
	/** Calls one binding. It resolves to the binding value, or rejects with `{ message, details? }`. */
	call(name: string, args: JsonValue): Promise<JsonValue>;
}

/**
 * The backend that evaluates the code of a compose call. It holds no tool,
 * no room, and no `ToolContext`. It gives the code no ambient authority.
 */
export interface Evaluator {
	evaluate(input: EvaluatorInput, signal: AbortSignal): Promise<JsonValue | undefined>;
}

/** The bounds of one compose call. */
export interface ComposeLimits {
	/** The nested calls in one compose call. */
	readonly calls: number;
	/** The nested calls that run at the same time. */
	readonly concurrent: number;
	/** The UTF-8 bytes of the encoded return value. */
	readonly bytes: number;
	/** The wall time of one compose call, in ms, within `ctx.deadline`. */
	readonly time: number;
}

/** The `compose` option of the executor options. With no option, the seat has no `compose` tool. */
export interface ComposeOptions {
	readonly evaluator: Evaluator;
	/**
	 * Called after `compose` checks `uses`, and before it evaluates any code.
	 * A denial fails the compose call with no ledger and no effect. With no
	 * hook, `compose` allows every compose call.
	 */
	readonly approve?: (
		request: { readonly uses: readonly string[]; readonly code: string },
		ctx: Omit<ToolContext, 'record'>,
	) => Promise<'allow' | 'deny'> | 'allow' | 'deny';
	/** Replaces `COMPOSE_GUIDANCE`. */
	readonly guidance?: string;
	/** A field that is absent keeps its default. */
	readonly limits?: Partial<ComposeLimits>;
}

/** One nested call of a compose call, with its outcome. It holds no input and no output. */
export interface LedgerEntry {
	/** The id of the nested call. */
	readonly call: string;
	readonly tool: string;
	readonly status: 'completed' | 'failed' | 'pending';
}

/** The `details` of the result of a compose call. */
export interface ComposeResult {
	readonly status: 'completed' | 'failed' | 'cancelled';
	readonly value?: JsonValue;
	readonly error?: { readonly message: string; readonly call?: string };
	/** The nested calls, in the order that the code made them. */
	readonly calls: readonly LedgerEntry[];
}

/** The name of the `compose` tool. A tool of the options cannot take it. */
export const COMPOSE_TOOL_NAME = 'compose';

const LIMIT_NAMES = ['calls', 'concurrent', 'bytes', 'time'];

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** Refuse a tool `compose` that is not absent, `false`, or an object with a TypeBox `output`. */
export function assertToolCompose(compose: unknown): void {
	if (compose === undefined || compose === false) return;
	if (!isRecord(compose) || !isRecord(compose.output) || !IsSchema(compose.output)) {
		throw new Error('Tool compose must be false or an object with an output schema.');
	}
}

/** Refuse a malformed `compose` option, when the agent is defined. */
export function assertComposeOptions(compose: unknown): void {
	if (compose === undefined) return;
	if (
		!isRecord(compose) ||
		!isRecord(compose.evaluator) ||
		typeof compose.evaluator.evaluate !== 'function'
	) {
		throw new Error('Agent compose must be an object with an evaluator.');
	}
	if (compose.approve !== undefined && typeof compose.approve !== 'function') {
		throw new Error('Agent compose approve must be a function.');
	}
	if (compose.guidance !== undefined && typeof compose.guidance !== 'string') {
		throw new Error('Agent compose guidance must be a string.');
	}
	assertComposeLimits(compose.limits);
}

function assertComposeLimits(limits: unknown): void {
	if (limits === undefined) return;
	if (!isRecord(limits)) throw new Error('Agent compose limits must be an object.');
	for (const [key, value] of Object.entries(limits)) {
		if (!LIMIT_NAMES.includes(key)) throw new Error(`Agent compose limits has no limit '${key}'.`);
		if (value !== undefined && !isCount(value))
			throw new Error(`Agent compose limits.${key} must be a positive integer.`);
	}
}

const isCount = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) > 0;
