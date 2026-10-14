/**
 * A seat extension adds tools and guidance to a seat. It reads the tools that
 * the seat holds and the room tools of the room, and `describeExecutor`
 * appends what it returns. `compose` is such an extension
 * (`docs/compose.md`).
 *
 * A tool of an extension may run nested calls. It needs two things from the
 * activation: the room tools, and a way to record the steps of a nested call.
 * No tool may write a step of its own choice. `activationTool` builds a tool
 * whose entry receives an `ActivationAccess`: the room tools, a `nested`
 * function that calls a tool and records its two steps with the running call
 * as `parent`, and an `approved` function that records the answer of an
 * approval for the running call. The `invoke` field of that tool runs with no
 * activation, so it records no step and holds no room tool.
 */
import type { AmbionTool, ToolBundle, ToolContent, ToolContext, ToolResult } from './bundle.ts';
import { callChecked, checkedArguments } from './tool-call.ts';
import type { Step } from './types.ts';

/**
 * The part of a room tool that a nested call reads: the commit and the
 * content it returns. It restates `BoundTool`, because `execution/contract.ts`
 * sits above this file.
 */
export interface RoomCall {
	readonly name: string;
	/** The nested calls `calls` of the tool call `parent` show their results in the result of `parent`. */
	reported?(parent: string, calls: readonly string[]): void;
	run(
		args: unknown,
		call: string,
	): Promise<{
		readonly content: readonly ToolContent[];
		readonly isError?: true;
		readonly carriesRecord?: true;
	}>;
}

/** A room tool that an extension sees, with the fields that it reads. */
export type RoomSpec = Pick<AmbionTool, 'name' | 'description' | 'parameters' | 'executionMode'> & {
	/** The room offers this tool to some activations alone. */
	readonly optional?: true;
};

/** What an extension reads: the own tools of the seat, its bundles, and the room tools. */
export interface SeatExtensionInput {
	/** The tools of the seat, flattened and captured, before any extension adds a tool. */
	readonly tools: readonly AmbionTool[];
	readonly bundles: readonly ToolBundle[];
	readonly room: readonly RoomSpec[];
}

/** What an extension adds to the seat. */
export interface SeatExtensionOutput {
	/** Appended after the tools of the seat. */
	readonly tools: readonly AmbionTool[];
	/** Joined after the guidance of the bundles. Absent adds none. */
	readonly guidance?: string;
}

/** An extension of a seat. `describeExecutor` calls it once, when the executor is described. */
export type SeatExtension = (seat: SeatExtensionInput) => SeatExtensionOutput;

/** What the entry of an activation tool receives besides its arguments and its context. */
export interface ActivationAccess {
	/** The room tools of the activation. Absent when the call has no activation. */
	readonly room: readonly RoomCall[] | undefined;
	/**
	 * Calls `tool` with `params`, which `checkedArguments` returned for `input`.
	 * With an activation, it records a `tool_call` step before the call and a
	 * `tool_result` step or an `error` step after it, each with the running call
	 * as `parent`. Without one, it records no step.
	 */
	nested(
		tool: AmbionTool,
		input: unknown,
		params: unknown,
		ctx: ToolContext,
	): Promise<string | ToolResult>;
	/** Records the answer of an approval for the running call. Without an activation, it records nothing. */
	approved(answer: 'allow' | 'deny'): void;
}

/** The entry of a tool that runs with the access of the activation. */
export type ActivationEntry = (
	params: unknown,
	ctx: ToolContext,
	access: ActivationAccess,
) => Promise<string | ToolResult> | string | ToolResult;

/** The access of the call `ctx`. With a step sink, the call has an activation. */
function accessOf(
	ctx: ToolContext,
	record: ((step: Step) => void) | undefined,
	room: readonly RoomCall[] | undefined,
): ActivationAccess {
	return {
		room,
		nested: (tool, input, params, nestedCtx) =>
			callChecked(
				tool,
				input,
				params,
				nestedCtx,
				record === undefined ? undefined : { parent: ctx.callId, record },
			),
		approved: (answer) => record?.({ type: 'approval', call: ctx.callId, answer }),
	};
}

/**
 * The entry of each activation tool, by its `invoke`. The capture of a
 * definition copies a tool and keeps `invoke`. A wrapper that replaces the
 * `invoke` of a tool of the executor after `describeExecutor` loses the
 * entry, and the call then records no step.
 */
const ENTRIES = new WeakMap<AmbionTool['invoke'], ActivationEntry>();

/**
 * A tool that receives the access of the activation when the core runs it
 * through `invokeTool`. Its `invoke` calls the entry with no activation.
 */
export function activationTool(
	fields: Omit<AmbionTool, 'invoke'>,
	entry: ActivationEntry,
): AmbionTool {
	const tool: AmbionTool = Object.freeze({
		...fields,
		invoke: (params: unknown, ctx: ToolContext) =>
			entry(params, ctx, accessOf(ctx, undefined, undefined)),
	});
	ENTRIES.set(tool.invoke, entry);
	return tool;
}

/**
 * Invoke arguments that `checkedArguments` already returned, with the step
 * sink of the activation. An activation tool gets the access of the
 * activation. Any other tool runs through `invoke`. With no sink, every tool runs
 * through `invoke`. A harness that prepares and checks the arguments itself,
 * as Pi does, calls this one, so no call prepares twice.
 */
export function invokeChecked(
	tool: AmbionTool,
	params: unknown,
	ctx: ToolContext,
	record?: (step: Step) => void,
	room?: readonly RoomCall[],
): Promise<string | ToolResult> | string | ToolResult {
	const entry = ENTRIES.get(tool.invoke);
	return entry === undefined || record === undefined
		? tool.invoke(params, ctx)
		: entry(params, ctx, accessOf(ctx, record, room));
}

/**
 * Run one direct call of a tool of the definition: prepare and check the
 * arguments, then invoke. `record` is the step sink of the activation. A
 * direct call records its own steps in the harness, so this records none
 * beside the steps of a nested call.
 */
export async function invokeTool(
	tool: AmbionTool,
	args: unknown,
	ctx: ToolContext,
	record?: (step: Step) => void,
	room?: readonly RoomCall[],
): Promise<string | ToolResult> {
	return invokeChecked(tool, checkedArguments(tool, args), ctx, record, room);
}

/** The extensions of the options, or none. Refuses a value that is not a list of functions. */
export function extensionsOf(extensions: unknown): readonly SeatExtension[] {
	if (extensions === undefined) return [];
	if (!Array.isArray(extensions) || extensions.some((one) => typeof one !== 'function'))
		throw new Error('Agent extensions must be an array of functions.');
	return extensions;
}
