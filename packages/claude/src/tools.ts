/**
 * The room tools bound to one activation, and the agent's own tools, as one
 * in-process MCP server for the Claude Agent SDK.
 *
 * The core binds the room tools and the agent's tools to the activation:
 * what each tool does and what the model reads. This file gives each call
 * the id the stream named, and hands the SDK each result as an MCP result.
 *
 * The SDK builds an MCP tool from a Zod shape. The three room schemas and
 * the schemas of the agent's tools are TypeBox values, which are JSON
 * Schema, so `shapeOf` reads each property through `z.fromJSONSchema`.
 */
import { type BoundTool, ROOM_SERVER } from '@ambionframework/ambion/hosting';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { TSchema } from 'typebox';
import { z } from 'zod';

/** The id of the next call of a tool. The core takes it from the steps the stream named. */
export type CallId = (tool: string) => string;

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
function mcpTool(one: BoundTool, callId: CallId): SdkMcpToolDefinition {
	return tool(one.name, one.description, shapeOf(one.parameters), async (args) => {
		const result = await one.run(args, callId(one.name));
		return {
			content: result.content.map((part) => ({ ...part })),
			...(result.isError ? { isError: true } : {}),
		};
	});
}

/** The in-process server for one activation, and the names of its tools as the SDK knows them. */
export function roomServer(tools: readonly BoundTool[], callId: CallId) {
	const served = tools.map((one) => mcpTool(one, callId));
	return {
		server: createSdkMcpServer({ name: ROOM_SERVER, tools: served }),
		names: served.map((one) => `mcp__${ROOM_SERVER}__${one.name}`),
	};
}
