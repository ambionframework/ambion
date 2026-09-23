import { type JournalOpener, memoryJournals } from '@ambionframework/journal';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxThinking,
	fauxToolCall,
} from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import { createExecutionServices, createPiExecutor, pi, piExecution } from '../../pi/src/index.ts';
import { loggedToolResult, openTrace, traceOpener } from '../src/execution/trace.ts';
import {
	AgentRunner,
	type CommitResult,
	hostingOf,
	type LeaseRequest,
	type LeaseResponse,
	type RoomProtocol,
	type ViewResponse,
} from '../src/hosting.ts';
import type {
	AgentDefinition,
	CreateRuntimeOptions,
	ExecutionEvent,
	Runtime,
	TraceStep,
} from '../src/index.ts';
import {
	createRuntime,
	defineAgent,
	defineTool,
	readActivation,
	readRoom,
	startRoom,
	type TracePolicy,
} from '../src/index.ts';
import { assertWire, roundTrip } from '../src/protocol.ts';
import { fakeClock } from '../src/testing.ts';
import { andrei, collect, deferred, roomName, tick, waitForRoom } from './support/room.ts';
import { quiet, scripted, speak } from './support/scripted.ts';
import { stopAtEnd } from './support/stop.ts';
import { traceOf } from './support/trace.ts';

const product = defineAgent({
	name: 'product',
	identity: 'Answers questions.',
	executor: pi({ instructions: 'Answer.', model: 'scripted/product' }),
});

const sorted = (steps: readonly TraceStep[]) => steps.map((step) => step.type);

/** Ask one question in a room that runs `stream`, and read the trace of its one activation. */
async function traced(stream: StreamFn, options: CreateRuntimeOptions = {}, agent = product) {
	const runtime = createRuntime(options);
	const name = roomName('trace');
	const room = stopAtEnd(
		await startRoom({ name, agents: [agent], runtime, execution: piExecution({ stream }) }),
	);
	const events = collect(room);
	await (await room.visit(andrei)).send({ text: 'Ready?' });
	await waitForRoom(room, 'quiet', 2_000);
	const started = events.find((event) => event.type === 'activation_start');
	if (started?.type !== 'activation_start') throw new Error('No activation started.');
	const id = started.activation;
	return { room, name, events, id, steps: await traceOf(runtime, name, id) };
}

/** A stream that thinks, then calls `tool`, then stops. */
const thinksThenCalls = (thinking: string, tool: string, input: Record<string, unknown> = {}) =>
	scripted((_context, _agent, call) =>
		call === 1
			? fauxAssistantMessage([fauxThinking(thinking), fauxToolCall(tool, input)], {
					stopReason: 'toolUse',
				})
			: quiet('done'),
	);

describe('the trace of a room activation', () => {
	it('holds each step, stamped and in order, with the same steps live, and reads them back after a reopen', async () => {
		const storage = memoryJournals();
		const { room, name, events, id, steps } = await traced(
			thinksThenCalls('weighing it', 'say', { text: 'Yes.' }),
			{ storage },
		);
		expect(sorted(steps)).toEqual([
			'pass',
			'thinking',
			'usage',
			'tool_call',
			'room',
			'tool_result',
			'text',
			'usage',
			'end',
		]);
		expect(steps.map((step) => step.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
		expect(steps.every((step) => step.activation === id && step.pass === 1)).toBe(true);
		expect(steps.every((step) => !Number.isNaN(Date.parse(step.at)))).toBe(true);
		expect(steps.find((step) => step.type === 'room')).toMatchObject({
			result: 'committed',
			intent: { kind: 'said', text: 'Yes.' },
		});
		expect(steps.find((step) => step.type === 'end')).toEqual(
			expect.objectContaining({ stop: 'stopped' }),
		);
		const live = events.flatMap((event) =>
			event.type === 'step' && event.activation === id ? [event.step] : [],
		);
		expect(live).toEqual(steps);
		for (const step of steps) assertWire(roundTrip(step));
		await room.stop();

		// A second runtime over the same storage reads the stopped room.
		const second = createRuntime({ storage });
		expect(await traceOf(second, name, id)).toEqual(steps);
		const read = await readActivation(name, id, { runtime: second });
		expect(read?.activation).toBe(id);
		expect(read?.passes).toHaveLength(1);
		expect(read?.passes[0]).toMatchObject({ pass: 1, input: 'view' });
		expect(read?.passes.flatMap((pass) => pass.steps)).toEqual(steps);
		const snapshot = await readRoom(name, { runtime: second });
		expect(snapshot.exchanges.flatMap((exchange) => exchange.activations)).toContainEqual(
			expect.objectContaining({
				id,
				seat: 'product',
				attempt: 1,
				purpose: 'respond',
				outcome: { status: 'released' },
			}),
		);

		// A second sink for the same activation replays the same keys.
		const again = hostingOf(second);
		const sink = openTrace({
			room: name,
			agent: 'product',
			activation: id,
			traces: again.traces,
			limits: again.limits.trace,
			policy: { thinking: 'full', toolOutput: 'full' },
			emit: () => {},
			now: () => 0,
		});
		sink.startPass('view', 1);
		sink.record({ type: 'text', text: 'late', final: true });
		await sink.close();
		expect(await traceOf(second, name, id)).toEqual(steps);
	});

	it('joins streamed deltas into one block and closes it', async () => {
		const { steps, events } = await traced(deltaStream(['al', 'pha', ' beta']));
		const texts = steps.filter((step) => step.type === 'text');
		expect(texts).toEqual([expect.objectContaining({ text: 'alpha beta', final: true })]);
		expect(
			events.filter((event) => event.type === 'step' && event.step.type === 'text'),
		).toHaveLength(1);
	});

	it('reads undefined for a malformed id and no passes for an unknown activation', async () => {
		const runtime = createRuntime();
		const name = roomName('read-activation-unknown');
		expect(await readActivation(name, 'nonsense', { runtime })).toBeUndefined();
		expect(await readActivation(name, 'message:4:product:1', { runtime })).toEqual({
			activation: 'message:4:product:1',
			passes: [],
		});
	});
});

describe('loggedToolResult', () => {
	it("replaces an image part's data with its byte count, and keeps everything else", () => {
		const result = {
			content: [
				{ type: 'text', text: 'Read image file [image/png]' },
				{ type: 'image', data: 'QUJD', mimeType: 'image/png' },
			],
			details: undefined,
		};
		expect(loggedToolResult(result)).toEqual({
			content: [
				{ type: 'text', text: 'Read image file [image/png]' },
				{ type: 'image', mimeType: 'image/png', bytes: 3 },
			],
			details: undefined,
		});
	});

	it('leaves a value with no content array unchanged', () => {
		expect(loggedToolResult('plain text')).toBe('plain text');
		expect(loggedToolResult(null)).toBe(null);
		expect(loggedToolResult({ details: 'x' })).toEqual({ details: 'x' });
	});
});

describe('the trace limits and policy', () => {
	const lookup = defineTool({
		name: 'lookup',
		description: 'Look something up.',
		parameters: Type.Object({}),
		execute: () => 'x'.repeat(100),
	});
	const viewer = defineTool({
		name: 'viewer',
		description: 'Return an image.',
		parameters: Type.Object({}),
		execute: () => ({
			content: [{ type: 'image', data: 'QUJD'.repeat(200), mimeType: 'image/png' }],
			details: undefined,
		}),
	});
	const asker = (policy?: TracePolicy) =>
		defineAgent({
			name: 'product',
			identity: 'Answers questions.',
			executor: pi({ instructions: 'Answer.', model: 'scripted/product', tools: [lookup, viewer] }),
			...(policy === undefined ? {} : { trace: policy }),
		});

	/** The steps of one activation that thinks, then calls `tool`. */
	/** The steps of one activation that thinks, then calls `tool`. */
	async function run(agent: AgentDefinition, options?: CreateRuntimeOptions, tool = 'lookup') {
		const { steps } = await traced(thinksThenCalls('a'.repeat(400), tool), options, agent);
		const result = steps.find((step) => step.type === 'tool_result');
		const thinking = steps.find((step) => step.type === 'thinking');
		return {
			steps,
			output: result?.type === 'tool_result' ? result.output : undefined,
			thinking: thinking?.type === 'thinking' ? thinking.text.length : undefined,
		};
	}

	it.each([
		['the default policy', undefined, 280, 'x'.repeat(100)],
		[
			'full thinking and output',
			{ thinking: 'full', toolOutput: 'full' } as const,
			400,
			'x'.repeat(100),
		],
	])('applies %s', async (_name, policy, thinking, output) => {
		const ran = await run(asker(policy));
		expect(ran.thinking).toBe(thinking);
		expect(JSON.stringify(ran.output)).toContain(output);
	});

	it('omits what the policy omits', async () => {
		const ran = await run(asker({ thinking: 'omit', toolOutput: 'omit' }));
		expect(sorted(ran.steps)).not.toContain('thinking');
		expect(ran.output).toBeNull();
	});

	it('cuts tool output to limits.trace.toolOutputBytes', async () => {
		const { output } = await run(asker(), { limits: { trace: { toolOutputBytes: 10 } } });
		expect(String(output)).toMatch(/^.{10}\n\[truncated: \d+ bytes\]$/s);
	});

	it('drops steps past limits.trace.stepsPerPass and keeps the end', async () => {
		const { steps } = await run(asker(), { limits: { trace: { stepsPerPass: 2 } } });
		expect(sorted(steps)).toEqual(['pass', 'thinking', 'end']);
	});

	it('redacts a tool result image before it counts against toolOutputBytes', async () => {
		const { output } = await run(
			asker(),
			{ limits: { trace: { toolOutputBytes: 10_000 } } },
			'viewer',
		);
		expect(output).toMatchObject({
			content: [{ type: 'image', mimeType: 'image/png', bytes: 600 }],
		});
		expect(JSON.stringify(output)).not.toContain('QUJD');
	});

	it('sums usage steps, and keeps the sum when the pass cap drops steps', async () => {
		const options = {
			room: 'usage-sum',
			agent: 'product',
			activation: 'message:2:product:1',
			traces: memoryJournals(),
			limits: { toolOutputBytes: 100, stepsPerPass: 1 },
			policy: { thinking: 'full', toolOutput: 'full' } as const,
			emit: () => {},
			now: () => 0,
		};
		const sink = openTrace(options);
		expect(sink.usage()).toBeUndefined();
		sink.startPass('view', 1);
		sink.record({ type: 'usage', input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 });
		sink.record({ type: 'usage', input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: 1 });
		expect(sink.usage()).toEqual({
			input: 11,
			output: 22,
			cacheRead: 33,
			cacheWrite: 44,
			cost: 1.5,
		});
		await sink.close();
		const costless = openTrace({ ...options, activation: 'message:2:product:2' });
		costless.record({ type: 'usage', input: 5, output: 1, cacheRead: 0, cacheWrite: 0 });
		expect(costless.usage()).toEqual({ input: 5, output: 1, cacheRead: 0, cacheWrite: 0 });
		await costless.close();
	});

	it('refuses a policy it does not know', () => {
		expect(() =>
			defineAgent({
				name: 'x',
				identity: 'x',
				executor: pi({ instructions: '', model: 'scripted/x' }),
				trace: { thinking: 'all' as never, toolOutput: 'full' },
			}),
		).toThrow(/trace.thinking/);
	});
});

/** A stream that sends its text as deltas, the way a provider does. */
function deltaStream(parts: string[]): StreamFn {
	return () => {
		const stream = createAssistantMessageEventStream();
		const message = fauxAssistantMessage(parts.join(''), { stopReason: 'stop' });
		queueMicrotask(() => {
			stream.push({ type: 'start', partial: message });
			stream.push({ type: 'text_start', contentIndex: 0, partial: message });
			for (const delta of parts)
				stream.push({ type: 'text_delta', contentIndex: 0, delta, partial: message });
			stream.push({ type: 'text_end', contentIndex: 0, content: parts.join(''), partial: message });
			stream.push({ type: 'done', reason: 'stop', message });
		});
		return stream;
	};
}

// -- the driver's own steps, over a room the test plays ---------------------------

/** A room that grants every lease and answers commits as the test says. */
class PlayedRoom implements RoomProtocol {
	constructor(private readonly now: () => number) {}
	lastSeq = 1;
	answer: CommitResult = { refused: 'not here' };
	async view(activation: string): Promise<ViewResponse> {
		return {
			view: {
				spec: {
					id: activation,
					seat: 'product',
					attempt: 1,
					purpose: { kind: 'respond', message: 1 },
				},
				through: this.lastSeq,
				context: { name: 'played', now: 0, participants: [], messages: [], reserve: [] },
			},
		};
	}
	async commit(): Promise<CommitResult> {
		return this.answer;
	}
	async lease(_lease: LeaseRequest): Promise<LeaseResponse> {
		return { ok: { expiresAt: this.now() + 60_000, lastSeq: this.lastSeq } };
	}
}

function play(stream: StreamFn, storage?: JournalOpener) {
	const clock = fakeClock();
	const runtime = createRuntime({ clock, storage, execution: piExecution({ stream }) });
	const services = createExecutionServices({ storage: storage ?? memoryJournals(), clock, stream });
	const hosting = hostingOf(runtime);
	const room = new PlayedRoom(() => clock.now());
	const events: ExecutionEvent[] = [];
	const executor = createPiExecutor({
		definition: product,
		model: services.model,
		stream: services.stream,
		transcripts: services.transcripts,
		room: 'played',
		now: () => clock.now(),
	});
	const actor = new AgentRunner(room, {
		clock,
		call: hosting.limits.call,
		definition: product,
		room: 'played',
		seat: 'product',
		executor,
		emit: (event) => events.push(event),
		trace: traceOpenerFor(runtime, events),
	});
	return { room, actor, runtime, events };
}

function traceOpenerFor(runtime: Runtime, events: ExecutionEvent[]) {
	const hosting = hostingOf(runtime);
	return traceOpener({
		room: 'played',
		agent: 'product',
		traces: hosting.traces,
		limits: hosting.limits.trace,
		policy: { thinking: 'full', toolOutput: 'full' },
		emit: (event) => events.push(event),
		now: () => 0,
	});
}

const id = 'message:1:product:1';

describe('the steps the driver owns', () => {
	it.each([
		['missed', { missed: [] } as CommitResult],
		['stale', { stale: 'gone' } as CommitResult],
		['refused', { refused: 'no' } as CommitResult],
		['unchanged', { unchanged: { kind: 'seated', name: 'x' } } as CommitResult],
	] as const)('records a %s commit as a room step', async (result, answer) => {
		const { room, actor, runtime } = play(
			scripted((_c, _a, call) => (call === 1 ? speak('Hi.') : quiet())),
		);
		room.answer = answer;
		await actor.run(id);
		const steps = await traceOf(runtime, 'played', id);
		expect(steps.find((step) => step.type === 'room')).toMatchObject({
			result,
			call: expect.any(String),
		});
		expect(steps.at(-1)?.type).toBe('end');
	});

	it('records a delta pass and the steers of a running activation', async () => {
		const release = deferred();
		const started = deferred();
		const stream: StreamFn = scripted(async (_context, _agent, call) => {
			if (call === 1) {
				started.resolve();
				await release.promise;
			}
			return quiet('nothing');
		});
		const { room, actor, runtime } = play(stream);
		const done = actor.run(id);
		// Before the provider starts, a steer is held and then dropped by the pass.
		await actor.steer({
			room: 'played',
			seat: 'product',
			activation: id,
			after: 1,
			message: said(2),
		});
		await started.promise;
		await actor.steer({
			room: 'played',
			seat: 'product',
			activation: id,
			after: 1,
			message: said(3),
		});
		room.lastSeq = 4;
		release.resolve();
		await done;
		const steps = await traceOf(runtime, 'played', id);
		const passes = steps.filter((step) => step.type === 'pass');
		expect(passes).toEqual([
			expect.objectContaining({ input: 'view', pass: 1 }),
			expect.objectContaining({ input: 'delta', pass: 2, through: 4 }),
		]);
		const steers = steps.filter((step) => step.type === 'steer');
		expect(steers).toEqual([
			expect.objectContaining({ seq: 2, consumed: false, pass: 1 }),
			expect.objectContaining({ seq: 3, consumed: true, pass: 1 }),
		]);
		await tick();
	});

	it.each([
		[
			'a permanent failure with its cause',
			fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'invalid_request_error: bad' }),
			{ failure: { cause: 'permanent', message: 'invalid_request_error: bad' } },
		],
		[
			'a transient failure with its cause',
			fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'the model is down' }),
			{ failure: { cause: 'transient', message: 'the model is down' } },
		],
		['deliberate silence as a stop with no failure', quiet(), { stop: 'stopped' }],
	] as const)('ends %s', async (_name, message, end) => {
		const { actor, runtime } = play(scripted(() => message));
		await actor.run(id);
		const last = (await traceOf(runtime, 'played', id)).at(-1);
		expect(last).toMatchObject({ type: 'end', ...end });
		expect(last !== undefined && 'failure' in last).toBe('failure' in end);
	});

	it('reports a failed trace write and never fails the activation', async () => {
		const storage: JournalOpener = {
			open: async () => ({
				read: async (after) => ({ entries: [], position: after }),
				append: async () => {
					throw new Error('trace storage down');
				},
			}),
		};
		const { actor, events } = play(
			scripted(() => quiet()),
			storage,
		);
		await actor.run(id);
		expect(events.some((event) => event.type === 'trace_error')).toBe(true);
		expect(events.some((event) => event.type === 'error')).toBe(false);
	});
});

function said(seq: number) {
	return { kind: 'said' as const, seq, at: '', from: 'priya', text: 'More.' };
}
