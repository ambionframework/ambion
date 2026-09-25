/**
 * How the executor sets up the Pi harness: the tools the model holds, the
 * system prompt, one attempt for each provider request, and compaction.
 */
import { defineAgent, defineTool, type Message } from '@ambionframework/ambion';
import type { ActivationView, ExecutorSession } from '@ambionframework/ambion/hosting';
import { describeExecutor, renderActivation } from '@ambionframework/ambion/hosting';
import {
	type AgentMessage,
	BACKGROUND_CONTEXT,
	type CompactionSettings,
	convertToLlm,
	DEFAULT_COMPACTION_SETTINGS,
	type HarnessEvent,
	MemorySessionRepo,
	type StreamFn,
	type ThinkingLevel,
} from '@earendil-works/pi-agent-core';
import type { Context, SimpleStreamOptions } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import { deferred } from '../../ambion/test/support/room.ts';
import { noTrace } from '../../ambion/test/support/trace.ts';
import { openHarness } from '../src/harness.ts';
import { createPiExecutor, memorySessions, type PiSessions, pi, stubModel } from '../src/index.ts';
import { streamModels } from '../src/models.ts';
import { contextText, isClosing, quiet, type Script, scripted } from '../src/testing.ts';
import { unusedRoom } from './support/activation.ts';

const said = (seq: number, text: string): Message => ({
	kind: 'said',
	seq,
	at: '2026-01-01T09:00:00.000Z',
	from: 'andrei',
	text,
});

const tool = (name: string) =>
	defineTool({ name, description: name, parameters: Type.Object({}), execute: () => name });

/** A worker with a tool of its own and a bundle, on the compaction settings and the thinking level given. */
const workerWith = (compaction?: CompactionSettings, thinking?: ThinkingLevel) =>
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
		resume: { harness: 'pi', id: 'message:1:worker:1' },
	},
	through: 1,
	context: { name: 'setup', now: 0, participants: [], messages, reserve: [] },
});

/** The requests the stream received, with their options. */
function recording(script: Script) {
	const requests: {
		context: Context;
		options: SimpleStreamOptions | undefined;
		model: string;
	}[] = [];
	const base = scripted(script);
	const stream: StreamFn = (model, context, options) => {
		requests.push({
			context: { ...context, messages: [...context.messages] },
			options,
			model: model.id,
		});
		return base(model, context, options);
	};
	return { requests, stream };
}

function seat(stream: StreamFn, compaction?: CompactionSettings, thinking?: ThinkingLevel) {
	const definition = workerWith(compaction, thinking);
	const executor = createPiExecutor({ definition, model: stubModel, stream, now: () => 0 });
	const open = (id: string): ExecutorSession =>
		executor.open({ id, room: unusedRoom, emit: () => {}, trace: noTrace });
	return { definition, open };
}

const names = (context: Context) => (context.tools ?? []).map((one) => one.name);

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
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]?.options?.maxRetries).toBe(0);
		// A failed run keeps its session, and the release records it.
		expect(session.session).toEqual({ harness: 'pi', id: 'message:1:worker:1' });
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
		expect(names(ordinary?.context as Context)).toEqual([
			'say',
			'seat',
			'unseat',
			'book',
			'inspect',
		]);
		const rendered = renderActivation(view, definition);
		expect(ordinary?.context.systemPrompt).toBe(`${rendered.mechanism}\n\n${rendered.agent}`);
		// The closing activation continues the session with fewer tools and its own prompt.
		expect(names(closed?.context as Context)).toEqual(['say']);
		expect(isClosing(closed?.context as Context)).toBe(true);
		expect(closed?.context.messages.length).toBeGreaterThan(1);
		expect(last.session).toEqual({ harness: 'pi', id: 'message:1:worker:1' });
	});

	it('compacts the session when the context passes the threshold, and never reads back', async () => {
		const summarizing = (context: Context) =>
			context.systemPrompt?.startsWith('You are a context summarization assistant') ?? false;
		const { requests, stream } = recording((context) => {
			if (summarizing(context)) return quiet('The pump question is open.');
			const answer = quiet();
			return { ...answer, usage: { ...answer.usage, input: 50, totalTokens: 50 } };
		});
		const session = seat(stream, {
			enabled: true,
			reserveTokens: 999_990,
			keepRecentTokens: 1,
		}).open('message:1:worker:1');
		await session.pass({ kind: 'view', view: respond([said(1, 'Can we ship?')], 1) });
		const both = [said(1, 'Can we ship?'), said(2, 'And the pump?')];
		await session.pass({ kind: 'delta', since: 1, view: respond(both, 2) });
		const both3 = [...both, said(3, 'And the hose?')];
		await session.pass({ kind: 'delta', since: 2, view: respond(both3, 3) });

		expect(requests.some((request) => summarizing(request.context))).toBe(true);
		const answers = requests.filter((request) => !summarizing(request.context));
		expect(answers).toHaveLength(3);
		// The model reads the summary in place of the ranges it replaced, and the last delta whole.
		const last = answers.at(-1)?.context as Context;
		expect(contextText(last)).toContain('The pump question is open.');
		expect(contextText(last)).not.toContain('Can we ship?');
		expect(contextText(last)).toContain('[new] [andrei] And the hose?');
		expect(session.readThrough).toBe(3);
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
		const settings = { enabled: false, reserveTokens: 1, keepRecentTokens: 2 };
		expect(workerWith(settings).executor).toMatchObject({ compaction: settings });
	});

	it.each([
		['a negative reserve', { enabled: true, reserveTokens: -1, keepRecentTokens: 2 }],
		['a fractional recent count', { enabled: true, reserveTokens: 1, keepRecentTokens: 0.5 }],
	])('refuses compaction settings with %s when the agent is defined', (_name, settings) => {
		expect(() => workerWith(settings)).toThrow(
			'Compaction token counts must be non-negative safe integers.',
		);
	});

	it.each([
		['the settings it is given', { enabled: false, reserveTokens: 1, keepRecentTokens: 2 }],
		["Pi's defaults", DEFAULT_COMPACTION_SETTINGS],
	] as const)('sets the harness up with %s, and with retries off', async (_name, settings) => {
		const repo = new MemorySessionRepo();
		const model = await stubModel('scripted/worker', 'worker');
		const { harness } = await openHarness({
			session: await repo.create({}, BACKGROUND_CONTEXT),
			models: streamModels(
				model,
				scripted(() => quiet()),
			),
			model,
			tools: [],
			systemPrompt: () => '',
			compaction: settings,
			thinking: 'off',
			toProviderMessages: () => [],
			onEvent: () => {},
		});
		expect(await harness.getCompactionSettings(BACKGROUND_CONTEXT)).toEqual(settings);
		expect(await harness.getRetryPolicy(BACKGROUND_CONTEXT)).toMatchObject({ enabled: false });
		expect(await harness.getStreamOptions(BACKGROUND_CONTEXT)).toEqual({ maxRetries: 0 });
		await harness.close(BACKGROUND_CONTEXT);
	});

	it('closes the harness and its session when the lane cannot be set up', async () => {
		const repo = new MemorySessionRepo();
		const session = await repo.create({}, BACKGROUND_CONTEXT);
		const model = await stubModel('scripted/worker', 'worker');
		// The harness restores the session, and then the session refuses every write.
		let writes = 0;
		const refusing = new Proxy(session, {
			get: (target, key, receiver) => {
				const value = Reflect.get(target, key, receiver);
				if (key !== 'mutate' || ++writes === 1) return value;
				return () => Promise.reject(new Error('The disk is full.'));
			},
		});
		await expect(
			openHarness({
				session: refusing,
				models: streamModels(
					model,
					scripted(() => quiet()),
				),
				model,
				tools: [],
				systemPrompt: () => '',
				compaction: DEFAULT_COMPACTION_SETTINGS,
				thinking: 'off',
				toProviderMessages: () => [],
				onEvent: () => {},
			}),
		).rejects.toThrow();
		// A closed session opens again.
		await expect(repo.open(session.metadata, BACKGROUND_CONTEXT)).resolves.toBeDefined();
	});

	it.each([
		[
			'a view of another seat',
			workerWith(),
			{ ...respond([said(1, 'Go.')], 1).spec, seat: 'other' },
			"Activation names another seat: 'other'.",
		],
		[
			'an executor of another family',
			defineAgent({
				name: 'worker',
				identity: 'Works.',
				executor: describeExecutor({ kind: 'other', instructions: '' }),
			}),
			respond([said(1, 'Go.')], 1).spec,
			"The Pi executor cannot run an executor of kind 'other'.",
		],
	])('fails a pass over %s as transient', async (_name, definition, spec, message) => {
		const executor = createPiExecutor({
			definition,
			model: stubModel,
			stream: scripted(() => quiet()),
			now: () => 0,
		});
		const session = executor.open({
			id: 'message:1:worker:1',
			room: unusedRoom,
			emit: () => {},
			trace: noTrace,
		});
		const view = { ...respond([said(1, 'Go.')], 1), spec };
		expect(await session.pass({ kind: 'view', view })).toEqual({
			failed: true,
			cause: 'transient',
			message,
		});
	});

	it('runs a continued session on the model of the activation that continues it', async () => {
		const { requests, stream } = recording(() => quiet());
		const sessions = memorySessions();
		const on = (model: string) =>
			createPiExecutor({
				definition: defineAgent({
					name: 'worker',
					identity: 'Works.',
					executor: pi({ instructions: 'Work.', model }),
				}),
				model: stubModel,
				stream,
				now: () => 0,
				sessions,
			}).open({ id: 'message:1:worker:1', room: unusedRoom, emit: () => {}, trace: noTrace });
		const first = on('scripted/first');
		await first.pass({ kind: 'view', view: respond([said(1, 'Go.')], 1) });
		first.close?.();
		const second = on('scripted/second');
		const view = respond([said(1, 'Go.'), said(2, 'Again.')], 2);
		await second.pass({
			kind: 'view',
			view: {
				...view,
				spec: { ...view.spec, resume: { harness: 'pi', id: 'message:1:worker:1' } },
			},
		});
		expect(requests.map((request) => request.model)).toEqual(['scripted/first', 'scripted/second']);
		expect(second.session).toEqual({ harness: 'pi', id: 'message:1:worker:1' });
	});

	it('closes a session that opens after the activation closed, and runs nothing', async () => {
		const { requests, stream } = recording(() => quiet());
		const store = memorySessions();
		const opening = deferred();
		const created = deferred();
		const sessions: PiSessions = {
			create: async (scope, id, context) => {
				created.resolve();
				await opening.promise;
				return store.create(scope, id, context);
			},
			open: (scope, id, context) => store.open(scope, id, context),
		};
		const executor = createPiExecutor({
			definition: workerWith(),
			model: stubModel,
			stream,
			now: () => 0,
			sessions,
		});
		const session = executor.open({
			id: 'message:1:worker:1',
			room: unusedRoom,
			emit: () => {},
			trace: noTrace,
		});
		const running = session.pass({ kind: 'view', view: respond([said(1, 'Go.')], 1) });
		await created.promise;
		session.close?.();
		opening.resolve();
		expect(await running).toEqual({ failed: false });
		expect(requests).toHaveLength(0);
		// The next activation of the seat waits for the close, then continues the session.
		const next = executor.open({
			id: 'message:2:worker:1',
			room: unusedRoom,
			emit: () => {},
			trace: noTrace,
		});
		const view = respond([said(1, 'Go.')], 1);
		await next.pass({
			kind: 'view',
			view: {
				...view,
				spec: { ...view.spec, resume: { harness: 'pi', id: 'message:1:worker:1' } },
			},
		});
		expect(next.session).toEqual({ harness: 'pi', id: 'message:1:worker:1' });
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
		session.steer?.(1, 2, '[priya] Late.');
		session.close?.();
		expect(await running).toEqual({ failed: false });
	});

	it('cuts a run that a lost process left open before the lane takes a new one', async () => {
		const session = await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT);
		const model = await stubModel('scripted/worker', 'worker');
		const started = deferred();
		const setup = (stream: StreamFn, onEvent: (event: HarnessEvent) => void = () => {}) => ({
			session,
			models: streamModels(model, stream),
			model,
			tools: [],
			systemPrompt: () => '',
			compaction: DEFAULT_COMPACTION_SETTINGS,
			thinking: 'off' as const,
			toProviderMessages: (messages: AgentMessage[]) => convertToLlm(messages),
			onEvent,
		});
		// The lost run streams part of its answer, and then the process is gone.
		const partial: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			const message = fauxAssistantMessage('partial words', { stopReason: 'stop' });
			stream.push({ type: 'start', partial: message });
			stream.push({ type: 'text_start', contentIndex: 0, partial: message });
			stream.push({
				type: 'text_delta',
				contentIndex: 0,
				delta: 'partial words',
				partial: message,
			});
			started.resolve();
			return stream;
		};
		const lost = await openHarness(setup(partial));
		void lost.lane.prompt('Go.', undefined, BACKGROUND_CONTEXT);
		await started.promise;
		// A second harness on the same session: the process that ran the first is gone.
		const events: HarnessEvent[] = [];
		const next = await openHarness(
			setup(
				scripted(() => quiet()),
				(event) => events.push(event),
			),
		);
		expect((await next.lane.inspectExecution(BACKGROUND_CONTEXT)).current).toBeNull();
		// No event of the lost run reaches the activation that cut it.
		expect(events).toEqual([]);
		const result = await next.lane.prompt('Again.', undefined, BACKGROUND_CONTEXT);
		expect(result.ok && result.value.status).toBe('completed');
		expect(events.some((event) => 'recovery' in event && event.recovery === true)).toBe(false);
	});
});
