/**
 * The room tools bound to one activation, and the agent's own tools, as
 * plain handlers that the bridge serves over the local socket.
 *
 * The core's `roomTools` and `agentTools` hold what each tool does and what
 * the model reads. This file adds what is Codex's own: the JSON Schema of
 * each tool, and the changed workspace paths that an ordinary say cites.
 *
 * Codex sends no echo of the input it read. The binding is synchronous: an
 * accepted say confirms the read position, and a `missed` answer carries
 * the missed lines to the model in the same result, so the read position
 * moves to the last of them at once.
 */
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
	ActivationView,
	AgentDefinition,
	RoomTool as CoreTool,
	RoomProtocol,
	Seq,
} from '@ambionframework/ambion/hosting';
import { agentTools, roomTools as coreRoomTools } from '@ambionframework/ambion/hosting';
import type { TSchema } from 'typebox';
import type { Result, ToolSpec } from './wire.ts';

/** What every room tool reaches: the activation and the room. */
export interface Binding {
	readonly id: string;
	readonly room: RoomProtocol;
	readonly readThrough: Seq;
	/** Aborts when the activation is cut. */
	readonly signal: AbortSignal;
	/** The model read the record through `seq`. */
	acknowledgeThrough(seq: Seq): void;
	/** The id the model gave this call. A call the stream did not name gets a fresh id. */
	callId(tool: string): string;
	abort(): void;
}

/** The workspace paths the agent changed since its last say. */
export interface Changed {
	peek(): readonly string[];
	clear(): void;
}

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

/** A tool the bridge serves, from a core tool. Each call takes the id the stream named for it. */
function served(one: CoreTool, binding: Binding): RoomTool {
	return {
		spec: { name: one.name, description: one.description, inputSchema: schemaOf(one.parameters) },
		run: async (args) => {
			const result = await one.run(args, binding.callId(one.name));
			return {
				content: result.content.map((part) => ({ ...part })),
				...(result.isError ? { isError: true } : {}),
			};
		},
	};
}

/**
 * The tools an activation holds, by its purpose. A say cites its refs as
 * URIs, once each. An ordinary say also cites the paths the agent changed,
 * and the room taking it clears them.
 */
export function roomTools(
	view: ActivationView,
	agent: AgentDefinition,
	binding: Binding,
	changed: Changed,
	current: () => ActivationView = () => view,
): RoomTool[] {
	const ordinary = view.spec.purpose.kind !== 'summarize';
	const room = coreRoomTools(
		view,
		{
			id: binding.id,
			room: binding.room,
			get readThrough() {
				return binding.readThrough;
			},
			acknowledgeThrough: (seq) => binding.acknowledgeThrough(seq),
			// The result carries the missed lines, so the model reads them now.
			resultExpected: (_call, seq) => binding.acknowledgeThrough(seq),
			abort: () => binding.abort(),
		},
		{
			refs: (cited) => {
				const all = [...cited, ...(ordinary ? changed.peek() : [])];
				return [...new Set(all.map(refOf).filter((ref) => ref.length > 0))];
			},
			spoke: () => changed.clear(),
		},
	);
	return [...room, ...agentTools(view, agent, binding.signal, current)].map((one) =>
		served(one, binding),
	);
}
