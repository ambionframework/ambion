/**
 * The executor over a fake app-server: the seat text in the thread
 * parameters, exchange continuity, steer, the cut, the end of the process,
 * the session step, and the recipe that turns native tools off.
 */
import { existsSync, readdirSync } from 'node:fs';
import type { Message } from '@ambionframework/ambion';
import type {
	CommitRequest,
	CommitResult,
	PassInput,
	VendorSession,
} from '@ambionframework/ambion/hosting';
import { describe, expect, it } from 'vitest';
import type { ActivationState } from '../../ambion/src/execution/activation.ts';
import { SEAT_NOTE } from '../src/options.ts';
import type { FakeTurn } from './fake.ts';
import { open, plainTurn, sayingTurn, seat, until, viewOf } from './support.ts';

/** The first view of an activation, with the session the room recorded. */
function input(resume?: VendorSession): PassInput {
	const view = viewOf();
	return { kind: 'view', view: resume ? { ...view, spec: { ...view.spec, resume } } : view };
}

/** Run one pass of a session and read the session it reports. */
async function run(session: ActivationState, resume?: VendorSession) {
	const result = await session.pass(input(resume));
	session.close?.();
	return { result, session: session.session };
}

/** The text of the prompts the fake received, in order. */
const promptsOf = (room: ReturnType<typeof open>) =>
	room.fake.requestsOf('turn/start').map((params) => {
		const { input: parts } = params as { input: { text: string }[] };
		return parts[0]?.text ?? '';
	});

describe('exchange continuity', () => {
	it('records the thread id, resumes only the thread the view names, and keeps the seat text out of the prompt', async () => {
		const room = open([plainTurn, plainTurn, plainTurn]);
		const first = await run(room.activate('a1'));
		expect(first.result).toEqual({ failed: false });
		expect(first.session).toEqual({ kind: 'codex', id: 'thread-1' });
		await run(room.activate('a2'), first.session);
		await run(room.activate('a3'));
		const resumed = room.fake.requestsOf('thread/resume');
		expect(resumed).toMatchObject([{ threadId: 'thread-1' }]);
		expect(room.fake.requestsOf('thread/start')).toHaveLength(2);
		expect(promptsOf(room)[0]).not.toContain(SEAT_NOTE);
		expect(SEAT_NOTE).toContain('`say`');
		expect(SEAT_NOTE).toContain('reaches no one');
	});

	it('ignores a session that another executor recorded', async () => {
		const room = open([plainTurn]);
		await run(room.activate(), { kind: 'claude', id: 'saved' });
		expect(room.fake.requestsOf('thread/resume')).toEqual([]);
		expect(room.fake.requestsOf('thread/start')).toHaveLength(1);
	});

	it('sends the seat text again on a resume, and keeps it out of the prompt', async () => {
		const room = open([plainTurn, plainTurn]);
		const first = await run(room.activate('a1'));
		await run(room.activate('a2'), first.session);
		const [start] = room.fake.requestsOf('thread/start') as { baseInstructions: string }[];
		const [resume] = room.fake.requestsOf('thread/resume') as { baseInstructions: string }[];
		expect(start?.baseInstructions.startsWith(SEAT_NOTE)).toBe(true);
		expect(start?.baseInstructions).toContain('Answer once.');
		expect(resume?.baseInstructions).toBe(start?.baseInstructions);
		expect(promptsOf(room)[1]).not.toContain('Answer once.');
	});

	it('starts a fresh thread when Codex refuses the resume, and says so in the trace', async () => {
		const room = open([plainTurn], seat(), undefined, undefined, {
			resumeError: 'no rollout found for thread id bogus',
		});
		const session = room.activate();
		const result = await session.pass(input({ kind: 'codex', id: 'bogus' }));
		session.close?.();
		expect(result).toEqual({ failed: false });
		expect(room.fake.requestsOf('thread/resume')).toHaveLength(1);
		expect(room.fake.requestsOf('thread/start')).toHaveLength(1);
		expect(session.session).toEqual({ kind: 'codex', id: 'thread-1' });
		expect(room.steps).toContainEqual(
			expect.objectContaining({
				type: 'notice',
				level: 'info',
				text: 'Codex thread not resumed',
				data: { thread: 'bogus', reason: 'no rollout found for thread id bogus' },
			}),
		);
		expect(room.events.filter((event) => event.type === 'error')).toEqual([]);
	});

	it('starts a fresh thread when the thread keeps other tools than the activation binds', async () => {
		const room = open([plainTurn, plainTurn]);
		const first = await run(room.activate('a1'));
		// The thread keeps its tools on the disk of the host. A later activation binds one more.
		const kept = room.fake.kept.get('thread-1') ?? [];
		room.fake.kept.set('thread-1', kept.slice(1));
		const second = await run(room.activate('a2'), first.session);
		expect(second.session).toEqual({ kind: 'codex', id: 'thread-2' });
		expect(room.fake.requestsOf('thread/resume')).toHaveLength(1);
		expect(room.fake.requestsOf('thread/start')).toHaveLength(2);
		expect(room.steps).toContainEqual(
			expect.objectContaining({
				text: 'Codex thread not resumed',
				data: { thread: 'thread-1', reason: 'the thread keeps other tools' },
			}),
		);
	});

	it('reports a failure of a fresh thread and does not try again', async () => {
		const room = open([() => ({ status: 'failed', error: { message: 'connection reset' } })]);
		const { result } = await run(room.activate());
		expect(result).toMatchObject({ failed: true, cause: 'transient', message: 'connection reset' });
		expect(room.fake.requestsOf('thread/start')).toHaveLength(1);
		expect(room.fake.requestsOf('turn/start')).toHaveLength(1);
	});

	it('takes the status of the provider from the error of a failed turn', async () => {
		const room = open([
			() => ({
				status: 'failed',
				error: {
					message: 'The request failed.',
					codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 403 } },
				},
			}),
		]);
		const { result } = await run(room.activate());
		expect(result).toMatchObject({ failed: true, cause: 'permanent' });
	});
});

/**
 * A room that keeps one message for each commit key, as the journal does. A
 * commit under a key the room holds gets the message it already holds.
 */
function keyedRoom() {
	const byKey = new Map<string, Message>();
	return (request: CommitRequest): CommitResult => {
		const held = byKey.get(request.key);
		if (held !== undefined) return { committed: held };
		if (request.intent.kind !== 'said') return { refused: 'unused' };
		const message: Message = {
			kind: 'said',
			seq: byKey.size + 2,
			key: request.key,
			activation: request.activation,
			at: new Date(0).toISOString(),
			from: 'gpt',
			text: request.intent.text,
		};
		byKey.set(request.key, message);
		return { committed: message };
	};
}

describe('room tools', () => {
	it('lands the say of each activation under its own key, and names the call in the trace by the same key', async () => {
		const answer = keyedRoom();
		const room = open(
			[sayingTurn('The pour is Saturday.'), sayingTurn('The pour is Saturday.')],
			seat(),
			answer,
		);
		const first = await run(room.activate('message:1:gpt:1'));
		await run(room.activate('message:3:gpt:1'), first.session);
		const keys = room.commits.map((request) => request.key);
		expect(keys).toHaveLength(2);
		expect(new Set(keys).size).toBe(2);
		const calls = room.steps.flatMap((step) => (step.type === 'tool_call' ? [step.call] : []));
		expect(calls).toEqual(keys);
	});

	it('tells the core that each result reached the model, and counts one usage step for each model request', async () => {
		const room = open([sayingTurn('Done.')]);
		const state = room.activate();
		await state.pass(input());
		state.close?.();
		expect(room.steps.filter((step) => step.type === 'usage')).toHaveLength(2);
		expect(state.readThrough).toBe(2);
	});

	it('refuses every server request except a tool call, and says so in the trace', async () => {
		let refused: unknown;
		const turn: FakeTurn = async (ctx) => {
			ctx.reply('ok');
			refused = await ctx
				.ask('item/commandExecution/requestApproval', { command: 'ls' })
				.catch((error: unknown) => error);
			return undefined;
		};
		const room = open([turn]);
		await run(room.activate());
		expect(refused).toMatchObject({ code: -32601 });
		expect(room.steps).toContainEqual(
			expect.objectContaining({
				type: 'notice',
				level: 'warning',
				text: expect.stringContaining('item/commandExecution/requestApproval'),
			}),
		);
	});
});

describe('the session step', () => {
	it('records one session step and one notice for the thread, and names the tools by their plain names', async () => {
		const room = open([plainTurn]);
		await run(room.activate());
		const steps = room.steps.filter((step) => step.type === 'session');
		expect(steps).toEqual([
			{
				type: 'session',
				name: 'codex',
				version: '0.159.2',
				model: 'gpt-5.6-luna',
				cwd: expect.any(String),
				session: 'thread-1',
				auth: 'apiKey',
				permissionMode: 'never, readOnly',
				tools: ['say', 'schedule', 'seat', 'unseat', 'dismiss', 'recall'],
				servers: [{ name: 'node_repl', status: 'disabled' }],
			},
		]);
		const notices = room.steps.filter((step) => step.type === 'notice');
		expect(notices).toEqual([
			{
				type: 'notice',
				level: 'info',
				text: 'Codex thread',
				data: { thread: 'thread-1', home: expect.any(String), rollout: expect.any(String) },
			},
		]);
	});
});

describe('steer', () => {
	/** A turn that holds until the test releases it, so a line can land while the turn runs. */
	function held() {
		const release = Promise.withResolvers<void>();
		const turn: FakeTurn = async (ctx) => {
			await release.promise;
			ctx.reply('done');
			return undefined;
		};
		return { turn, release: release.resolve };
	}

	it('sends a line that lands mid turn to turn/steer with the id of the turn, and counts it read on its echo', async () => {
		const { turn, release } = held();
		const room = open([turn]);
		const state = room.activate();
		const passing = state.pass(input());
		await until(() => room.fake.requestsOf('turn/start').length > 0, 'the turn start');
		await until(() => room.steps.some((step) => step.type === 'session'), 'the thread');
		state.steer(1, 2, 'Also name the owner.');
		await until(() => room.fake.requestsOf('turn/steer').length > 0, 'the steer');
		release();
		expect(await passing).toEqual({ failed: false });
		state.close?.();
		const [steer] = room.fake.requestsOf('turn/steer') as {
			expectedTurnId: string;
			clientUserMessageId: string;
			input: { text: string }[];
		}[];
		expect(steer).toMatchObject({
			expectedTurnId: 'turn-1',
			input: [{ type: 'text', text: 'Also name the owner.' }],
		});
		expect(steer?.clientUserMessageId).toEqual(expect.any(String));
		expect(room.steps).toContainEqual({ type: 'steer', seq: 2, consumed: true });
		expect(state.readThrough).toBe(2);
	});

	it('holds a line that lands before turn/start answers, and sends it right after', async () => {
		const { turn, release } = held();
		const room = open([turn]);
		const state = room.activate();
		const passing = state.pass(input());
		// The core calls steer before the body of the pass reaches its first await.
		state.steer(1, 2, 'Early line.');
		expect(room.fake.requestsOf('turn/steer')).toEqual([]);
		await until(() => room.fake.requestsOf('turn/steer').length > 0, 'the held steer');
		const order = room.fake.seen.requests.map((request) => request.method);
		expect(order.indexOf('turn/steer')).toBeGreaterThan(order.indexOf('turn/start'));
		release();
		await passing;
		state.close?.();
		expect(room.steps).toContainEqual({ type: 'steer', seq: 2, consumed: true });
	});

	it('leaves a line for the next delta when Codex answers that no turn is active', async () => {
		const release = Promise.withResolvers<void>();
		const room = open([
			async (ctx) => {
				ctx.reply('done');
				ctx.finish();
				await release.promise;
				return undefined;
			},
		]);
		const state = room.activate();
		const passing = state.pass(input());
		await until(() => room.steps.some((step) => step.type === 'text'), 'the reply');
		state.steer(1, 2, 'Too late.');
		await until(() => room.fake.requestsOf('turn/steer').length > 0, 'the refused steer');
		release.resolve();
		await passing;
		state.close?.();
		expect(room.steps).toContainEqual({ type: 'steer', seq: 2, consumed: false });
		expect(state.readThrough).toBe(1);
	});

	it('does not count a line read when Codex accepts it and sends no echo', async () => {
		const { turn, release } = held();
		const room = open([turn], seat(), undefined, undefined, { echoSteers: false });
		const state = room.activate();
		const passing = state.pass(input());
		await until(() => room.steps.some((step) => step.type === 'session'), 'the thread');
		state.steer(1, 2, 'No echo.');
		await until(() => room.fake.requestsOf('turn/steer').length > 0, 'the steer');
		release();
		await passing;
		state.close?.();
		expect(room.steps).toContainEqual({ type: 'steer', seq: 2, consumed: false });
		expect(state.readThrough).toBe(1);
	});
});

describe('the cut', () => {
	it('sends turn/interrupt with the id of the turn, and ends the pass with no failure', async () => {
		const room = open([
			async (ctx) => {
				ctx.reply('thinking');
				await ctx.interrupted;
				return { status: 'interrupted' };
			},
		]);
		const state = room.activate();
		const passing = state.pass(input());
		await until(() => room.steps.some((step) => step.type === 'text'), 'the reply');
		state.cut();
		expect(await passing).toEqual({ failed: false });
		state.close?.();
		expect(room.fake.requestsOf('turn/interrupt')).toEqual([
			{ threadId: 'thread-1', turnId: 'turn-1' },
		]);
		expect(room.events.filter((event) => event.type === 'error')).toEqual([]);
	});
});

describe('the process', () => {
	it('fails a pass that the process ends as transient, with the exit and the standard error', async () => {
		const room = open([
			(ctx) => {
				ctx.crash('thread panicked at the model client');
				return undefined;
			},
		]);
		const { result } = await run(room.activate());
		expect(result).toMatchObject({ failed: true, cause: 'transient' });
		expect(result.failed && result.message).toContain('exited with code 1');
		expect(result.failed && result.message).toContain('thread panicked at the model client');
	});

	it('closes the connection and fails as transient when the binary cannot start', async () => {
		const room = open([plainTurn], seat(), undefined, undefined, {
			startError: 'could not start: spawn /fake/codex ENOENT',
		});
		const { result } = await run(room.activate());
		expect(result).toMatchObject({ failed: true, cause: 'transient' });
		expect(result.failed && result.message).toContain('could not start');
	});

	it('closes the process when the activation closes', async () => {
		const room = open([plainTurn]);
		await run(room.activate());
		expect(room.fake.seen.closed).toBe(1);
	});
});

describe('native tools', () => {
	it('runs a seat under the exclusive recipe, and removes the scratch on close', async () => {
		const room = open([plainTurn]);
		const session = room.activate();
		const result = await session.pass(input());
		const [launch] = room.fake.seen.launches;
		const flags = launch?.args ?? [];
		const catalog = flags.find((flag) => flag.startsWith('model_catalog_json=')) ?? '';
		const path = JSON.parse(catalog.slice('model_catalog_json='.length)) as string;
		const [start] = room.fake.requestsOf('thread/start') as {
			cwd: string;
			sandbox: string;
			approvalPolicy: string;
		}[];
		expect(result).toEqual({ failed: false });
		expect(flags[0]).toBe('app-server');
		expect(existsSync(path)).toBe(true);
		expect(readdirSync(start?.cwd ?? '')).toEqual([]);
		expect(start).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'never' });
		expect(launch?.cwd).toBe(start?.cwd);
		session.close?.();
		expect(existsSync(path)).toBe(false);
	});

	it('does not start a model that the catalog lacks, and fails as permanent', async () => {
		const room = open([plainTurn], seat({ model: 'gpt-unknown' }));
		const { result } = await run(room.activate());
		expect(result).toMatchObject({ failed: true, cause: 'permanent' });
		expect(result.failed && result.message).toMatch(/gpt-unknown/);
		expect(room.fake.seen.launches).toEqual([]);
		expect(room.events.some((event) => event.type === 'error')).toBe(true);
	});
});
