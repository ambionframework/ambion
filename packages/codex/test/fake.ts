/**
 * A fake app-server. It answers the requests of an activation and replays
 * the notifications that a real `codex app-server` sent for the same
 * requests, in the order the binary tier recorded them. The fake stands in
 * for the process. The binary tier proves the replay against the real one.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type Connect,
	type Connection,
	type Handlers,
	type Launch,
	RpcError,
} from '../src/app-server.ts';
import type { DynamicToolCallResponse, DynamicToolSpec, TurnError } from '../src/protocol.ts';

/** How a scripted turn ends. */
export interface TurnEnd {
	readonly status: 'completed' | 'failed' | 'interrupted';
	readonly error?: TurnError;
}

/** What a scripted turn can do. The fake adds the thread and the turn to each notification. */
export interface TurnContext {
	/** The text of the input that started the turn. */
	readonly prompt: string;
	/** The lines that `turn/steer` accepted, in order. */
	readonly steers: string[];
	/** Resolves when the host sends `turn/interrupt`. */
	readonly interrupted: Promise<void>;
	emit(method: string, params?: object): void;
	/** A request of the server to the host. It rejects with the error the host answers. */
	ask(method: string, params: object): Promise<unknown>;
	/** The turn is over for `turn/steer`, but `turn/completed` waits until the script returns. */
	finish(): void;
	/** One tool call of the model: the item starts, the host runs the tool, and the item completes. */
	call(tool: string, args: unknown): Promise<DynamicToolCallResponse>;
	/** One agent message: a delta, then the completed item. */
	reply(text: string): void;
	/** The tokens of one model request. */
	usage(tokens?: { input: number; cached: number; output: number }): void;
	/** The process dies with `stderr` as its last words. */
	crash(stderr: string): void;
}

/** One scripted turn. It returns how the turn ends, and a turn that returns nothing completes. */
export type FakeTurn = (turn: TurnContext) => Promise<TurnEnd | undefined> | TurnEnd | undefined;

/** What the fake saw. */
export interface FakeSeen {
	readonly launches: Launch[];
	/** Every request of the host, in order. */
	readonly requests: { readonly method: string; readonly params: unknown }[];
	/** The notifications the host sent. */
	readonly notified: string[];
	/** How many connections were closed. */
	closed: number;
}

/** What the fake does besides the script. */
export interface FakeOptions {
	/** Whether `turn/steer` echoes an accepted line. Default true. */
	readonly echoSteers?: boolean;
	/** The process ends as soon as it starts, with this reason. */
	readonly startError?: string;
	/** The error `thread/resume` answers for every thread. Absent, a known thread resumes. */
	readonly resumeError?: string;
}

/** The thread fields of an answer, with a rollout file when the thread keeps tools. */
function openedOf(id: string, path: string | null, params: Record<string, unknown>) {
	return {
		thread: { id, path, cliVersion: '0.159.2' },
		model: params.model,
		cwd: params.cwd,
		approvalPolicy: params.approvalPolicy,
		sandbox: { type: 'readOnly', networkAccess: false },
	};
}

/** The tokens of one request as the server reports them. */
function breakdown(tokens: { input: number; cached: number; output: number }) {
	return {
		totalTokens: tokens.input + tokens.output,
		inputTokens: tokens.input,
		cachedInputTokens: tokens.cached,
		cacheWriteInputTokens: 0,
		outputTokens: tokens.output,
		reasoningOutputTokens: 0,
	};
}

/** The turn in flight. */
interface Active {
	readonly id: string;
	readonly index: number;
	over: boolean;
	readonly steers: string[];
	readonly interrupted: Promise<void>;
	readonly interrupt: () => void;
}

/** The directory of the rollout files. It plays the home of the host. */
const directory = mkdtempSync(join(tmpdir(), 'ambion-codex-fake-'));
process.once('exit', () => rmSync(directory, { recursive: true, force: true }));

/** The fake, and what it saw. */
export function fakeServer(turns: readonly FakeTurn[], options: FakeOptions = {}) {
	const seen: FakeSeen = { launches: [], requests: [], notified: [], closed: 0 };
	/** The dynamic tools that each thread keeps, by thread id. It plays the disk of the host. */
	const kept = new Map<string, readonly DynamicToolSpec[]>();
	let threads = 0;
	let nextTurn = 0;
	let dead = false;
	let handlers: Handlers | undefined;
	/** The turn in flight. */
	let active: Active | undefined;

	/** Write the rollout file of a thread, and give its path. */
	function rollout(id: string): string {
		const path = join(directory, `rollout-${id}.jsonl`);
		const line = { type: 'session_meta', payload: { id, dynamic_tools: kept.get(id) ?? [] } };
		writeFileSync(path, `${JSON.stringify(line)}\n{"type":"event_msg"}\n`);
		return path;
	}

	const notify = (method: string, params: object) => handlers?.notification(method, params);

	function echo(thread: string, turn: string, clientId: string, text: string): void {
		const item = {
			type: 'userMessage',
			id: `user-${clientId}`,
			clientId,
			content: [{ type: 'text', text, text_elements: [] }],
		};
		notify('item/started', { threadId: thread, turnId: turn, item });
		notify('item/completed', { threadId: thread, turnId: turn, item });
	}

	function context(thread: string, state: Active, prompt: string): TurnContext {
		const turn = state.id;
		let serial = 0;
		const emit = (method: string, params: object = {}) =>
			notify(method, { threadId: thread, turnId: turn, ...params });
		return {
			prompt,
			steers: state.steers,
			interrupted: state.interrupted,
			emit,
			ask: async (method, params) =>
				handlers?.request(method, { threadId: thread, turnId: turn, ...params }),
			finish: () => {
				state.over = true;
			},
			call: async (tool, args) => {
				const id = `call_${++serial}`;
				const item = { type: 'dynamicToolCall', id, namespace: null, tool, arguments: args };
				emit('item/started', {
					item: { ...item, status: 'inProgress', contentItems: null, success: null },
				});
				const answer = (await handlers?.request('item/tool/call', {
					threadId: thread,
					turnId: turn,
					callId: id,
					namespace: null,
					tool,
					arguments: args,
				})) as DynamicToolCallResponse;
				emit('item/completed', {
					item: {
						...item,
						status: answer.success ? 'completed' : 'failed',
						contentItems: answer.contentItems,
						success: answer.success,
					},
				});
				return answer;
			},
			reply: (text) => {
				const id = `msg_${++serial}`;
				const item = { type: 'agentMessage', id, text };
				emit('item/started', { item: { ...item, text: '' } });
				emit('item/agentMessage/delta', { itemId: id, delta: text });
				emit('item/completed', { item });
			},
			usage: (tokens = { input: 10, cached: 0, output: 5 }) =>
				emit('thread/tokenUsage/updated', {
					tokenUsage: { total: breakdown(tokens), last: breakdown(tokens) },
				}),
			crash: (stderr) => {
				dead = true;
				handlers?.exit({ reason: 'exited with code 1', stderr });
			},
		};
	}

	async function runTurn(thread: string, state: Active, prompt: string, id: string): Promise<void> {
		const script = turns[state.index];
		if (script === undefined) throw new Error('The fake has no turn left.');
		const turn = state.id;
		const ctx = context(thread, state, prompt);
		notify('turn/started', { threadId: thread, turn: { id: turn, status: 'inProgress' } });
		echo(thread, turn, id, prompt);
		const end = (await script(ctx)) ?? { status: 'completed' };
		if (dead) return;
		state.over = true;
		notify('turn/completed', {
			threadId: thread,
			turn: { id: turn, status: end.status, error: end.error ?? null },
		});
	}

	type Params = Record<string, unknown>;

	function startThread(params: Params): unknown {
		const id = `thread-${++threads}`;
		kept.set(id, (params.dynamicTools as DynamicToolSpec[] | undefined) ?? []);
		return openedOf(id, rollout(id), params);
	}

	function resumeThread(params: Params): unknown {
		const id = String(params.threadId);
		if (options.resumeError !== undefined) throw new RpcError(-32600, options.resumeError);
		if (!kept.has(id)) throw new RpcError(-32600, `no rollout found for thread id ${id}`);
		return openedOf(id, rollout(id), params);
	}

	function startTurn(params: Params): unknown {
		// The turn is active as soon as the server answers.
		const interrupted = Promise.withResolvers<void>();
		const state: Active = {
			id: `turn-${nextTurn + 1}`,
			index: nextTurn++,
			over: false,
			steers: [],
			interrupted: interrupted.promise,
			interrupt: interrupted.resolve,
		};
		active = state;
		const text = (params.input as { text: string }[])[0]?.text ?? '';
		const id = String(params.clientUserMessageId);
		const thread = String(params.threadId);
		setImmediate(() => void runTurn(thread, state, text, id));
		return { turn: { id: state.id, status: 'inProgress' } };
	}

	function steerTurn(params: Params): unknown {
		if (active === undefined || active.over) throw new RpcError(-32600, 'no active turn to steer');
		if (params.expectedTurnId !== active.id) throw new RpcError(-32600, 'expected turn mismatch');
		const text = (params.input as { text: string }[])[0]?.text ?? '';
		active.steers.push(text);
		if (options.echoSteers !== false) {
			echo(String(params.threadId), active.id, String(params.clientUserMessageId), text);
		}
		return { turnId: active.id };
	}

	/** The answer of each request the fake knows. */
	const answers: Record<string, (params: Params) => unknown> = {
		initialize: () => ({ userAgent: 'fake/0.159.2' }),
		'thread/start': startThread,
		'thread/resume': resumeThread,
		'account/read': () => ({ account: { type: 'apiKey' } }),
		'mcpServerStatus/list': () => ({ data: [{ name: 'node_repl', runtimeStatus: 'disabled' }] }),
		'turn/start': startTurn,
		'turn/steer': steerTurn,
		'turn/interrupt': () => {
			active?.interrupt();
			return {};
		},
	};

	async function answer(method: string, raw: unknown): Promise<unknown> {
		const respond = answers[method];
		if (respond === undefined) throw new RpcError(-32601, `The fake knows no ${method}.`);
		return respond((raw ?? {}) as Params);
	}

	const connect: Connect = (launch, given) => {
		seen.launches.push(launch);
		handlers = given;
		dead = options.startError !== undefined;
		if (options.startError !== undefined) {
			const reason = options.startError;
			queueMicrotask(() => given.exit({ reason, stderr: '' }));
		}
		const connection: Connection = {
			request: async (method, params) => {
				seen.requests.push({ method, params });
				if (dead)
					throw new Error(`Codex app-server ${options.startError ?? 'exited with code 1'}.`);
				return answer(method, params);
			},
			notify: (method) => void seen.notified.push(method),
			stderr: () => '',
			close: () => {
				seen.closed += 1;
			},
		};
		return connection;
	};

	return {
		connect,
		seen,
		/** The requests of one method, in order. */
		requestsOf: (method: string) =>
			seen.requests.filter((request) => request.method === method).map((request) => request.params),
		/** What the fake persisted: the tools of each thread it started. */
		kept,
	};
}
