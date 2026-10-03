/**
 * The vocabulary of the `compose` tool: the option that a seat opts in with,
 * the runtime that runs the code, and the result and the ledger that a
 * compose call reports. The tool joins the tools of a seat into one call
 * (`docs/compose.md`). The checks of the option and of the tool field live
 * here too.
 */
import { IsSchema, type TSchema } from 'typebox';
import { Errors } from 'typebox/value';
import type { ToolContext } from './bundle.ts';

/** A value that JSON holds. */
export type JsonValue =
	null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** What `compose` gives a runtime for one compose call. */
export interface ComposeRuntimeInput {
	/** The body of an asynchronous function. */
	readonly code: string;
	/** The names of the tools that the code can call as `tools.<name>`. */
	readonly bindings: readonly string[];
	/**
	 * The names of the tools that the seat has and this call does not bind.
	 * The code that reads `tools.<name>` for an unbound name gets an error that
	 * names the tool and the bound names. For a name in this list, the error
	 * says to add the name to `uses`. For any other name, it says that the seat
	 * has no such tool. Absent, the error does not tell the two apart.
	 */
	readonly unlisted?: readonly string[];
	/**
	 * The arguments of a macro, already checked against its schema. The code
	 * reads them as the global `args`. Absent for free code, where `args` is
	 * not defined.
	 */
	readonly args?: JsonValue;
	/** Calls one binding. It resolves to the binding value, or rejects with `{ message, details? }`. */
	call(name: string, args: JsonValue): Promise<JsonValue>;
}

/**
 * The backend that evaluates the code of a compose call. It holds no tool,
 * no room, and no `ToolContext`. It gives the code no ambient authority.
 */
export interface ComposeRuntime {
	evaluate(input: ComposeRuntimeInput, signal: AbortSignal): Promise<JsonValue | undefined>;
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

/**
 * What `approve` reads. Free code gives `uses` and `code`. A macro gives its
 * name, the blob hash of its file, and its checked `args`, which are `{}`
 * when the call leaves them out.
 */
export type ComposeRequest =
	| { readonly uses: readonly string[]; readonly code: string }
	| { readonly macro: string; readonly hash: string; readonly args: JsonValue };

/**
 * A stored compose program that a skill names. `compose` runs it by name,
 * under the tools in `uses`, with `args` checked against `args` schema. A
 * bundle carries macros as data. `composeMacro` makes one.
 */
export interface ComposeMacro {
	/** The name that the model gives `compose`: `<skill>/<macro>`. */
	readonly name: string;
	/** One line that the guidance shows beside the name. */
	readonly description: string;
	/** The tools that the code binds. */
	readonly uses: readonly string[];
	/** A JSON Schema that the `args` of a call must satisfy. */
	readonly args: { readonly [key: string]: JsonValue };
	/** The body of an asynchronous function, as `code` of a compose call. */
	readonly code: string;
	/** The git blob hash of the file that holds the macro. */
	readonly hash: string;
}

/**
 * The `compose` option of the executor options. `describeExecutor` adds the
 * `compose` tool and the `describe` tool for an option, and none for an
 * absent option. `pi()`, `claude()`, and `codex()` fill an absent option.
 */
export interface ComposeOptions {
	readonly runtime: ComposeRuntime;
	/**
	 * Called after `compose` checks `uses` or the macro and its `args`, and
	 * before it evaluates any code. A denial fails the compose call with no
	 * ledger and no effect. With no hook, `compose` allows every compose call.
	 */
	readonly approve?: (
		request: ComposeRequest,
		ctx: ToolContext,
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

/** The name of the `describe` tool, which returns the signatures of bindable tools. A tool of the options cannot take it. */
export const DESCRIBE_TOOL_NAME = 'describe';

/** What `compose` guides a model with: when a compose call helps, and when a direct call does. */
export const COMPOSE_GUIDANCE = `Plan the tool calls of a task before you make the first call. When the
plan has two or more tool calls, make them in one compose call. This
includes say and the other room tools. Each direct call costs one more
turn, and you read its whole result.

Write a compose call in two steps:
1. Call describe with the tools of the plan. It returns their
   signatures and the fields of each result.
2. Call compose. Put those tools in uses, and the body of an async
   function in code. Each tool is tools.<name>. Read the fields of each
   result, and do not parse text. You read only the value that the code
   returns.

Use compose also to explore. To learn the size or the shape of data,
return a count, a few fields, or a short sample from code. Do not read
large results one direct call at a time. Code with uses: [] calculates,
sorts, groups, and reshapes data that you already hold.

Call a tool directly only when:
- the next step needs your judgment of the result, and the task gives
  no rule for it;
- you make one call and need its whole result.

The say calls of one compose call run one after another. When the room
refuses a say because the record moved, the binding rejects, and the
compose result shows the new lines. Read them before you speak again.

A tool that fails rejects with an Error. error.details holds its result
when the tool gives one. bash rejects when the command exits with a code
other than 0. When the task expects such a failure, catch it with
.catch((error) => error.details) and read the details.

Return only the values that you need to read. The code has no clock,
no random source, and no I/O except through tools. A failed compose
call lists each call, its outcome, and the result of each completed
call, such as a process handle. A completed call can have had an
effect, so read the list before you call a tool again.

When a skill names a macro, call compose with the macro and its args,
and write no code. The macro holds the code and names its own tools.`;

/** The limits of a compose call that the option leaves unset. */
export const DEFAULT_COMPOSE_LIMITS: ComposeLimits = Object.freeze({
	calls: 64,
	concurrent: 8,
	bytes: 65_536,
	time: 120_000,
});

/**
 * A failed or cancelled compose call. The message renders the error and the
 * ledger, and `details` holds the `ComposeResult`.
 */
export class ComposeFailure extends Error {
	override readonly name = 'ComposeFailure';
	readonly details: ComposeResult;

	constructor(message: string, details: ComposeResult) {
		super(message);
		this.details = details;
	}
}

/**
 * What the arguments of a call break in a schema, as the model reads it:
 * each property path and its rule, such as `handles must not have fewer
 * than 1 items`. A rule on the whole value has no path.
 */
export function mismatchOf(schema: TSchema, value: unknown): string {
	return Errors(schema, value)
		.map((error) => {
			const path = error.instancePath.slice(1).replaceAll('/', '.');
			return path === '' ? error.message : `${path} ${error.message}`;
		})
		.join('; ');
}

/**
 * A copy of a value that JSON holds. A function, a symbol, a bigint, a
 * number that is not finite, a value that is not a plain object, and a cycle
 * each throw an error that names the place. An object property that holds
 * `undefined` is absent, as `JSON.stringify` writes it.
 */
export function plainJson(value: unknown, where = 'the value'): JsonValue {
	return copyJson(value, where, []);
}

function copyJson(value: unknown, where: string, path: readonly object[]): JsonValue {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value !== 'object')
		throw new Error(`${where} is not JSON: it holds ${describe(value)}.`);
	if (path.includes(value)) throw new Error(`${where} is not JSON: it holds a cycle.`);
	const inside = [...path, value];
	if (Array.isArray(value))
		return value.map((item, at) => copyJson(item, `${where}[${at}]`, inside));
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null)
		throw new Error(`${where} is not JSON: it holds ${describe(value)}.`);
	return Object.fromEntries(
		Object.entries(value)
			.filter(([, item]) => item !== undefined)
			.map(([key, item]) => [key, copyJson(item, `${where}.${key}`, inside)]),
	);
}

function describe(value: unknown): string {
	if (value === undefined) return 'undefined';
	if (typeof value === 'number') return `the number ${value}`;
	if (typeof value === 'object' && value !== null)
		return `a ${Object.getPrototypeOf(value)?.constructor?.name ?? 'object'}`;
	return `a ${typeof value}`;
}

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
		!isRecord(compose.runtime) ||
		typeof compose.runtime.evaluate !== 'function'
	) {
		throw new Error('Agent compose must be an object with a runtime.');
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
