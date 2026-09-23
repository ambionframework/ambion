/**
 * The room tools bound to one activation, and the agent's own tools, as Pi
 * tools.
 *
 * The core's `roomTools` holds what each room tool commits and what the
 * model reads. Pi reads a thrown error as an error result, so a room tool's
 * error result becomes a thrown error here. A result that ends the
 * activation sets `terminate`. The agent's own tools keep their Pi fields:
 * Pi prepares and checks the arguments, and passes the signal and updates.
 */
import type { AmbionTool } from '@ambionframework/ambion';
import type {
	ActivationView,
	AgentDefinition,
	RoomProtocol,
	RoomTool,
	RoomToolBinding,
	RoomToolContent,
} from '@ambionframework/ambion/hosting';
import { roomTools, toolContext } from '@ambionframework/ambion/hosting';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { TSchema } from 'typebox';
import type { Activation } from './executor.ts';

/** What every room tool reaches: the activation and the room. */
export function binding(activation: Activation, room: RoomProtocol): RoomToolBinding {
	return {
		id: activation.id,
		room,
		get readThrough() {
			return activation.readThrough;
		},
		acknowledgeThrough: (seq) => activation.acknowledgeThrough(seq),
		resultExpected: (call, seq) => activation.toolResultExpected(call, seq),
		abort: () => activation.abort(),
	};
}

/** A Pi tool from a room tool. An error result that does not end the activation throws. */
function fromRoomTool(tool: RoomTool): AgentTool {
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
function textOf(part: RoomToolContent): string {
	return part.type === 'text' ? part.text : '';
}

/**
 * A Pi tool from a normalized tool. The tool reads the view of the pass that
 * runs it, so the room and the open exchange it names are current.
 */
function toPiTool(
	tool: AmbionTool,
	agent: AgentDefinition,
	current: () => ActivationView,
): AgentTool<TSchema, unknown> {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		...(tool.prepareArguments === undefined ? {} : { prepareArguments: tool.prepareArguments }),
		...(tool.executionMode === undefined ? {} : { executionMode: tool.executionMode }),
		execute: async (toolCallId, params, signal, onUpdate) => {
			const context = toolContext(agent, current(), toolCallId, signal, onUpdate);
			const result = await tool.invoke(params, context);
			return typeof result === 'string'
				? { content: [{ type: 'text', text: result }], details: {} }
				: result;
		},
	};
}

/**
 * What an activation holds from its purpose. `current` names the view of the
 * running pass, and defaults to the view the tools are built from.
 */
export function toolsFor(
	view: ActivationView,
	def: AgentDefinition,
	held: RoomToolBinding,
	current: () => ActivationView = () => view,
): AgentTool[] {
	const room = roomTools(view, held).map(fromRoomTool);
	if (view.spec.purpose.kind === 'summarize') return room;
	return [...room, ...def.executor.tools.map((tool) => toPiTool(tool, def, current))];
}
