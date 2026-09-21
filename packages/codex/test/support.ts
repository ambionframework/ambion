/**
 * What the unit tests share: a view of a small room,
 * one activation opened over a room that records what the seat commits, and
 * a client of the room tools server.
 */
import { fileURLToPath } from 'node:url';
import { defineAgent, type Step } from '@ambionframework/ambion';
import type {
	ActivationView,
	AgentDefinition,
	CommitRequest,
	CommitResult,
	ExecutionEvent,
	RoomProtocol,
	TraceSink,
} from '@ambionframework/ambion/hosting';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ThreadEvent } from '@openai/codex-sdk';
import { type Bridge, startBridge } from '../src/bridge.ts';
import { type CodexOptions, codex, createCodexExecutor } from '../src/index.ts';
import type { Binding } from '../src/tools.ts';

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
			exchange: { owner: 'priya', from: 1 },
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
}

/**
 * A client whose threads replay recorded events. Turn `n` of the run plays
 * `turns[n]`. A turn that is an `Error` makes the run reject, as the SDK does
 * when the `codex` process exits before it says anything.
 */
function replay(turns: readonly (readonly ThreadEvent[] | Error)[]) {
	const seen: Replayed = { opened: [], prompts: [] };
	let next = 0;
	const thread = () => ({
		runStreamed: async (prompt: string) => {
			seen.prompts.push(prompt);
			const turn = turns[next++];
			if (turn === undefined) throw new Error('The replay has no turn left.');
			if (turn instanceof Error) throw turn;
			return {
				events: (async function* () {
					yield* turn;
				})(),
			};
		},
	});
	const client = () => ({
		startThread: () => {
			seen.opened.push({ resume: undefined });
			return thread();
		},
		resumeThread: (id: string) => {
			seen.opened.push({ resume: id });
			return thread();
		},
	});
	return { client, seen };
}

/** An executor of `definition` over a replay client, and a way to open its activations. */
export function open(
	turns: readonly (readonly ThreadEvent[] | Error)[],
	definition: AgentDefinition = seat(),
	answer: (request: CommitRequest) => CommitResult = lands,
) {
	const steps: Step[] = [];
	const events: ExecutionEvent[] = [];
	const { room, commits } = roomOf(answer);
	const { client, seen } = replay(turns);
	const trace: TraceSink = {
		startPass: () => {},
		record: (step) => void steps.push(step),
		usage: () => undefined,
		close: async () => {},
	};
	const executor = createCodexExecutor({ definition, client });
	const activate = (id = 'message:1:gpt:1') =>
		executor.open({ id, room, emit: (event) => void events.push(event), trace });
	return { executor, steps, commits, events, activate, seen };
}

/** A room tools server behind a real socket, and an MCP client of it. */
export interface Connected {
	readonly client: Client;
	readonly bridge: Bridge;
	readonly acknowledged: number[];
	readonly aborted: () => boolean;
	close(): Promise<void>;
}

/** Start the bridge for one activation, and connect an MCP client to the server it spawns. */
export async function connect(
	room: RoomProtocol,
	view: ActivationView = viewOf(),
	definition: AgentDefinition = seat(),
): Promise<Connected> {
	const acknowledged: number[] = [];
	const cut = new AbortController();
	let serial = 0;
	const binding: Binding = {
		id: view.spec.id,
		room,
		readThrough: view.through,
		signal: cut.signal,
		acknowledgeThrough: (seq) => void acknowledged.push(seq),
		callId: (tool) => `${tool}:${serial++}`,
		abort: () => cut.abort(),
	};
	const bridge = await startBridge(view, definition, binding);
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
		acknowledged,
		aborted: () => cut.signal.aborted,
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
