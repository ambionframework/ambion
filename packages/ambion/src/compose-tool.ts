/**
 * The `compose` tool: one definition tool that joins the other tools of a
 * seat into one call. It checks `uses`, asks the approval, runs the code
 * (`compose-run.ts`), and renders the result and the error for the model
 * (`docs/compose.md`). Its description lists the bindable tools and the type
 * of each result. The `describe` tool is the counterpart: it renders the
 * signatures and the types of the tools that a call names, and runs nothing.
 * `describeExecutor` appends both tools.
 *
 * The tool needs the step sink of the activation, and no tool may hold a
 * sink. The core hands it over through `invokeTool`: a private table maps
 * the `invoke` of each compose tool to an entry that takes the sink and the
 * room tools of the activation. The `invoke` field itself runs with no sink
 * and no room tool, and records no step.
 */
import { type Static, type TSchema, Type } from 'typebox';
import { Check } from 'typebox/value';
import {
	type AmbionTool,
	contentText,
	type ToolContent,
	type ToolContext,
	type ToolResult,
} from './bundle.ts';
import {
	COMPOSE_GUIDANCE,
	COMPOSE_TOOL_NAME,
	ComposeFailure,
	type ComposeLimits,
	type ComposeMacro,
	type ComposeOptions,
	type ComposeRequest,
	type ComposeResult,
	DEFAULT_COMPOSE_LIMITS,
	type JsonValue,
	type LedgerEntry,
	mismatchOf,
	plainJson,
} from './compose.ts';
import { bindable } from './compose-catalog.ts';
import { bindingsText, describeTool, namedTools, signatureText } from './compose-describe.ts';
import { macroGuidance } from './compose-macros.ts';
import { type ComposeOutcome, ComposeRun } from './compose-run.ts';
import { checkedArguments, messageOf, runToolCall } from './tool-call.ts';
import type { Step } from './types.ts';

const DESCRIPTION =
	'Run JavaScript that calls your tools as tools.<name>, in one call. Use it for a plan of two or more tool calls, and to explore large results. You read only the value that the code returns.';

/**
 * What a model must know about the bounds and the failures of a compose
 * call. The numbers are the limits of the seat. `COMPOSE_GUIDANCE` states
 * the rest: the clock, the room tools, and the effect of a completed call.
 */
function limitsText(limits: ComposeLimits): string {
	return [
		`Limits of this seat: at most ${limits.calls} nested calls, ${limits.concurrent} at a time. The return value holds at most ${limits.bytes} bytes of JSON. The call lasts at most ${limits.time / 1000} seconds, and the end of your activation cuts it sooner.`,
		'A binding rejects with an Error when its tool fails. error.details holds the details of the tool when it gives them. A rejection cancels no other call.',
		'A compose call cannot start a compose call. Image parts of a result do not reach the code.',
	].join('\n');
}

/**
 * One object with four optional fields. The call is `uses` and `code`, or
 * `macro` and `args`. A provider takes no `anyOf` at the top of a tool
 * schema, so `resolveProgram` checks the two forms.
 */
const ARGUMENTS = Type.Object({
	uses: Type.Optional(
		Type.Array(Type.String(), {
			description:
				'The tools this compose call uses. Only these are bound. Give it with code. An empty list binds no tool.',
		}),
	),
	code: Type.Optional(
		Type.String({
			description: 'The body of an asynchronous function. Its return value is the result.',
		}),
	),
	macro: Type.Optional(
		Type.String({
			description:
				'The name of a macro that a skill names. Give it with args, in place of uses and code.',
		}),
	),
	args: Type.Optional(
		Type.Unknown({
			description: 'The arguments of the macro, as the skill gives them. The code reads args.',
		}),
	),
});

type Arguments = Static<typeof ARGUMENTS>;

/**
 * The guidance that `compose` adds to the executor, or undefined for none:
 * the text, and one line for each macro of the seat.
 */
export function composeGuidance(
	options: ComposeOptions | undefined,
	macros: readonly ComposeMacro[] = [],
): string | undefined {
	if (options === undefined) return undefined;
	const text = (options.guidance ?? COMPOSE_GUIDANCE).trim();
	return [text, macroGuidance(macros)].filter(Boolean).join('\n\n') || undefined;
}

/** The limits of the option, with the defaults for each field that it leaves out. */
function limitsOf(options: ComposeOptions): ComposeLimits {
	const set = Object.entries(options.limits ?? {}).filter(([, value]) => value !== undefined);
	return { ...DEFAULT_COMPOSE_LIMITS, ...Object.fromEntries(set) };
}

/** A compose call that failed before it ran any code: no ledger, no effect. */
function refusal(message: string): ComposeFailure {
	const details: ComposeResult = { status: 'failed', error: { message }, calls: [] };
	return new ComposeFailure(failureText(details), details);
}

/** The most bytes of JSON that a failed result shows for one completed call. */
const CALL_RESULT_BYTES = 4096;

/** What a failed result shows of the completed calls: their values, and the byte limit of the lot. */
interface Shown {
	readonly values: ReadonlyMap<string, JsonValue>;
	readonly bytes: number;
}

const UTF8 = new TextEncoder();
const UTF8_LOSSY = new TextDecoder();

/** The first `bytes` bytes of `text`, cut at a character. */
function prefixOf(text: string, bytes: number): string {
	return UTF8_LOSSY.decode(UTF8.encode(text).slice(0, bytes)).replace(/\uFFFD+$/, '');
}

/**
 * The lines that show the value of each completed call, in call order. One
 * value shows at most `CALL_RESULT_BYTES`, and all values show at most the
 * byte limit of the return value. Each cut says so, with the full size.
 */
function resultLines(calls: readonly LedgerEntry[], shown: Shown): ReadonlyMap<string, string> {
	let left = shown.bytes;
	const lines = new Map<string, string>();
	for (const call of calls) {
		const value = shown.values.get(call.call);
		if (call.status !== 'completed' || value === undefined) continue;
		const json = JSON.stringify(value);
		const size = UTF8.encode(json).length;
		const allowed = Math.min(CALL_RESULT_BYTES, left);
		if (allowed <= 0) {
			lines.set(
				call.call,
				`  result: omitted, because the results above fill ${shown.bytes} bytes.`,
			);
			continue;
		}
		left -= Math.min(size, allowed);
		lines.set(
			call.call,
			size <= allowed
				? `  result: ${json}`
				: `  result: cut to at most ${allowed} of ${size} bytes: ${prefixOf(json, allowed)}`,
		);
	}
	return lines;
}

/** What a failed result renders besides the error: the completed calls, the room notes, and the signatures. */
interface Failed {
	readonly notes?: readonly string[];
	readonly shown?: Shown;
	readonly named?: readonly AmbionTool[];
}

function failureText(
	result: ComposeResult,
	{ notes = [], shown, named = [] }: Failed = {},
): string {
	const error = result.error;
	const at = error?.call === undefined ? '' : ` at call ${error.call}`;
	const head =
		result.status === 'cancelled'
			? `The compose call was cancelled${at}: ${error?.message}`
			: `The compose call failed${at}: ${error?.message}`;
	if (result.calls.length === 0)
		return [head, 'No call started.', ...signatureText(named)].join('\n');
	const results =
		shown === undefined ? new Map<string, string>() : resultLines(result.calls, shown);
	const lines = result.calls.flatMap((call) => {
		const line = `- ${call.call} ${call.tool}: ${call.status}`;
		const value = results.get(call.call);
		return value === undefined ? [line] : [line, value];
	});
	const pending = result.calls.some((call) => call.status === 'pending')
		? ['A pending call did not settle, and its effect can still happen.']
		: [];
	return [
		head,
		'Calls, in the order that the code made them:',
		...lines,
		...pending,
		...recordText(notes),
		...signatureText(named),
	].join('\n');
}

/** The lines that the room tools of a compose call report: what the model must read. */
function recordText(notes: readonly string[]): string[] {
	return notes.length === 0 ? [] : ['Room tools reported:', ...notes];
}

/** The content of a completed compose call: the value, a line for each late call, and the room notes. */
function completedText({ result, late }: ComposeOutcome, notes: readonly string[]): string {
	const value =
		result.value === undefined
			? 'The compose call completed with no value.'
			: JSON.stringify(result.value);
	const lines = late.map(
		(call) => `Call ${call.call} (${call.tool}) ${call.status} after the code returned.`,
	);
	return [value, ...lines, ...recordText(notes)].join('\n');
}

/** The tool result of a completed call. A failed or cancelled call throws. */
function rendered(
	outcome: ComposeOutcome,
	notes: readonly string[],
	limits: ComposeLimits,
	catalog: ReadonlyMap<string, AmbionTool>,
): ToolResult<ComposeResult> {
	const { result } = outcome;
	if (result.status !== 'completed') {
		const shown = { values: outcome.values, bytes: limits.bytes };
		const named = namedTools(result, catalog);
		throw new ComposeFailure(failureText(result, { notes, shown, named }), result);
	}
	return { content: [{ type: 'text', text: completedText(outcome, notes) }], details: result };
}

/** Ask the approval hook. A denial, and a hook that fails, refuse the compose call. */
async function approve(
	options: ComposeOptions,
	request: ComposeRequest,
	ctx: ToolContext,
	record: ((step: Step) => void) | undefined,
): Promise<void> {
	if (options.approve === undefined) return;
	let answer: 'allow' | 'deny';
	let failed: string | undefined;
	try {
		answer = await options.approve(request, ctx);
	} catch (error) {
		answer = 'deny';
		failed = `The approval failed: ${messageOf(error)}`;
	}
	record?.({ type: 'approval', call: ctx.callId, answer });
	if (answer === 'allow') return;
	throw refusal(failed ?? 'The approval refused this compose call. No code ran.');
}

/**
 * The part of a room tool that a compose call reads: the commit and the
 * content it returns. It restates `BoundTool`, because `execution/contract.ts`
 * sits above this file in the layers.
 */
export interface RoomCall {
	readonly name: string;
	/** The compose call `compose` shows the results of the nested calls `calls` in its own result. */
	reported?(compose: string, calls: readonly string[]): void;
	run(
		args: unknown,
		call: string,
	): Promise<{
		readonly content: readonly ToolContent[];
		readonly isError?: true;
		readonly carriesRecord?: true;
	}>;
}

/** The entries of the room tools, so a program can tell them from the tools of the definition. */
const ROOM_ENTRIES = new WeakSet<AmbionTool>();

/** The room tool that the catalog lists, with the fields that the catalog reads. */
export type RoomSpec = Pick<AmbionTool, 'name' | 'description' | 'parameters'>;

/** A room tool in the catalog. Its `invoke` has no activation, so it refuses. */
function roomEntry(spec: RoomSpec): AmbionTool {
	return Object.freeze({
		...spec,
		label: spec.name,
		// Two says that start together carry the same read position, so the room refuses the second.
		...(spec.name === 'say' ? { executionMode: 'sequential' as const } : {}),
		invoke: () => {
			throw new Error(`The room tool '${spec.name}' needs an activation.`);
		},
	});
}

/** What the room tools of one compose call report to the model: the lines it must read, and the nested calls they came from. */
interface RoomNotes {
	readonly lines: string[];
	readonly calls: string[];
}

/**
 * The room tool, run through its call of the activation. A result that the
 * room refuses rejects the binding with the text of the refusal. A result that
 * carries record, or an error, adds a note, because the model reads no
 * nested result.
 */
function liveEntry(entry: AmbionTool, call: RoomCall, notes: RoomNotes): AmbionTool {
	const live: AmbionTool = Object.freeze({
		...entry,
		invoke: async (params: unknown, ctx: ToolContext) => {
			const result = await call.run(params, ctx.callId);
			const value = contentText(result.content);
			if (result.carriesRecord === true || result.isError === true) {
				notes.lines.push(`Call ${ctx.callId} (${entry.name}): ${value}`);
				notes.calls.push(ctx.callId);
			}
			if (result.isError === true) throw new Error(value);
			return value;
		},
	});
	ROOM_ENTRIES.add(live);
	return live;
}

/** The room tools that `names` use, bound to the calls of the activation. A tool with no call refuses the compose call. */
function liveRoom(
	program: Program,
	room: readonly RoomCall[] | undefined,
	notes: RoomNotes,
): Program {
	const used = [...program.tools.values()].filter((tool) => ROOM_ENTRIES.has(tool));
	if (used.length === 0) return program;
	const missing = used.filter(
		(tool) => room?.find((call) => call.name === tool.name) === undefined,
	);
	if (missing.length > 0)
		throw refusal(
			`The room tools ${missing.map((tool) => `'${tool.name}'`).join(', ')} need an activation. This call has none.`,
		);
	const tools = new Map(
		[...program.tools].map(([name, tool]) => {
			const call = ROOM_ENTRIES.has(tool) ? room?.find((one) => one.name === name) : undefined;
			return [name, call === undefined ? tool : liveEntry(tool, call, notes)] as const;
		}),
	);
	return { ...program, tools };
}

/** The program of one compose call: the tools it names, and the code that calls them. */
interface Program {
	readonly uses: readonly string[];
	readonly code: string;
	/** The tools that the code binds, by name. */
	readonly tools: ReadonlyMap<string, AmbionTool>;
	/** The macro that gave the code, with its checked arguments. Absent for free code. */
	readonly macro?: { readonly macro: ComposeMacro; readonly args: JsonValue };
}

/** The entry that runs a compose call with the step sink and the room tools of the activation. */
type ComposeEntry = (
	params: unknown,
	ctx: ToolContext,
	record: ((step: Step) => void) | undefined,
	room?: readonly RoomCall[],
) => Promise<ToolResult<ComposeResult>>;

/**
 * The entry of each compose tool, by its `invoke`. The capture of a
 * definition copies a tool and keeps `invoke`. A wrapper that replaces the
 * `invoke` of a tool of the executor after `describeExecutor` loses the
 * entry, and the compose call then records no step.
 */
const ENTRIES = new WeakMap<AmbionTool['invoke'], ComposeEntry>();

/** The tools that `uses` names, by name. A name that the catalog does not hold refuses the call. */
function bound(
	names: readonly string[],
	catalog: ReadonlyMap<string, AmbionTool>,
): Pick<Program, 'uses' | 'tools'> {
	const uses = [...new Set(names)];
	const missing = uses.filter((name) => !catalog.has(name));
	if (missing.length > 0)
		throw refusal(
			`The catalog holds no tool named ${missing.map((name) => `'${name}'`).join(', ')}.`,
		);
	const tools = new Map(
		uses.flatMap((name) => {
			const tool = catalog.get(name);
			return tool === undefined ? [] : [[name, tool] as const];
		}),
	);
	return { uses, tools };
}

/** The arguments of a macro call as JSON. Absent arguments are an empty object. */
function argumentsOf(args: unknown): JsonValue {
	if (args === undefined) return {};
	try {
		return plainJson(args, 'args');
	} catch (error) {
		throw refusal(`The arguments of the macro are not JSON: ${messageOf(error)}`);
	}
}

/** The program of a macro: its stored code, under its stored `uses`, with `args` checked. */
function macroProgram(
	name: string,
	params: Arguments,
	catalog: ReadonlyMap<string, AmbionTool>,
	macros: ReadonlyMap<string, ComposeMacro>,
): Program {
	if (params.uses !== undefined || params.code !== undefined)
		throw refusal('Give macro and args, or uses and code. A call with all of them has no meaning.');
	const macro = macros.get(name);
	if (macro === undefined) {
		const held = [...macros.keys()].map((one) => `'${one}'`).join(', ');
		throw refusal(
			`No macro is named '${name}'. ${held === '' ? 'Your skills hold no macro.' : `The macros are ${held}.`}`,
		);
	}
	const args = argumentsOf(params.args);
	if (!Check(macro.args as TSchema, args))
		throw refusal(
			`The arguments of the macro '${name}' do not match its schema: ${mismatchOf(macro.args as TSchema, args)}.`,
		);
	return { ...bound(macro.uses, catalog), code: macro.code, macro: { macro, args } };
}

/**
 * Resolve the arguments of a compose call to its program. This is the one
 * place that turns the arguments into `uses` and `code`, and into the tools
 * that the code binds. It refuses a name that the catalog does not hold, a
 * macro that the definition does not hold, and `args` that break the schema
 * of the macro. A macro comes from the frozen set of the definition, so no
 * file of the agent changes the code.
 */
function resolveProgram(
	params: Arguments,
	catalog: ReadonlyMap<string, AmbionTool>,
	macros: ReadonlyMap<string, ComposeMacro>,
): Program {
	if (params.macro !== undefined) return macroProgram(params.macro, params, catalog, macros);
	if (params.uses === undefined || params.code === undefined)
		throw refusal('Give uses and code, or macro and args.');
	if (params.args !== undefined) throw refusal('Give args with macro. Free code takes no args.');
	return { ...bound(params.uses, catalog), code: params.code };
}

/** What `approve` reads for a program: the macro and its hash, or the code. */
function requestOf(program: Program): ComposeRequest {
	return program.macro === undefined
		? { uses: program.uses, code: program.code }
		: {
				macro: program.macro.macro.name,
				hash: program.macro.macro.hash,
				args: program.macro.args,
			};
}

/**
 * The `compose` tool and the `describe` tool over the tools of one
 * definition. They bind each tool that does not set `compose: false`. The
 * catalog is built once, here.
 */
export function composeTools(
	options: ComposeOptions,
	tools: readonly AmbionTool[],
	macros: readonly ComposeMacro[] = [],
	room: readonly RoomSpec[] = [],
): readonly [compose: AmbionTool, describe: AmbionTool] {
	const held = new Map(macros.map((macro) => [macro.name, macro]));
	const entries = room.map((spec) => roomEntry(spec));
	for (const entry of entries) ROOM_ENTRIES.add(entry);
	const catalog = new Map(
		[...tools.filter((tool) => bindable(tool) && tool.name !== COMPOSE_TOOL_NAME), ...entries].map(
			(tool) => [tool.name, tool],
		),
	);
	const limits = limitsOf(options);
	const entry: ComposeEntry = async (params, ctx, record, calls) => {
		// The public `invoke` reaches this entry with unchecked arguments, so the check stays.
		if (!Check(ARGUMENTS, params))
			throw new Error(`Invalid arguments for tool 'compose': ${mismatchOf(ARGUMENTS, params)}.`);
		const notes: RoomNotes = { lines: [], calls: [] };
		const program = liveRoom(resolveProgram(params, catalog, held), calls, notes);
		await approve(options, requestOf(program), ctx, record);
		const run = new ComposeRun({
			tools: program.tools,
			unlisted: [...catalog.keys()].filter((name) => !program.tools.has(name)),
			code: program.code,
			runtime: options.runtime,
			...(program.macro === undefined ? {} : { args: program.macro.args }),
			limits,
			ctx,
			...(record === undefined ? {} : { record }),
			commits: (nested) => ROOM_ENTRIES.has(nested),
		});
		const outcome = await run.run();
		// The activation counts a nested result as read only when this result shows it.
		calls?.find((one) => one.reported !== undefined)?.reported?.(ctx.callId, notes.calls);
		return rendered(outcome, notes.lines, limits, catalog);
	};
	const tool: AmbionTool = Object.freeze({
		name: COMPOSE_TOOL_NAME,
		description: [DESCRIPTION, limitsText(limits), bindingsText(catalog)].join('\n\n'),
		parameters: ARGUMENTS,
		label: COMPOSE_TOOL_NAME,
		invoke: (params: unknown, ctx: ToolContext) => entry(params, ctx, undefined, undefined),
	});
	ENTRIES.set(tool.invoke, entry);
	return [tool, describeTool(catalog)];
}

/**
 * Invoke arguments that `checkedArguments` already returned, with the step
 * sink of the activation. A compose tool takes the sink, and records the
 * steps of its nested calls and its approval. Any other tool runs through
 * `invoke`. With no sink, every tool runs through `invoke`, and a compose
 * call records no step. A harness that prepares and checks the arguments
 * itself, as Pi does, calls this one, so no call prepares twice.
 */
export function invokeChecked(
	tool: AmbionTool,
	params: unknown,
	ctx: ToolContext,
	record?: (step: Step) => void,
	room?: readonly RoomCall[],
): Promise<string | ToolResult> | string | ToolResult {
	const entry = record === undefined ? undefined : ENTRIES.get(tool.invoke);
	return entry === undefined ? tool.invoke(params, ctx) : entry(params, ctx, record, room);
}

/**
 * Run one direct call of a tool of the definition: prepare and check the
 * arguments, then invoke. `record` is the step sink of the activation. A
 * direct call records its own steps in the harness, so this records none
 * beside the steps of a compose call.
 */
export async function invokeTool(
	tool: AmbionTool,
	args: unknown,
	ctx: ToolContext,
	record?: (step: Step) => void,
	room?: readonly RoomCall[],
): Promise<string | ToolResult> {
	if (record === undefined || !ENTRIES.has(tool.invoke)) return runToolCall(tool, args, ctx);
	return invokeChecked(tool, checkedArguments(tool, args), ctx, record, room);
}
