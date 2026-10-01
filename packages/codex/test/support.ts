/**
 * What the unit tests share: a view of a small room,
 * one activation opened over a room that records what the seat commits, and
 * a client of the room tools server.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect as connectSocket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineAgent, type Step } from '@ambionframework/ambion';
import {
	type ActivationEvent,
	type ActivationView,
	type AgentDefinition,
	type CommitRequest,
	type CommitResult,
	type Executor,
	ROOM_SERVER,
	type RoomProtocol,
	type StepSink,
} from '@ambionframework/ambion/hosting';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type {
	CodexOptions as SdkClientOptions,
	ThreadEvent,
	ThreadOptions,
} from '@openai/codex-sdk';
import { ActivationState } from '../../ambion/src/execution/activation.ts';
import { type Bridge, startBridge } from '../src/bridge.ts';
import type { CatalogEntry, CatalogSource } from '../src/catalog.ts';
import { createCodexExecutor } from '../src/executor.ts';
import { type CodexOptions, codex } from '../src/index.ts';
import { type CodexTool, servedTools } from '../src/tools.ts';
import { frame, type Reply, receive } from '../src/wire.ts';

/** The catalog entries that a real `codex` 0.158.0 printed, for `gpt-5.6-luna` and `gpt-5.5`. */
export const catalogFixture = JSON.parse(
	readFileSync(new URL('./fixtures/catalog-0.158.0.json', import.meta.url), 'utf8'),
) as { models: CatalogEntry[] };

/** A catalog source that reads the recorded entries. */
export const recordedCatalog: CatalogSource = async (model) =>
	catalogFixture.models.find((entry) => entry.slug === model);

const server = fileURLToPath(new URL('../src/room-tools-server.ts', import.meta.url));

export const seat = (options: Partial<CodexOptions> = {}): AgentDefinition =>
	defineAgent({
		name: 'gpt',
		identity: 'Answers what is asked.',
		executor: codex({ instructions: 'Answer once.', model: 'gpt-5.6-luna', ...options }),
	});

/** The view a seat reads when the person asked one question at position 1. */
export function viewOf(
	purpose: ActivationView['spec']['purpose'] = { kind: 'respond', message: 1 },
) {
	const view: ActivationView = {
		spec: { id: 'message:1:gpt:1', seat: 'gpt', attempt: 1, purpose },
		through: 1,
		context: {
			name: 'lab',
			now: 0,
			participants: [
				{
					kind: 'human',
					name: 'priya',
					identity: 'Project manager.',
					presence: 'present',
					messagesSinceDeparture: 0,
				},
				{
					kind: 'agent',
					name: 'gpt',
					identity: 'Answers what is asked.',
					status: 'active',
					attention: 'broadcast',
				},
			],
			messages: [
				{
					kind: 'said',
					seq: 1,
					at: new Date(0).toISOString(),
					from: 'priya',
					text: 'When is the pour?',
				},
			],
			exchange: { person: 'priya', from: 1 },
			reserve: [],
		},
	};
	return view;
}

/** A room that answers every commit with `answer`, and records what it was asked. */
export function roomOf(answer: (request: CommitRequest) => CommitResult) {
	const commits: CommitRequest[] = [];
	const room: RoomProtocol = {
		view: async () => ({ stale: 'unused' }),
		lease: async () => ({ stale: 'unused' }),
		commit: async (request) => {
			commits.push(request);
			return answer(request);
		},
	};
	return { room, commits };
}

/** The answer of a room that lands every said at the next position. */
export function lands(request: CommitRequest): CommitResult {
	if (request.intent.kind !== 'said') return { refused: 'unused' };
	return {
		committed: {
			kind: 'said',
			seq: 2,
			at: new Date(0).toISOString(),
			from: 'gpt',
			text: request.intent.text,
		},
	};
}

/** What a replay client saw: each thread it opened, and each prompt it ran. */
interface Replayed {
	readonly opened: { readonly resume: string | undefined }[];
	readonly prompts: string[];
	/** The options of the client and of each thread, in order. */
	readonly clients: SdkClientOptions[];
	readonly threads: ThreadOptions[];
}

/** A turn that plays live: it reaches the room tools through the socket of the client that runs it. */
export type LiveTurn = (socketPath: string) => AsyncIterable<ThreadEvent>;

/** One turn of a replay: recorded events, a failure before any event, or a live turn. */
export type Turn = readonly ThreadEvent[] | Error | LiveTurn;

/** The socket path that the options of a client hand the room tools server. */
function socketOf(options: SdkClientOptions): string {
	const config = options.config as { mcp_servers: Record<string, { args: string[] }> };
	const path = config.mcp_servers[ROOM_SERVER]?.args[1];
	if (path === undefined) throw new Error('The client has no room tools server.');
	return path;
}

/** Call one room tool over the socket, as the room tools server does, and give back the reply. */
export async function callOver(socketPath: string, tool: string, args: unknown): Promise<Reply> {
	const socket = connectSocket(socketPath);
	try {
		return await new Promise<Reply>((resolve, reject) => {
			socket.once('error', reject);
			receive(socket, (message) => resolve(message as Reply));
			socket.write(frame({ id: 1, kind: 'call', tool, args }));
		});
	} finally {
		socket.destroy();
	}
}

/**
 * A live turn that says `text` through the room tools, as a real `codex`
 * reports it: the call item starts, the tool runs, and the item completes.
 * A real `codex` numbers the items of each turn from `item_0`, so every
 * turn of this kind names its say `item_1`.
 */
export function sayingTurn(text: string, thread = 'thread-1'): LiveTurn {
	return async function* (socketPath): AsyncGenerator<ThreadEvent> {
		const item = {
			id: 'item_1',
			type: 'mcp_tool_call' as const,
			server: ROOM_SERVER,
			tool: 'say',
			arguments: { text },
		};
		yield { type: 'thread.started', thread_id: thread };
		yield { type: 'turn.started' };
		yield { type: 'item.started', item: { ...item, status: 'in_progress' } };
		const reply = await callOver(socketPath, 'say', { text });
		const result = 'result' in reply ? reply.result : { content: [] };
		yield {
			type: 'item.completed',
			item: { ...item, status: 'completed', result: { ...result, structured_content: null } },
		};
		yield {
			type: 'turn.completed',
			usage: {
				input_tokens: 1,
				cached_input_tokens: 0,
				cache_write_input_tokens: 0,
				output_tokens: 1,
				reasoning_output_tokens: 0,
			},
		};
	};
}

/**
 * A client whose threads replay recorded events. Turn `n` of the run plays
 * `turns[n]`. A turn that is an `Error` makes the run reject, as the SDK does
 * when the `codex` process exits before it says anything.
 */
function replay(turns: readonly Turn[]) {
	const seen: Replayed = { opened: [], prompts: [], clients: [], threads: [] };
	let next = 0;
	const thread = (options: SdkClientOptions) => ({
		runStreamed: async (prompt: string) => {
			seen.prompts.push(prompt);
			const turn = turns[next++];
			if (turn === undefined) throw new Error('The replay has no turn left.');
			if (turn instanceof Error) throw turn;
			if (typeof turn === 'function') return { events: turn(socketOf(options)) };
			return {
				events: (async function* () {
					yield* turn;
				})(),
			};
		},
	});
	const client = (options: SdkClientOptions) => {
		seen.clients.push(options);
		return {
			startThread: (threadOptions?: ThreadOptions) => {
				seen.opened.push({ resume: undefined });
				if (threadOptions) seen.threads.push(threadOptions);
				return thread(options);
			},
			resumeThread: (id: string, threadOptions?: ThreadOptions) => {
				seen.opened.push({ resume: id });
				if (threadOptions) seen.threads.push(threadOptions);
				return thread(options);
			},
		};
	};
	return { client, seen };
}

/** The Codex home of the executors in this file. The replay client never reads it, and it never holds a login. */
const SEAT_HOME = mkdtempSync(join(tmpdir(), 'ambion-codex-seat-'));
process.once('exit', () => rmSync(SEAT_HOME, { recursive: true, force: true }));

/** An executor of `definition` over a replay client, and a way to open its activations. */
export function open(
	turns: readonly Turn[],
	definition: AgentDefinition = seat(),
	answer: (request: CommitRequest) => CommitResult = lands,
	catalog: CatalogSource = recordedCatalog,
) {
	const steps: Step[] = [];
	const events: ActivationEvent[] = [];
	const { room, commits } = roomOf(answer);
	const { client, seen } = replay(turns);
	const trace: StepSink = {
		record: (step) => void steps.push(step),
	};
	const executor = createCodexExecutor({
		definition,
		client,
		catalog,
		home: SEAT_HOME,
		login: false,
	});
	/** The core state of one activation, as the driver opens it. */
	const activate = (id = 'message:1:gpt:1') =>
		new ActivationState(executor, {
			id,
			room,
			definition,
			emit: (event) => void events.push(event),
			trace,
		});
	return { executor, steps, commits, events, activate, seen };
}

/** A room tools server behind a real socket, and an MCP client of it. */
export interface Connected {
	readonly client: Client;
	readonly bridge: Bridge;
	/** The position the core holds as read. */
	readonly readThrough: () => number;
	/** Whether the activation was cut. */
	readonly aborted: () => boolean;
	close(): Promise<void>;
}

const noTrace: StepSink = {
	record: () => {},
};

/**
 * The tools that the core binds on a first pass over `view`, served as the
 * Codex executor serves them. The pass reads the view and runs no model.
 */
async function bindTools(room: RoomProtocol, view: ActivationView, definition: AgentDefinition) {
	let served: CodexTool[] = [];
	let signal = new AbortController().signal;
	let serial = 0;
	const executor: Executor = (activation) => {
		signal = activation.signal;
		return {
			pass: async (pass) => {
				activation.read({ after: 0, through: pass.view.through });
				served = servedTools(pass.tools, {
					callId: (tool) => `${tool}:${serial++}`,
					delivered: (call) => activation.delivered(call),
				});
				return { failed: false };
			},
		};
	};
	const state = new ActivationState(executor, {
		id: view.spec.id,
		room,
		definition,
		emit: () => {},
		trace: noTrace,
	});
	await state.pass({ kind: 'view', view });
	return { state, served, signal };
}

/** Start the bridge for one activation, and connect an MCP client to the server it spawns. */
export async function connect(
	room: RoomProtocol,
	view: ActivationView = viewOf(),
	definition: AgentDefinition = seat(),
): Promise<Connected> {
	const { state, served, signal } = await bindTools(room, view, definition);
	const bridge = await startBridge(served, signal);
	const client = new Client({ name: 'test', version: '0.0.0' });
	await client.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [server, bridge.socketPath],
			stderr: 'ignore',
		}),
	);
	return {
		client,
		bridge,
		readThrough: () => state.readThrough,
		aborted: () => state.cancelled,
		close: async () => {
			await client.close();
			bridge.close();
		},
	};
}

/** The text of a tool result. */
export function textOf(result: unknown): string {
	const { content } = result as { content: { type: string; text?: string }[] };
	return content.map((part) => part.text ?? '').join('');
}

/** Wait until `read` holds, for at most `ms` milliseconds. */
export async function until(read: () => boolean, what: string, ms = 5_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!read()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
