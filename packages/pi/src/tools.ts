/**
 * The room tools of one activation, and the agent's own tools, as Pi
 * harness tools.
 *
 * The core binds the room tools to the activation: what each one commits
 * and what the model reads. The harness reads a thrown error as an error
 * result, so a room tool's error result becomes a thrown error here. A
 * result that ends the activation sets `terminate`. The agent's own tools
 * keep their Pi fields: the harness prepares and checks the arguments, and
 * passes the signal of the pass and the updates.
 */
import type { AmbionTool, ToolContent, ToolContext, ToolUpdate } from '@ambionframework/ambion';
import type { ActivationView, AgentDefinition, RoomTool } from '@ambionframework/ambion/hosting';
import { toolContext } from '@ambionframework/ambion/hosting';
import type { AgentHarnessTool, AgentToolResult } from '@earendil-works/pi-agent-core';

/** A harness tool: the tools of one activation take no tool context. */
export type PiTool = AgentHarnessTool<undefined>;

/** A harness tool from a room tool. An error result that does not end the activation throws. */
function fromRoomTool(tool: RoomTool): PiTool {
	return {
		name: tool.name,
		label: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		execute: async (toolCallId, params): Promise<AgentToolResult<Record<string, never>>> => {
			const result = await tool.run(params, toolCallId);
			const content = [...result.content];
			if (result.terminate) return { content, details: {}, terminate: true };
			if (result.isError) throw new Error(content.map(textOf).join('\n'));
			return { content, details: {} };
		},
	};
}

/** The text of one part of a result. A room tool gives text only. */
function textOf(part: ToolContent): string {
	return part.type === 'text' ? part.text : '';
}

/** The context one call of a normalized tool receives. */
export type ContextOf = (
	call: string,
	signal: AbortSignal | undefined,
	onUpdate?: ToolUpdate,
) => ToolContext;

/** A harness tool from a normalized tool. `contextOf` gives each call its context. */
export function fromAmbionTool(tool: AmbionTool, contextOf: ContextOf): PiTool {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		...(tool.prepareArguments === undefined ? {} : { prepareArguments: tool.prepareArguments }),
		...(tool.executionMode === undefined ? {} : { executionMode: tool.executionMode }),
		execute: async (toolCallId, params, onUpdate, _toolContext, _invocation, run) => {
			const result = await tool.invoke(params, contextOf(toolCallId, run.abortSignal, onUpdate));
			return typeof result === 'string'
				? { content: [{ type: 'text', text: result }], details: {} }
				: result;
		},
	};
}

/**
 * A harness tool from a normalized tool. The tool reads the view of the pass
 * that runs it, so the room and the open exchange it names are current.
 */
function toPiTool(tool: AmbionTool, agent: AgentDefinition, current: () => ActivationView): PiTool {
	return fromAmbionTool(tool, (call, signal, onUpdate) =>
		toolContext(agent, current(), call, signal, onUpdate),
	);
}

/**
 * What an activation holds from its purpose: the room tools the core bound,
 * and the tools of the definition. `current` names the view of the running
 * pass, and defaults to the view the tools are built from.
 *
 * `pass.tools` holds the room tools and the tools of the definition. Pi
 * hosts the room tools from it: the tools that the definition does not name.
 * It builds each tool of the definition from its `AmbionTool`, because a
 * `RoomTool` does not carry what the Pi harness does with the tool:
 *
 * - The harness applies `prepareArguments` before it checks the arguments
 *   against the schema. A `RoomTool` applies it after the check.
 * - The harness runs a batch in turn when a tool sets `executionMode` to
 *   `sequential`.
 * - The harness gives the tool `onUpdate`, and the abort signal of the pass.
 * - The harness keeps `details` and `terminate` of the result. A `RoomTool`
 *   gives the content alone.
 *
 * The context of each call comes from `toolContext`, as it does in the core.
 */
export function toolsFor(
	view: ActivationView,
	def: AgentDefinition,
	tools: readonly RoomTool[],
	current: () => ActivationView = () => view,
): PiTool[] {
	const own = new Set(def.executor.tools.map((tool) => tool.name));
	const room = tools.filter((tool) => !own.has(tool.name)).map(fromRoomTool);
	if (view.spec.purpose.kind === 'summarize') return room;
	return [...room, ...def.executor.tools.map((tool) => toPiTool(tool, def, current))];
}
