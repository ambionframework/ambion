/**
 * One Pi harness serves every pass of an activation. The first pass hands
 * the model the whole view. A later pass hands it the delta: the messages
 * that landed beyond `readThrough`. A line steered into a run counts as
 * consumed when a provider request holds it, and a line that reaches no
 * request waits for the record.
 */
import type { Message, Step } from '@ambionframework/ambion';
import type {
	ActivationView,
	CommitRequest,
	CommitResult,
	Executor,
	ExecutorSession,
} from '@ambionframework/ambion/hosting';
import { callTool, quiet } from '@ambionframework/ambion/testing';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { type Context, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import type { ActivationState } from '../../ambion/src/execution/activation.ts';
import { deferred, scriptedAgent } from '../../ambion/test/support/room.ts';
import { createPiExecutor } from '../src/executor.ts';
import { memorySessions, stubModel } from '../src/index.ts';
import { scriptContext } from '../src/script-context.ts';
import { contextText, type PiScript, scripted } from '../src/testing.ts';
import { roomThatCommits, stateOf, unusedRoom } from './support/activation.ts';

const said = (seq: number, text: string): Message => ({
	kind: 'said',
	seq,
	at: '2026-01-01T09:00:00.000Z',
	from: 'andrei',
	text,
});

const first = [said(1, 'Can we ship?')];
const both = [...first, said(2, 'And the pump?')];

/** The view of an activation of `worker` over `messages`, through `through`. */
function viewOf(
	messages: Message[],
	through: number,
	purpose: ActivationView['spec']['purpose'] = { kind: 'respond', message: 1 },
): ActivationView {
	return {
		spec: { id: 'message:1:worker:1', seat: 'worker', attempt: 1, purpose },
		through,
		context: { name: 'passes', now: 0, participants: [], messages, reserve: [] },
	};
}

/** One activation of `worker` on a script, with the requests it made and the steps it recorded. */
function activation(
	script: PiScript,
	answer?: (request: CommitRequest) => CommitResult,
	watch: (step: Step) => void = () => {},
) {
	const requests: { context: Context; session: string | undefined }[] = [];
	const steps: Step[] = [];
	const base = scripted(script);
	const stream: StreamFn = (model, context, options) => {
		requests.push({
			context: scriptContext(context),
			session: options?.sessionId,
		});
		return base(model, context, options);
	};
	const definition = scriptedAgent('worker');
	const piExecutor = createPiExecutor({
		definition,
		model: stubModel,
		stream,
		now: () => 0,
		sessions: memorySessions(),
	});
	const sessions: ExecutorSession[] = [];
	const executor: Executor = (opened) => {
		const one = piExecutor(opened);
		sessions.push(one);
		return one;
	};
	const raw = (): ExecutorSession => {
		const one = sessions[0];
		if (one === undefined) throw new Error('The core opened no session.');
		return one;
	};
	const commits: CommitRequest[] = [];
	const session = stateOf(executor, definition, {
		room: answer === undefined ? unusedRoom : roomThatCommits(commits, answer),
		trace: {
			record: (step) => {
				steps.push(step);
				watch(step);
			},
		},
	});
	const steers = () => steps.filter((step) => step.type === 'steer');
	return { session, requests, steps, steers, commits, raw };
}

const texts = (context: Context) =>
	context.messages.map((message) => contextText({ ...context, messages: [message] }));

describe('the Pi executor across the passes of one activation', () => {
	it('keeps one session, prompts a later pass with the delta alone, and advances readThrough', async () => {
		const { session, requests } = activation(() => quiet());
		await session.pass({ kind: 'view', view: viewOf(first, 1) });
		expect(session.readThrough).toBe(1);
		await session.pass({ kind: 'delta', since: 1, view: viewOf(both, 2) });

		expect(requests).toHaveLength(2);
		const [before, after] = requests;
		expect(before?.context.messages).toHaveLength(1);
		// The second request carries the first pass whole, then only what is new.
		expect(after?.context.messages).toHaveLength(3);
		const prompts = texts(after?.context as Context);
		expect(prompts[0]).toContain("The record of 'passes' so far:");
		expect(prompts.at(-1)).toBe('[new] #2 [andrei] And the pump?');
		expect(after?.session).toBe(before?.session);
		expect(session.session).toEqual({ harness: 'pi', id: 'message:1:worker:1' });
		expect(session.readThrough).toBe(2);
	});

	it('starts no run when the record moved and no message came with it', async () => {
		const { session, requests } = activation(() => quiet());
		await session.pass({ kind: 'view', view: viewOf(first, 1) });
		expect(await session.pass({ kind: 'delta', since: 1, view: viewOf(first, 2) })).toEqual({
			failed: false,
		});
		expect(requests).toHaveLength(1);
		expect(session.readThrough).toBe(2);
	});

	it('steers a line into a tool turn, and counts it when the next request holds it', async () => {
		const gate = deferred();
		const started = deferred();
		const seen: number[] = [];
		const { session, requests, steers } = activation(async (_context, _agent, call) => {
			seen.push(steers().length);
			if (call === 1) {
				started.resolve();
				await gate.promise;
				return callTool('look', {});
			}
			return quiet();
		});
		const running = session.pass({ kind: 'view', view: viewOf(first, 1) });
		await started.promise;
		session.steer?.(1, 2, '[priya] And the pump?');
		gate.resolve();
		expect(await running).toEqual({ failed: false });

		// The first request never held the line, and the second did.
		expect(seen).toEqual([0, 1]);
		expect(steers()).toEqual([{ type: 'steer', seq: 2, consumed: true }]);
		expect(texts(requests[1]?.context as Context).at(-1)).toBe('[new] [priya] And the pump?');
		expect(session.readThrough).toBe(2);
		expect(session.shouldRefresh(2)).toBe(false);
	});

	it('takes no line that lands outside a run, and the next delta carries it', async () => {
		const { session, requests, raw } = activation(() => quiet());
		await session.pass({ kind: 'view', view: viewOf(first, 1) });
		// The core never steers outside a pass. The executor still queues nothing then.
		raw().steer?.(1, 2, '[priya] Late.');
		await session.pass({ kind: 'delta', since: 1, view: viewOf(both, 2) });
		expect(requests).toHaveLength(2);
		const prompts = texts(requests[1]?.context as Context);
		expect(prompts.filter((text) => text.includes('Late'))).toEqual([]);
		expect(prompts.at(-1)).toBe('[new] #2 [andrei] And the pump?');
	});

	it('takes a line that lands before the lane runs into the prompt', async () => {
		const ready = deferred();
		const resolving = deferred();
		const definition = scriptedAgent('worker');
		const executor = createPiExecutor({
			definition,
			model: async (id, agent) => {
				resolving.resolve();
				await ready.promise;
				return stubModel(id, agent);
			},
			stream: scripted(() => quiet()),
			now: () => 0,
			sessions: memorySessions(),
		});
		const steps: Step[] = [];
		const session = stateOf(executor, definition, {
			trace: {
				record: (step) => void steps.push(step),
			},
		});
		const running = session.pass({ kind: 'view', view: viewOf(both, 2) });
		await resolving.promise;
		session.steer?.(2, 3, '[priya] And the hose?');
		ready.resolve();
		await running;
		expect(steps.filter((step) => step.type === 'steer')).toEqual([
			{ type: 'steer', seq: 3, consumed: true },
		]);
		expect(session.readThrough).toBe(3);
	});

	it('takes a line that lands as the last answer ends into one more request', async () => {
		let landed = false;
		let session: ActivationState | undefined;
		const run = activation(
			() => quiet(),
			undefined,
			(step) => {
				// The line lands as the last answer of the run ends.
				if (step.type === 'text' && step.final && !landed) {
					landed = true;
					session?.steer?.(1, 2, '[priya] And the pump?');
				}
			},
		);
		session = run.session;
		expect(await session.pass({ kind: 'view', view: viewOf(first, 1) })).toEqual({ failed: false });
		expect(run.requests).toHaveLength(2);
		expect(run.steers()).toEqual([{ type: 'steer', seq: 2, consumed: true }]);
		expect(session.readThrough).toBe(2);
	});

	it('leaves a steer to the record when the run is cut', async () => {
		const started = deferred();
		const { session, steers } = activation(async () => {
			started.resolve();
			await new Promise(() => {});
			return quiet();
		});
		const running = session.pass({ kind: 'view', view: viewOf(first, 1) });
		await started.promise;
		session.steer?.(1, 2, '[priya] And the pump?');
		session.cancel();
		expect(await running).toEqual({ failed: false });
		expect(steers()).toEqual([{ type: 'steer', seq: 2, consumed: false }]);
		expect(session.cancelled).toBe(true);
	});

	it('drops a line held while the model resolves when the activation is cut', async () => {
		const ready = deferred();
		const resolving = deferred();
		const steps: Step[] = [];
		const definition = scriptedAgent('worker');
		const executor = createPiExecutor({
			definition,
			model: async (id, agent) => {
				resolving.resolve();
				await ready.promise;
				return stubModel(id, agent);
			},
			stream: scripted(() => quiet()),
			now: () => 0,
			sessions: memorySessions(),
		});
		const session = stateOf(executor, definition, {
			trace: {
				record: (step) => void steps.push(step),
			},
		});
		const running = session.pass({ kind: 'view', view: viewOf(first, 1) });
		await resolving.promise;
		session.steer?.(1, 2, '[priya] And the pump?');
		session.cancel();
		ready.resolve();
		expect(await running).toEqual({ failed: false });
		expect(steps).toEqual([{ type: 'steer', seq: 2, consumed: false }]);
		expect(session.session).toBeUndefined();
	});

	it('ends a pass that stopped at a length limit', async () => {
		// The model spent its whole output limit. A shorter length stop is an overflow the harness compacts.
		const { session } = activation(() => {
			const cut = fauxAssistantMessage('Cut', { stopReason: 'length' });
			return { ...cut, usage: { ...cut.usage, output: 64_000, totalTokens: 64_000 } };
		});
		expect(await session.pass({ kind: 'view', view: viewOf(first, 1) })).toEqual({
			failed: false,
			stop: 'length',
		});
	});
});
