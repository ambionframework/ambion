/**
 * The room tools bound to one activation, and the agent's own tools, as one
 * in-process MCP server for the Claude Agent SDK.
 *
 * The core's `roomTools` and `agentTools` hold what each tool does and what
 * the model reads. This file gives each call the id the stream named, and
 * hands the SDK each result as an MCP result.
 *
 * The SDK builds an MCP tool from a Zod shape. The three room schemas and
 * the schemas of the agent's tools are TypeBox values, which are JSON
 * Schema, so `shapeOf` reads each property through `z.fromJSONSchema`.
 */
import type {
	ActivationView,
	AgentDefinition,
	RoomTool,
	RoomToolBinding,
} from '@ambionframework/ambion/hosting';
import { agentTools, roomTools } from '@ambionframework/ambion/hosting';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { TSchema } from 'typebox';
import { z } from 'zod';
import { ROOM_SERVER } from './claude-trace.ts';

/** What every room tool reaches: the activation, the room, and the calls the stream names. */
export interface Binding extends RoomToolBinding {
	/** Aborts when the activation is cut. */
	readonly signal: AbortSignal;
	/** The id the model gave this call. A call the stream did not name gets a fresh id. */
	callId(tool: string): string;
}

/** The Zod shape of a TypeBox object schema: one field for each property. */
function shapeOf(schema: TSchema): Record<string, z.ZodType> {
	const { properties = {}, required = [] } = schema as {
		properties?: Record<string, unknown>;
		required?: string[];
	};
	const shape: Record<string, z.ZodType> = {};
	for (const [name, property] of Object.entries(properties)) {
		const field = z.fromJSONSchema(property as Parameters<typeof z.fromJSONSchema>[0]);
		shape[name] = required.includes(name) ? field : field.optional();
	}
	return shape;
}

/** An MCP tool from a room tool. Each call takes the id the stream named for it. */
function mcpTool(one: RoomTool, binding: Binding): SdkMcpToolDefinition {
	return tool(one.name, one.description, shapeOf(one.parameters), async (args) => {
		const result = await one.run(args, binding.callId(one.name));
		return {
			content: result.content.map((part) => ({ ...part })),
			...(result.isError ? { isError: true } : {}),
		};
	});
}

/** The in-process server for one activation, and the names of its tools as the SDK knows them. */
export function roomServer(
	view: ActivationView,
	agent: AgentDefinition,
	binding: Binding,
	current: () => ActivationView = () => view,
) {
	const tools = [
		...roomTools(view, binding),
		...agentTools(view, agent, binding.signal, current),
	].map((one) => mcpTool(one, binding));
	return {
		server: createSdkMcpServer({ name: ROOM_SERVER, tools }),
		names: tools.map((one) => `mcp__${ROOM_SERVER}__${one.name}`),
	};
}
