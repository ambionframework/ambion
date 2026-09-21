/**
 * What the unit tests share: the fake executable, a view of a small room,
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
	ExecutorSession,
	RoomProtocol,
	TraceSink,
} from '@ambionframework/ambion/hosting';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { type Bridge, startBridge } from '../src/bridge.ts';
import { type CodexOptions, codex, createCodexExecutor } from '../src/index.ts';
import type { FakeScenario } from '../src/testing.ts';
import type { Binding } from '../src/tools.ts';

export const executable = fileURLToPath(new URL('./fake/codex', import.meta.url));
const server = fileURLToPath(new URL('../src/room-tools-server.ts', import.meta.url));

export const seat = (options: Partial<CodexOptions> = {}): AgentDefinition =>
	defineAgent({
		name: 'gpt',
		identity: 'Answers what is asked.',
		executor: codex({ instructions: 'Answer once.', model: 'codex-fake', ...options }),
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

export interface Opened {
	readonly session: ExecutorSession;
	readonly steps: Step[];
	readonly commits: CommitRequest[];
	readonly events: ExecutionEvent[];
}

/** Open one activation of `definition` over the fake, with a scenario. */
export function open(
	scenario: FakeScenario,
	definition: AgentDefinition = seat(),
	answer: (request: CommitRequest) => CommitResult = lands,
): Opened {
	const steps: Step[] = [];
	const events: ExecutionEvent[] = [];
	const { room, commits } = roomOf(answer);
	const trace: TraceSink = {
		startPass: () => {},
		record: (step) => void steps.push(step),
		usage: () => undefined,
		close: async () => {},
	};
	const executor = createCodexExecutor({
		definition,
		codexPath: executable,
		env: { ...process.env, AMBION_FAKE: JSON.stringify(scenario) },
	});
	const session = executor.open({
		id: 'message:1:gpt:1',
		room,
		emit: (event) => void events.push(event),
		trace,
	});
	return { session, steps, commits, events };
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
