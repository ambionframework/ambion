/**
 * The seam between a seat and a layer over its tools. A layer reads the tools
 * that a seat holds and the room tools of the room, and returns tools and
 * guidance that the executor appends. `compose` is such a layer
 * (`docs/compose.md`).
 *
 * A layer's tool may run nested calls. It needs the step sink of the
 * activation, which records the steps of a nested call, and the room tools of
 * the activation, which a nested call can reach. No ordinary tool may hold a
 * sink. The core hands both through `invokeTool` to a tool that `activationTool`
 * built, and to no other tool. The `invoke` field of that tool runs with no
 * sink and no room tool, and records no step.
 */
import type { AmbionTool, ToolBundle, ToolContent, ToolContext, ToolResult } from './bundle.ts';
import { checkedArguments } from './tool-call.ts';
import type { Step } from './types.ts';

/**
 * The part of a room tool that a nested call reads: the commit and the
 * content it returns. It restates `BoundTool`, because `execution/contract.ts`
 * sits above this file in the layers.
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

/** A room tool that a layer sees, with the fields that a layer reads. */
export type RoomSpec = Pick<AmbionTool, 'name' | 'description' | 'parameters' | 'executionMode'> & {
	/** The room offers this tool to some activations alone. */
	readonly optional?: true;
};

/** What a layer reads: the own tools of the seat, its bundles, and the room tools. */
export interface SeatLayerInput {
	/** The tools of the seat, flattened and captured, before any layer adds a tool. */
	readonly tools: readonly AmbionTool[];
	readonly bundles: readonly ToolBundle[];
	readonly room: readonly RoomSpec[];
}

/** What a layer adds to the seat. */
export interface SeatLayerOutput {
	/** Appended after the tools of the seat. */
	readonly tools: readonly AmbionTool[];
	/** Joined after the guidance of the bundles. Absent adds none. */
	readonly guidance?: string;
}

/** A layer over the tools of a seat. `describeExecutor` calls it once, when the executor is described. */
export type SeatLayer = (seat: SeatLayerInput) => SeatLayerOutput;

/** The entry of a tool that runs with the step sink and the room tools of the activation. */
export type ActivationEntry = (
	params: unknown,
	ctx: ToolContext,
	record: ((step: Step) => void) | undefined,
	room?: readonly RoomCall[],
) => Promise<string | ToolResult> | string | ToolResult;

/**
 * The entry of each activation tool, by its `invoke`. The capture of a
 * definition copies a tool and keeps `invoke`. A wrapper that replaces the
 * `invoke` of a tool of the executor after `describeExecutor` loses the
 * entry, and the call then records no step.
 */
const ENTRIES = new WeakMap<AmbionTool['invoke'], ActivationEntry>();

/**
 * A tool that receives the step sink and the room tools of the activation
 * when the core runs it through `invokeTool`. Its `invoke` calls the entry
 * with neither.
 */
export function activationTool(
	fields: Omit<AmbionTool, 'invoke'>,
	entry: ActivationEntry,
): AmbionTool {
	const tool: AmbionTool = Object.freeze({
		...fields,
		invoke: (params: unknown, ctx: ToolContext) => entry(params, ctx, undefined, undefined),
	});
	ENTRIES.set(tool.invoke, entry);
	return tool;
}

/**
 * Invoke arguments that `checkedArguments` already returned, with the step
 * sink of the activation. An activation tool takes the sink and the room
 * tools. Any other tool runs through `invoke`. With no sink, every tool runs
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
	const entry = record === undefined ? undefined : ENTRIES.get(tool.invoke);
	return entry === undefined ? tool.invoke(params, ctx) : entry(params, ctx, record, room);
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
