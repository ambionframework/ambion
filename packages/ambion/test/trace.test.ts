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
import { openTrace, traceOpener } from '../src/execution/trace.ts';
import {
	AgentRunner,
	type CommitResult,
	hostingOf,
	type LeaseRequest,
	type LeaseResponse,
	type RoomProtocol,
	type ViewResponse,
} from '../src/hosting.ts';
import type { ExecutionEvent, Room, RoomNotification, Runtime, TraceStep } from '../src/index.ts';
import {
	createRuntime,
	defineAgent,
	defineTool,
	startRoom,
	type TracePolicy,
} from '../src/index.ts';
import { assertWire, roundTrip } from '../src/protocol.ts';
import { fakeClock } from './support/clock.ts';
import { andrei, collect, deferred, roomName, tick, waitForRoom } from './support/room.ts';
import { quiet, scripted, speak } from './support/scripted.ts';
import { traceOf } from './support/trace.ts';

const product = defineAgent({
	name: 'product',
	identity: 'Answers questions.',
	executor: pi({ instructions: 'Answer.', model: 'scripted/product' }),
});

const sorted = (steps: readonly TraceStep[]) => steps.map((step) => step.type);

/** The trace of the one activation a room ran for a seat. */
async function ranOnce(runtime: Runtime, room: string, events: readonly RoomNotification[]) {
	const started = events.find((event) => event.type === 'activation_start');
	if (started?.type !== 'activation_start') throw new Error('No activation started.');
	return { id: started.activation, steps: await traceOf(runtime, room, started.activation) };
}

async function ask(room: Room, text: string): Promise<void> {
	const visit = await room.visit(andrei);
	await visit.send({ text });
	await waitForRoom(room, 'quiet', 2_000);
}

describe('the trace of a room activation', () => {
	it('holds each step, stamped and in order, with the same steps live', async () => {
		const runtime = createRuntime();
		const name = roomName('trace-room');
		const room = await startRoom({
			name,
			agents: [product],
			runtime,
			execution: piExecution({
				stream: scripted((_context, _agent, call) =>
					call === 1
						? fauxAssistantMessage(
								[fauxThinking('weighing it'), fauxToolCall('say', { text: 'Yes.' })],
								{
									stopReason: 'toolUse',
								},
							)
						: quiet('done'),
				),
			}),
		});
		const events = collect(room);
		await ask(room, 'Ready?');
		const { id, steps } = await ranOnce(runtime, name, events);
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
	});

	it('joins streamed deltas into one block and closes it', async () => {
		const runtime = createRuntime();
		const name = roomName('trace-deltas');
		const room = await startRoom({
			name,
			agents: [product],
			runtime,
			execution: piExecution({ stream: deltaStream(['al', 'pha', ' beta']) }),
		});
		const events = collect(room);
		await ask(room, 'Hello?');
		const { steps } = await ranOnce(runtime, name, events);
		const texts = steps.filter((step) => step.type === 'text');
		expect(texts).toEqual([expect.objectContaining({ text: 'alpha beta', final: true })]);
		expect(
			events.filter((event) => event.type === 'step' && event.step.type === 'text'),
		).toHaveLength(1);
	});

	it('survives a reopen and writes each step once for a repeated activation', async () => {
		const storage = memoryJournals();
		const name = roomName('trace-replay');
		const first = createRuntime({ storage });
		const room = await startRoom({
			name,
			agents: [product],
			runtime: first,
			execution: piExecution({
				stream: scripted((_context, _agent, call) => (call === 1 ? speak('Yes.') : quiet())),
			}),
		});
		const events = collect(room);
		await ask(room, 'Ready?');
		const { id, steps } = await ranOnce(first, name, events);
		const second = createRuntime({ storage });
		expect(await traceOf(second, name, id)).toEqual(steps);
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
});

describe('the trace limits and policy', () => {
	const lookup = defineTool({
		name: 'lookup',
		description: 'Look something up.',
		parameters: Type.Object({}),
		execute: () => 'x'.repeat(100),
	});
	const asker = (policy?: TracePolicy) =>
		defineAgent({
			name: 'product',
			identity: 'Answers questions.',
			executor: pi({ instructions: 'Answer.', model: 'scripted/product', tools: [lookup] }),
			...(policy === undefined ? {} : { trace: policy }),
		});
	const script = () =>
		scripted((_context, _agent, call) =>
			call === 1
				? fauxAssistantMessage([fauxThinking('a'.repeat(400)), fauxToolCall('lookup', {})], {
						stopReason: 'toolUse',
					})
				: quiet('done'),
		);

	async function run(
		agent: ReturnType<typeof asker>,
		limits?: Parameters<typeof createRuntime>[0],
	) {
		const runtime = createRuntime(limits);
		const name = roomName('trace-policy');
		const room = await startRoom({
			name,
			agents: [agent],
			runtime,
			execution: piExecution({ stream: script() }),
		});
		const events = collect(room);
		await ask(room, 'Look?');
		return (await ranOnce(runtime, name, events)).steps;
	}

	it('applies the default policy: full tool output, summarised thinking', async () => {
		const steps = await run(asker());
		const thinking = steps.find((step) => step.type === 'thinking');
		expect(thinking?.type === 'thinking' && thinking.text.length).toBe(280);
		const result = steps.find((step) => step.type === 'tool_result');
		expect(result?.type === 'tool_result' && JSON.stringify(result.output)).toContain(
			'x'.repeat(100),
		);
	});

	it('omits what the policy omits', async () => {
		const steps = await run(asker({ thinking: 'omit', toolOutput: 'omit' }));
		expect(sorted(steps)).not.toContain('thinking');
		const result = steps.find((step) => step.type === 'tool_result');
		expect(result).toMatchObject({ output: null });
	});

	it('keeps full thinking when the policy says so', async () => {
		const steps = await run(asker({ thinking: 'full', toolOutput: 'full' }));
		const thinking = steps.find((step) => step.type === 'thinking');
		expect(thinking?.type === 'thinking' && thinking.text.length).toBe(400);
	});

	it('cuts tool output to limits.trace.toolOutputBytes', async () => {
		const steps = await run(asker(), { limits: { trace: { toolOutputBytes: 10 } } });
		const result = steps.find((step) => step.type === 'tool_result');
		expect(result?.type === 'tool_result' && String(result.output)).toMatch(
			/^.{10}\n\[truncated: \d+ bytes\]$/s,
		);
	});

	it('drops steps past limits.trace.stepsPerPass and keeps the end', async () => {
		const steps = await run(asker(), { limits: { trace: { stepsPerPass: 2 } } });
		expect(sorted(steps)).toEqual(['pass', 'thinking', 'end']);
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

function play(stream: StreamFn) {
	const clock = fakeClock();
	const runtime = createRuntime({ clock, execution: piExecution({ stream }) });
	const services = createExecutionServices({ storage: memoryJournals(), clock, stream });
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
		['a permanent failure', 'invalid_request_error: bad', 'permanent'],
		['a transient failure', 'the model is down', 'transient'],
	] as const)('ends %s with its cause', async (_name, message, cause) => {
		const { actor, runtime } = play(
			scripted(() => fauxAssistantMessage('', { stopReason: 'error', errorMessage: message })),
		);
		await actor.run(id);
		const steps = await traceOf(runtime, 'played', id);
		expect(steps.at(-1)).toMatchObject({ type: 'end', failure: { cause, message } });
	});

	it('ends deliberate silence as a stop with no failure', async () => {
		const { actor, runtime } = play(scripted(() => quiet()));
		await actor.run(id);
		const steps = await traceOf(runtime, 'played', id);
		const end = steps.at(-1);
		expect(end).toMatchObject({ type: 'end', stop: 'stopped' });
		expect(end && 'failure' in end).toBe(false);
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
		const stream = scripted(() => quiet());
		const runtime = createRuntime({ storage, execution: piExecution({ stream }) });
		const services = createExecutionServices({ storage, clock: runtime.clock, stream });
		const hosting = hostingOf(runtime);
		const events: ExecutionEvent[] = [];
		const room = new PlayedRoom(() => runtime.clock.now());
		const executor = createPiExecutor({
			definition: product,
			model: services.model,
			stream: services.stream,
			transcripts: services.transcripts,
			room: 'played',
			now: () => 0,
		});
		const actor = new AgentRunner(room, {
			clock: runtime.clock,
			call: hosting.limits.call,
			definition: product,
			room: 'played',
			seat: 'product',
			executor,
			emit: (event) => events.push(event),
			trace: traceOpenerFor(runtime, events),
		});
		await actor.run(id);
		expect(events.some((event) => event.type === 'trace_error')).toBe(true);
		expect(events.some((event) => event.type === 'error')).toBe(false);
	});
});

function said(seq: number) {
	return { kind: 'said' as const, seq, at: '', from: 'priya', text: 'More.' };
}
