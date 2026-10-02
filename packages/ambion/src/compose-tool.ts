/**
 * The `compose` tool: one definition tool that joins the other tools of a
 * seat into one call. It checks `uses`, asks the approval, runs the code
 * (`compose-run.ts`), and renders the result and the error for the model
 * (`docs/compose.md`). `describeExecutor` appends the tool.
 *
 * The tool needs the step sink of the activation, and no tool may hold a
 * sink. The core hands it over through `invokeTool`: a private table maps
 * the `invoke` of each compose tool to an entry that takes the sink. The
 * `invoke` field itself runs with no sink and records no step.
 */
import { type Static, Type } from 'typebox';
import { Check } from 'typebox/value';
import type { AmbionTool, ToolContext, ToolResult } from './bundle.ts';
import {
	COMPOSE_GUIDANCE,
	COMPOSE_TOOL_NAME,
	ComposeFailure,
	type ComposeLimits,
	type ComposeOptions,
	type ComposeResult,
	DEFAULT_COMPOSE_LIMITS,
	mismatchOf,
} from './compose.ts';
import { bindable, renderCatalog } from './compose-catalog.ts';
import { type ComposeOutcome, ComposeRun } from './compose-run.ts';
import { checkedArguments, messageOf, runToolCall } from './tool-call.ts';
import type { Step } from './types.ts';

const DESCRIPTION =
	'Join your tools in one call. Code calls them as tools.<name>, and you read only the value that it returns.';

const ARGUMENTS = Type.Object({
	uses: Type.Array(Type.String(), {
		description: 'The tools this compose call uses. Only these are bound.',
	}),
	code: Type.String({
		description: 'The body of an asynchronous function. Its return value is the result.',
	}),
});

type Arguments = Static<typeof ARGUMENTS>;

/** The guidance that `compose` adds to the executor, or undefined for none. */
export function composeGuidance(options: ComposeOptions | undefined): string | undefined {
	if (options === undefined) return undefined;
	return (options.guidance ?? COMPOSE_GUIDANCE).trim() || undefined;
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

function failureText(result: ComposeResult): string {
	const error = result.error;
	const at = error?.call === undefined ? '' : ` at call ${error.call}`;
	const head =
		result.status === 'cancelled'
			? `The compose call was cancelled${at}: ${error?.message}`
			: `The compose call failed${at}: ${error?.message}`;
	if (result.calls.length === 0) return `${head}\nNo call started.`;
	const lines = result.calls.map((call) => `- ${call.call} ${call.tool}: ${call.status}`);
	const pending = result.calls.some((call) => call.status === 'pending')
		? ['A pending call did not settle, and its effect can still happen.']
		: [];
	return [head, 'Calls, in the order that the code made them:', ...lines, ...pending].join('\n');
}

/** The content of a completed compose call: the value, and a line for each late call. */
function completedText({ result, late }: ComposeOutcome): string {
	const value =
		result.value === undefined
			? 'The compose call completed with no value.'
			: JSON.stringify(result.value);
	const lines = late.map(
		(call) => `Call ${call.call} (${call.tool}) ${call.status} after the code returned.`,
	);
	return [value, ...lines].join('\n');
}

/** The tool result of a completed call. A failed or cancelled call throws. */
function rendered(outcome: ComposeOutcome): ToolResult<ComposeResult> {
	const { result } = outcome;
	if (result.status !== 'completed') throw new ComposeFailure(failureText(result), result);
	return { content: [{ type: 'text', text: completedText(outcome) }], details: result };
}

/** Ask the approval hook. A denial, and a hook that fails, refuse the compose call. */
async function approve(
	options: ComposeOptions,
	request: { readonly uses: readonly string[]; readonly code: string },
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

/** The program of one compose call: the tools it names, and the code that calls them. */
interface Program {
	readonly uses: readonly string[];
	readonly code: string;
	/** The tools that the code binds, by name. */
	readonly tools: ReadonlyMap<string, AmbionTool>;
}

/** The entry that runs a compose call with the step sink of the activation. */
type ComposeEntry = (
	params: unknown,
	ctx: ToolContext,
	record: ((step: Step) => void) | undefined,
) => Promise<ToolResult<ComposeResult>>;

/**
 * The entry of each compose tool, by its `invoke`. The capture of a
 * definition copies a tool and keeps `invoke`. A wrapper that replaces the
 * `invoke` of a tool of the executor after `describeExecutor` loses the
 * entry, and the compose call then records no step.
 */
const ENTRIES = new WeakMap<AmbionTool['invoke'], ComposeEntry>();

/**
 * Resolve the arguments of a compose call to its program. This is the one
 * place that turns the arguments into `uses` and `code`, and into the tools
 * that the code binds. It refuses a name that the catalog does not hold.
 */
function resolveProgram(params: Arguments, catalog: ReadonlyMap<string, AmbionTool>): Program {
	const uses = [...new Set(params.uses)];
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
	return { uses, code: params.code, tools };
}

/**
 * The `compose` tool over the tools of one definition. It binds each tool that
 * does not set `compose: false`. The catalog is built once, here.
 */
export function composeTool(options: ComposeOptions, tools: readonly AmbionTool[]): AmbionTool {
	const catalog = new Map(
		tools
			.filter((tool) => bindable(tool) && tool.name !== COMPOSE_TOOL_NAME)
			.map((tool) => [tool.name, tool]),
	);
	const limits = limitsOf(options);
	const entry: ComposeEntry = async (params, ctx, record) => {
		// The public `invoke` reaches this entry with unchecked arguments, so the check stays.
		if (!Check(ARGUMENTS, params))
			throw new Error(`Invalid arguments for tool 'compose': ${mismatchOf(ARGUMENTS, params)}.`);
		const program = resolveProgram(params, catalog);
		await approve(options, { uses: program.uses, code: program.code }, ctx, record);
		const run = new ComposeRun({
			tools: program.tools,
			code: program.code,
			evaluator: options.evaluator,
			limits,
			ctx,
			...(record === undefined ? {} : { record }),
		});
		return rendered(await run.run());
	};
	const tool: AmbionTool = Object.freeze({
		name: COMPOSE_TOOL_NAME,
		description: `${DESCRIPTION}\n\n${renderCatalog([...catalog.values()])}`,
		parameters: ARGUMENTS,
		label: COMPOSE_TOOL_NAME,
		invoke: (params: unknown, ctx: ToolContext) => entry(params, ctx, undefined),
	});
	ENTRIES.set(tool.invoke, entry);
	return tool;
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
): Promise<string | ToolResult> | string | ToolResult {
	const entry = record === undefined ? undefined : ENTRIES.get(tool.invoke);
	return entry === undefined ? tool.invoke(params, ctx) : entry(params, ctx, record);
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
): Promise<string | ToolResult> {
	if (record === undefined || !ENTRIES.has(tool.invoke)) return runToolCall(tool, args, ctx);
	return invokeChecked(tool, checkedArguments(tool, args), ctx, record);
}
