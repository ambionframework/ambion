/**
 * The tools that the core bound to one activation, as the dynamic tools of a
 * Codex thread.
 *
 * The core binds the room tools and the agent's tools: what each tool does
 * and what the model reads. This file adds what is Codex's own: the JSON
 * Schema of each tool and the shape of a result.
 *
 * Codex sends no echo of the input it read. A tool result reaches the model
 * when the tool returns, so each call tells the core at once that its result
 * was delivered: a `missed` answer carries the missed lines to the model in
 * the same result.
 */
import type { ToolContent } from '@ambionframework/ambion';
import type { BoundTool, ExecutorActivation } from '@ambionframework/ambion/hosting';
import type { TSchema } from 'typebox';
import type { DynamicToolCallResponse, DynamicToolOutput, DynamicToolSpec } from './protocol.ts';

/** What a served tool reaches of the activation: the delivery of its result. */
export type Host = Pick<ExecutorActivation, 'delivered'>;

/** One tool of the thread: its spec, and what runs when the model calls it. */
export interface CodexTool {
	readonly spec: DynamicToolSpec;
	/** Run one call. `call` is the id of the call in the trace, and the idempotency key of a commit. */
	run(args: unknown, call: string): Promise<DynamicToolCallResponse>;
}

/** The JSON Schema of a TypeBox value, as plain data. */
function schemaOf(schema: TSchema): Record<string, unknown> {
	return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
}

/** One part of a tool result as Codex takes it. An image goes as a data URL. */
function outputOf(part: ToolContent): DynamicToolOutput {
	return part.type === 'text'
		? { type: 'inputText', text: part.text }
		: { type: 'inputImage', imageUrl: `data:${part.mimeType};base64,${part.data}` };
}

/** The result a tool that threw gives the model. */
function failure(error: unknown): DynamicToolCallResponse {
	const text = error instanceof Error ? error.message : String(error);
	return { contentItems: [{ type: 'inputText', text }], success: false };
}

/** A tool of the thread, from a tool the core bound. */
function served(one: BoundTool, host: Host): CodexTool {
	return {
		spec: {
			type: 'function',
			name: one.name,
			description: one.description,
			inputSchema: schemaOf(one.parameters),
		},
		run: async (args, call) => {
			try {
				const result = await one.run(args, call);
				host.delivered(call);
				return { contentItems: result.content.map(outputOf), success: result.isError !== true };
			} catch (error) {
				return failure(error);
			}
		},
	};
}

/** The tools of the thread for one activation. */
export function servedTools(tools: readonly BoundTool[], host: Host): CodexTool[] {
	return tools.map((one) => served(one, host));
}
