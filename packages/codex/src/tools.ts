/**
 * The tools that the core bound to one activation, as plain handlers that
 * the bridge serves over the local socket.
 *
 * The core binds the room tools and the agent's tools: what each tool does
 * and what the model reads. This file adds what is Codex's own: the JSON
 * Schema of each tool, the id of each call, and the changed workspace paths
 * that an ordinary say cites.
 *
 * Codex sends no echo of the input it read. A tool result reaches the model
 * when the tool returns, so each call tells the core at once that its result
 * was delivered: a `missed` answer carries the missed lines to the model in
 * the same result.
 */
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
	RoomTool as CoreTool,
	ExecutorActivation,
	RoomToolOptions,
} from '@ambionframework/ambion/hosting';
import type { TSchema } from 'typebox';
import type { Result, ToolSpec } from './wire.ts';

/** What a served tool reaches of the activation: the id of each call, and the delivery of its result. */
export type Host = Pick<ExecutorActivation, 'callId' | 'delivered'>;

/** One tool the server lists: its spec, and what runs when the model calls it. */
export interface RoomTool {
	readonly spec: ToolSpec;
	run(args: unknown): Promise<Result>;
}

/** The JSON Schema of a TypeBox value, as plain data. */
function schemaOf(schema: TSchema): Record<string, unknown> {
	return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
}

/** A ref is one absolute URI with a scheme. Codex reports a changed file as a path, so a path becomes a `file:` URI. */
export function refOf(value: string): string {
	const ref = value.trim();
	return isAbsolute(ref) ? pathToFileURL(ref).href : ref;
}

/**
 * What a say and a schedule of a Codex seat add. A say cites its refs as
 * URIs, once each. An ordinary say also cites the paths the agent changed,
 * and the room taking a say clears them.
 */
export function citing(changed: Set<string>, ordinary: () => boolean): RoomToolOptions {
	return {
		refs: (cited) => {
			const all = [...cited, ...(ordinary() ? changed : [])];
			return [...new Set(all.map(refOf).filter((ref) => ref.length > 0))];
		},
		said: () => changed.clear(),
	};
}

/** A tool the bridge serves, from a tool the core bound. Each call takes the id the stream named for it. */
function served(one: CoreTool, host: Host): RoomTool {
	return {
		spec: { name: one.name, description: one.description, inputSchema: schemaOf(one.parameters) },
		run: async (args) => {
			const call = host.callId(one.name);
			const result = await one.run(args, call);
			host.delivered(call);
			return {
				content: result.content.map((part) => ({ ...part })),
				...(result.isError ? { isError: true } : {}),
			};
		},
	};
}

/** The tools the bridge serves for one activation. */
export function servedTools(tools: readonly CoreTool[], host: Host): RoomTool[] {
	return tools.map((one) => served(one, host));
}
