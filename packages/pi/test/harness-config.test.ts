/**
 * How the executor sets up the Pi harness: the tools the model holds, the
 * system prompt, one attempt for each provider request, compaction and
 * overflow recovery, the size of a tool result, and the open and close of
 * a session.
 */
import { defineAgent, defineTool, type Message, type Step } from '@ambionframework/ambion';
import type { ActivationView } from '@ambionframework/ambion/hosting';
import { describeExecutor } from '@ambionframework/ambion/hosting';
import { callTool, quiet } from '@ambionframework/ambion/testing';
import type { AssistantMessage, Context, SimpleStreamOptions } from '@earendil-works/pi-ai';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import type { ActivationState } from '../../ambion/src/execution/activation.ts';
import { renderActivation } from '../../ambion/src/execution/render.ts';
import { deferred } from '../../ambion/test/support/room.ts';
import { createPiOpener } from '../src/executor.ts';
import {
	type CompactionOptions,
	memorySessions,
	type PiSessions,
	pi,
	type StreamFn,
	stubModel,
	type ThinkingLevel,
} from '../src/index.ts';
import { scriptContext } from '../src/script-context.ts';
import {
	contextText,
	isClosingContext,
	type PiScript,
	scriptedStream,
	toolNames,
} from '../src/testing.ts';
import { stateOf } from './support/activation.ts';
import { failing } from './support/storage.ts';
import { said } from './support/two-questions.ts';

const tool = (name: string) =>
	defineTool({ name, description: name, parameters: Type.Object({}), execute: () => name });

/** A worker with a tool of its own and a bundle, on the compaction options and the thinking level given. */
const workerWith = (compaction?: CompactionOptions, thinking?: ThinkingLevel) =>
	defineAgent({
		name: 'worker',
		identity: 'Works.',
		executor: pi({
			instructions: 'Work.',
			model: 'scripted/worker',
			tools: [tool('book')],
			bundles: [{ tools: [tool('inspect')], guidance: 'Inspect first.' }],
			...(compaction === undefined ? {} : { compaction }),
			...(thinking === undefined ? {} : { thinking }),
		}),
	});

const respond = (messages: Message[], through: number): ActivationView => ({
	spec: {
		id: 'message:1:worker:1',
		seat: 'worker',
		attempt: 1,
		purpose: { kind: 'respond', message: 1 },
	},
	through,
	context: { name: 'setup', now: 0, participants: [], messages, reserve: [] },
});

const closing = (messages: Message[]): ActivationView => ({
	spec: {
		id: 'closed:1:worker:1',
		seat: 'worker',
		attempt: 1,
		purpose: { kind: 'summarize', exchange: 1, person: 'andrei', people: ['andrei'], through: 1 },
		resume: { kind: 'pi', id: 'message:1:worker:1' },
	},
	through: 1,
	context: { name: 'setup', now: 0, participants: [], messages, reserve: [] },
});

/** The requests the stream received, with their options. */
function recording(script: PiScript) {
	const requests: {
		context: Context;
		options: SimpleStreamOptions | undefined;
		model: string;
	}[] = [];
	const base = scriptedStream(script);
	const stream: StreamFn = (model, context, options) => {
		requests.push({ context: scriptContext(context), options, model: model.id });
		return base(model, context, options);
	};
	return { requests, stream };
}

function seat(
	stream: StreamFn,
	compaction?: CompactionOptions,
	thinking?: ThinkingLevel,
	sessions: PiSessions = memorySessions(),
) {
	const definition = workerWith(compaction, thinking);
	const opener = createPiOpener({
		definition,
		model: stubModel,
		stream,
		now: () => 0,
		sessions,
	});
	const open = (id: string, trace: (step: Step) => void = () => {}): ActivationState =>
		stateOf(opener, definition, { id, trace: { record: trace } });
	return { definition, open };
}

/** The request that the harness makes to summarize the session for compaction. */
const summarizing = (context: Context) =>
	context.systemPrompt?.startsWith('You are a context summarization assistant') ?? false;

/** An answer that reports the spend of `input` tokens. */
const spending = (input: number, text = 'nothing to add'): AssistantMessage => {
	const answer = fauxAssistantMessage(text, { stopReason: 'stop' });
	return {
		...answer,
		usage: {
			...answer.usage,
			input,
			totalTokens: input,
			cost: { ...answer.usage.cost, total: input / 1000 },
		},
	};
};

/** The compaction options that make a context of a few tokens pass the threshold. */
const EAGER: CompactionOptions = { enabled: true, reserveTokens: 999_990, keepRecentTokens: 1 };

/** The tool results of one request, as text. */
const results = (context: Context): string[] =>
	context.messages.flatMap((message) =>
		message.role === 'toolResult'
			? [message.content.map((part) => (part.type === 'text' ? part.text : '')).join('')]
			: [],
	);

describe('the harness of an activation', () => {
	it('tries a provider request once, and leaves the retry to the room', async () => {
		const { requests, stream } = recording(() => {
			throw new Error('overloaded 529');
		});
		const session = seat(stream).open('message:1:worker:1');
		expect(await session.pass({ kind: 'view', view: respond([said(1, 'Go.')], 1) })).toEqual({
			failed: true,
			cause: 'transient',
			message: 'Error: overloaded 529',
			error: new Error('Error: overloaded 529'),
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]?.options?.maxRetries).toBe(0);
		// A failed run keeps its session, and the release records it.
		expect(session.session).toEqual({ kind: 'pi', id: 'message:1:worker:1' });
	});

	it('gives the model the room tools and the tools of the definition, and a summary only say', async () => {
		const { requests, stream } = recording(() => quiet());
		const { definition, open } = seat(stream);
		const first = open('message:1:worker:1');
		const view = respond([said(1, 'Go.')], 1);
		await first.pass({ kind: 'view', view });
		first.close?.();
		const summary = closing([said(1, 'Go.')]);
		const last = open('closed:1:worker:1');
		await last.pass({ kind: 'view', view: summary });
		last.close?.();

		const [ordinary, closed] = requests;
		expect(toolNames(ordinary?.context as Context)).toEqual([
			'say',
			'schedule',
			'seat',
			'unseat',
			'dismiss',
			'recall',
			'book',
			'inspect',
		]);
		// The prompt reaches the model as the executor built it: no tag wraps it.
		const rendered = renderActivation(view, definition);
		expect(ordinary?.context.systemPrompt).toBe(`${rendered.mechanism}\n\n${rendered.agent}`);
		// The summary activation continues the session with fewer tools and its own prompt.
		expect(toolNames(closed?.context as Context)).toEqual(['say']);
		expect(isClosingContext(closed?.context as Context)).toBe(true);
		expect(closed?.context.messages.length).toBeGreaterThan(1);
		expect(last.session).toEqual({ kind: 'pi', id: 'message:1:worker:1' });
	});

	it('compacts the session when the context passes the threshold, and never reads back', async () => {
		const { requests, stream } = recording((context) =>
			summarizing(context)
				? fauxAssistantMessage('The pump question is open.', { stopReason: 'stop' })
				: spending(50),
		);
		const session = seat(stream, EAGER).open('message:1:worker:1');
		await session.pass({ kind: 'view', view: respond([said(1, 'Can we ship?')], 1) });
		const both = [said(1, 'Can we ship?'), said(2, 'And the pump?')];
		await session.pass({ kind: 'delta', after: 1, view: respond(both, 2) });
		const both3 = [...both, said(3, 'And the hose?')];
		await session.pass({ kind: 'delta', after: 2, view: respond(both3, 3) });

		expect(requests.some((request) => summarizing(request.context))).toBe(true);
		const answers = requests.filter((request) => !summarizing(request.context));
		expect(answers).toHaveLength(3);
		// The model reads the summary in place of the ranges it replaced, and the last delta whole.
		const last = answers.at(-1)?.context as Context;
		expect(contextText(last)).toContain('The pump question is open.');
		expect(contextText(last)).not.toContain('Can we ship?');
		expect(contextText(last)).toContain('[new] #3 [andrei] And the hose?');
		expect(session.readThrough).toBe(3);
	});

	it('keeps the whole session when compaction is off, whatever the context size', async () => {
		const { requests, stream } = recording(() => spending(50));
		const session = seat(stream, { ...EAGER, enabled: false }).open('message:1:worker:1');
		await session.pass({ kind: 'view', view: respond([said(1, 'Can we ship?')], 1) });
		const both = [said(1, 'Can we ship?'), said(2, 'And the pump?')];
		await session.pass({ kind: 'delta', after: 1, view: respond(both, 2) });
		expect(requests.filter((request) => summarizing(request.context))).toEqual([]);
		expect(contextText(requests.at(-1)?.context as Context)).toContain('Can we ship?');
	});

	it('compacts once and sends the request again when the context overflows the window', async () => {
		const overflow = 'prompt is too long: 213462 tokens > 200000 maximum';
		let overflowed = false;
		const { requests, stream } = recording((context) => {
			if (summarizing(context)) {
				return fauxAssistantMessage('The ship question is open.', { stopReason: 'stop' });
			}
			if (!overflowed && contextText(context).includes('And the pump?')) {
				overflowed = true;
				return fauxAssistantMessage('', { stopReason: 'error', errorMessage: overflow });
			}
			return spending(50);
		});
		// The default policy keeps 20000 tokens, so a session of this size has nothing to compact.
		const session = seat(stream, { keepRecentTokens: 1 }).open('message:1:worker:1');
		await session.pass({ kind: 'view', view: respond([said(1, 'Can we ship?')], 1) });
		const both = [said(1, 'Can we ship?'), said(2, 'And the pump?')];
		expect(await session.pass({ kind: 'delta', after: 1, view: respond(both, 2) })).toEqual({
			failed: false,
		});
		// The first answer, the overflow, the summary, and the request again.
		expect(requests.map((request) => summarizing(request.context))).toEqual([
			false,
			false,
			true,
			false,
		]);
		const again = requests.at(-1)?.context as Context;
		expect(contextText(again)).toContain('The ship question is open.');
		expect(contextText(again)).toContain('[new] #2 [andrei] And the pump?');
		expect(session.readThrough).toBe(2);
	});

	it('fails a pass that overflows the window when compaction is off', async () => {
		const overflow = 'prompt is too long: 213462 tokens > 200000 maximum';
		const { requests, stream } = recording(() =>
			fauxAssistantMessage('', { stopReason: 'error', errorMessage: overflow }),
		);
		const session = seat(stream, { enabled: false, keepRecentTokens: 1 }).open(
			'message:1:worker:1',
		);
		const result = await session.pass({ kind: 'view', view: respond([said(1, 'Go.')], 1) });
		expect(result).toMatchObject({ failed: true });
		expect(requests).toHaveLength(1);
	});

	it('adds the spend of a compaction to the activation', async () => {
		const steps: Step[] = [];
		const { stream } = recording((context) =>
			summarizing(context) ? spending(7, 'The pump question is open.') : spending(50),
		);
		const session = seat(stream, EAGER).open('message:1:worker:1', (step) => steps.push(step));
		await session.pass({ kind: 'view', view: respond([said(1, 'Can we ship?')], 1) });
		const both = [said(1, 'Can we ship?'), said(2, 'And the pump?')];
		await session.pass({ kind: 'delta', after: 1, view: respond(both, 2) });
		const input = steps.reduce((sum, step) => sum + (step.type === 'usage' ? step.input : 0), 0);
		const cost = steps.reduce(
			(sum, step) => sum + (step.type === 'usage' ? (step.cost ?? 0) : 0),
			0,
		);
		// Two answers of 50, and one summary of 7: the summary has no entry in the session.
		expect(input).toBe(107);
		expect(cost).toBeCloseTo(0.107);
	});

	it('sends a tool result of any size to the model whole', async () => {
		const many = Array.from({ length: 5000 }, (_, index) => `line ${index}`).join('\n');
		const wide = 'x'.repeat(200_000);
		const dump = defineTool({
			name: 'dump',
			description: 'Give a large result.',
			parameters: Type.Object({ shape: Type.String() }),
			execute: ({ shape }) => (shape === 'lines' ? many : wide),
		});
		const definition = defineAgent({
			name: 'worker',
			identity: 'Works.',
			executor: pi({ instructions: 'Work.', model: 'scripted/worker', tools: [dump] }),
		});
		const { requests, stream } = recording((context, _agent, request) => {
			if (request === 1) return callTool('dump', { shape: 'lines' });
			return request === 2 && results(context).length === 1
				? callTool('dump', { shape: 'wide' })
				: quiet();
		});
		const opener = createPiOpener({
			definition,
			model: stubModel,
			stream,
			now: () => 0,
			sessions: memorySessions(),
		});
		await stateOf(opener, definition).pass({ kind: 'view', view: respond([said(1, 'Go.')], 1) });
		const [, one, two] = requests;
		expect(results(one?.context as Context)).toEqual([many]);
		expect(results(two?.context as Context)).toEqual([many, wide]);
	});

	it.each([
		['no level', undefined, undefined],
		['the level of the definition', 'medium', 'medium'],
	] as const)('sends %s of thinking to the provider', async (_name, thinking, reasoning) => {
		const { requests, stream } = recording(() => quiet());
		const session = seat(stream, undefined, thinking).open('message:1:worker:1');
		await session.pass({ kind: 'view', view: respond([said(1, 'Go.')], 1) });
		expect(requests[0]?.options?.reasoning).toBe(reasoning);
		expect(workerWith(undefined, thinking).executor).toEqual(
			thinking === undefined
				? expect.not.objectContaining({ thinking: expect.anything() })
				: expect.objectContaining({ thinking }),
		);
	});

	it('refuses a thinking level that Pi does not name', () => {
		expect(() => workerWith(undefined, 'huge' as ThinkingLevel)).toThrow(
			'Thinking must be one of off, minimal, low, medium, high, xhigh, max.',
		);
	});

	it('writes compaction on the executor only when the definition gives it', () => {
		expect(workerWith().executor).not.toHaveProperty('compaction');
		const options = { enabled: false, reserveTokens: 1, keepRecentTokens: 2, backgroundTokens: 3 };
		expect(workerWith(options).executor).toMatchObject({ compaction: options });
		// A field that is absent keeps the default of pi-durable.
		expect(workerWith({ enabled: false }).executor).toMatchObject({
			compaction: { enabled: false },
		});
	});

	it.each([
		['a negative reserve', { reserveTokens: -1 }],
		['a fractional recent count', { keepRecentTokens: 0.5 }],
		['a negative background count', { backgroundTokens: -2 }],
	])('refuses compaction options with %s when the agent is defined', (_name, options) => {
		expect(() => workerWith(options)).toThrow(
			'Compaction token counts must be non-negative safe integers.',
		);
	});

	it('refuses a compaction switch that is no boolean when the agent is defined', () => {
		expect(() => workerWith({ enabled: 'yes' as unknown as boolean })).toThrow(
			'Compaction `enabled` must be a boolean.',
		);
	});

	it('closes the storage and fails as transient when the harness cannot open it', async () => {
		let closed = 0;
		const store = memorySessions();
		const sessions: PiSessions = {
			create: async (scope, id) => {
				const created = await store.create(scope, id);
				const storage = failing(created.storage, ['commit'], () => true);
				return {
					...created,
					storage: new Proxy(storage, {
						get: (target, key) =>
							key === 'close'
								? async () => {
										closed += 1;
									}
								: Reflect.get(target, key),
					}),
				};
			},
			open: (scope, id) => store.open(scope, id),
		};
		const { requests, stream } = recording(() => quiet());
		const session = seat(stream, undefined, undefined, sessions).open('message:1:worker:1');
		const result = await session.pass({ kind: 'view', view: respond([said(1, 'Go.')], 1) });
		expect(result).toMatchObject({ failed: true, cause: 'transient' });
		expect(requests).toHaveLength(0);
		expect(closed).toBeGreaterThan(0);
		expect(session.session).toBeUndefined();
	});

	it.each([
		[
			'a view of another seat',
			workerWith(),
			{ ...respond([said(1, 'Go.')], 1).spec, seat: 'other' },
			"Activation names another seat: 'other'.",
		],
		[
			'an executor of another kind',
			defineAgent({
				name: 'worker',
				identity: 'Works.',
				executor: describeExecutor({ kind: 'other', instructions: '' }),
			}),
			respond([said(1, 'Go.')], 1).spec,
			"The Pi executor cannot run an executor of kind 'other'.",
		],
	])('fails a pass over %s as transient', async (_name, definition, spec, message) => {
		const opener = createPiOpener({
			definition,
			model: stubModel,
			stream: scriptedStream(() => quiet()),
			now: () => 0,
			sessions: memorySessions(),
		});
		const session = stateOf(opener, definition);
		const view = { ...respond([said(1, 'Go.')], 1), spec };
		expect(await session.pass({ kind: 'view', view })).toMatchObject({
			failed: true,
			cause: 'transient',
			message,
		});
	});

	it('runs a continued session on the model of the activation that continues it', async () => {
		const { requests, stream } = recording(() => quiet());
		const sessions = memorySessions();
		const on = (model: string) => {
			const definition = defineAgent({
				name: 'worker',
				identity: 'Works.',
				executor: pi({ instructions: 'Work.', model }),
			});
			const opener = createPiOpener({
				definition,
				model: stubModel,
				stream,
				now: () => 0,
				sessions,
			});
			return stateOf(opener, definition);
		};
		const first = on('scripted/first');
		await first.pass({ kind: 'view', view: respond([said(1, 'Go.')], 1) });
		first.close?.();
		const second = on('scripted/second');
		const view = respond([said(1, 'Go.'), said(2, 'Again.')], 2);
		await second.pass({
			kind: 'view',
			view: {
				...view,
				spec: { ...view.spec, resume: { kind: 'pi', id: 'message:1:worker:1' } },
			},
		});
		expect(requests.map((request) => request.model)).toEqual(['scripted/first', 'scripted/second']);
		expect(second.session).toEqual({ kind: 'pi', id: 'message:1:worker:1' });
	});

	it('closes a session that opens after the activation closed, and runs nothing', async () => {
		const { requests, stream } = recording(() => quiet());
		const store = memorySessions();
		const opening = deferred();
		const created = deferred();
		const sessions: PiSessions = {
			create: async (scope, id) => {
				created.resolve();
				await opening.promise;
				return store.create(scope, id);
			},
			open: (scope, id) => store.open(scope, id),
		};
		const definition = workerWith();
		const opener = createPiOpener({
			definition,
			model: stubModel,
			stream,
			now: () => 0,
			sessions,
		});
		const session = stateOf(opener, definition);
		const running = session.pass({ kind: 'view', view: respond([said(1, 'Go.')], 1) });
		await created.promise;
		session.close?.();
		opening.resolve();
		expect(await running).toEqual({ failed: false });
		expect(requests).toHaveLength(0);
		// The next activation of the seat waits for the close, then continues the session.
		const next = stateOf(opener, definition, { id: 'message:2:worker:1' });
		const view = respond([said(1, 'Go.')], 1);
		await next.pass({
			kind: 'view',
			view: {
				...view,
				spec: { ...view.spec, resume: { kind: 'pi', id: 'message:1:worker:1' } },
			},
		});
		expect(next.session).toEqual({ kind: 'pi', id: 'message:1:worker:1' });
		expect(requests).toHaveLength(1);
	});

	it('drops a steer that races the close of its activation', async () => {
		const started = deferred();
		const { stream } = recording(async () => {
			started.resolve();
			await new Promise(() => {});
			return quiet();
		});
		const session = seat(stream).open('message:1:worker:1');
		const running = session.pass({ kind: 'view', view: respond([said(1, 'Go.')], 1) });
		await started.promise;
		session.steer?.(1, 2, '[new] [priya] Late.');
		session.close?.();
		expect(await running).toEqual({ failed: false });
	});

	it('aborts a running tool with the signal when the activation is cut', async () => {
		const running = deferred();
		const aborted: boolean[] = [];
		const slow = defineAgent({
			name: 'worker',
			identity: 'Works.',
			executor: pi({
				instructions: 'Work.',
				model: 'scripted/worker',
				tools: [
					defineTool({
						name: 'wait',
						description: 'Wait for the cut.',
						parameters: Type.Object({}),
						execute: async (_params, context) => {
							running.resolve();
							await new Promise<void>((resolve) =>
								context.signal?.addEventListener('abort', () => resolve(), { once: true }),
							);
							aborted.push(context.signal?.aborted === true);
							throw new Error('cut');
						},
					}),
				],
			}),
		});
		const { stream } = recording(() => callTool('wait', {}));
		const opener = createPiOpener({
			definition: slow,
			model: stubModel,
			stream,
			now: () => 0,
			sessions: memorySessions(),
		});
		const session = stateOf(opener, slow, { id: 'message:1:worker:1' });
		const pass = session.pass({ kind: 'view', view: respond([said(1, 'Go.')], 1) });
		await running.promise;
		session.cut();
		expect(await pass).toEqual({ failed: false });
		expect(aborted).toEqual([true]);
	});
});
