import { assertJson, memoryJournals } from '@ambionframework/journal';
import type { JsonObject } from '@earendil-works/pi-ai';
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxThinking,
	fauxToolCall,
} from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import { createPiOpener } from '../../pi/src/executor.ts';
import { createExecutionServices, pi, piExecution, type StreamFn } from '../../pi/src/index.ts';
import type { TraceOpener } from '../src/execution/contract.ts';
import { loggedToolResult, openTrace, traceOpener } from '../src/execution/trace.ts';
import {
	type ActivationOpener,
	AgentRunner,
	type CommitResult,
	hostingOf,
	type LeaseRequest,
	type LeaseResponse,
	type RoomProtocol,
	type ViewResponse,
} from '../src/hosting.ts';
import type {
	ActivationEvent,
	AgentDefinition,
	CreateRuntimeOptions,
	Message,
	TraceLogger,
	TraceStep,
} from '../src/index.ts';
import {
	createRuntime,
	defineAgent,
	defineTool,
	readRoom,
	startRoom,
	type TracePolicy,
} from '../src/index.ts';
import { roundTrip } from '../src/protocol.ts';
import { fakeClock } from '../src/testing.ts';
import { andrei, collect, deferred, roomName, tick, waitForRoom } from './support/room.ts';
import { quiet, say, scriptedStream } from './support/scripted.ts';
import { stopAtEnd } from './support/stop.ts';
import { collectSteps } from './support/trace.ts';

const product = defineAgent({
	name: 'product',
	identity: 'Answers questions.',
	executor: pi({ instructions: 'Answer.', model: 'scripted/product' }),
});

const sorted = (steps: readonly TraceStep[]) => steps.map((step) => step.type);

/** Ask one question in a room that runs `stream`, and read the logged steps of its one activation. */
async function traced(
	stream: StreamFn,
	options: Omit<CreateRuntimeOptions, 'storage'> = {},
	agent = product,
) {
	const log = collectSteps();
	const runtime = createRuntime({ storage: memoryJournals(), ...options, logger: log.logger });
	const name = roomName('trace');
	const room = stopAtEnd(
		await startRoom({
			name,
			agents: [agent],
			runtime,
			execution: piExecution({ sessions: 'memory', stream }),
		}),
	);
	const events = collect(room);
	await (await room.visit(andrei)).send({ text: 'Ready?' });
	await waitForRoom(room, 'quiet', 2_000);
	const started = events.find((event) => event.type === 'activation_start');
	if (started?.type !== 'activation_start') throw new Error('No activation started.');
	const id = started.activation;
	return { runtime, room, name, id, steps: log.of(id), records: log.records };
}

/** A stream that thinks, then calls `tool`, then stops. */
const thinksThenCalls = (thinking: string, tool: string, input: JsonObject = {}) =>
	scriptedStream((_context, _agent, request) =>
		request === 1
			? fauxAssistantMessage([fauxThinking(thinking), fauxToolCall(tool, input)], {
					stopReason: 'toolUse',
				})
			: quiet(),
	);

describe('the trace of a room activation', () => {
	it('gives each step to the logger, stamped, in order, with the room and the seat', async () => {
		const { runtime, room, name, id, steps, records } = await traced(
			thinksThenCalls('weighing it', 'say', { text: 'Yes.' }),
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
		expect(records.every((record) => record.room === name && record.seat === 'product')).toBe(true);
		expect(steps.find((step) => step.type === 'room')).toMatchObject({
			result: 'committed',
			intent: { kind: 'said', text: 'Yes.' },
		});
		expect(steps.find((step) => step.type === 'end')).toEqual(
			expect.objectContaining({ stop: 'stopped' }),
		);
		for (const step of steps) assertJson(roundTrip(step));
		await room.stop();
		const snapshot = await readRoom(name, { runtime });
		expect(snapshot.exchanges.flatMap((exchange) => exchange.activations)).toContainEqual(
			expect.objectContaining({
				id,
				seat: 'product',
				attempt: 1,
				purpose: 'respond',
				outcome: { kind: 'released' },
			}),
		);
	});

	it('joins streamed deltas into one block and closes it', async () => {
		const { steps } = await traced(deltaStream(['al', 'pha', ' beta']));
		const texts = steps.filter((step) => step.type === 'text');
		expect(texts).toEqual([expect.objectContaining({ text: 'alpha beta', final: true })]);
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
		// The Claude and Codex executors log the content parts with no record around them.
		expect(loggedToolResult(result.content)).toEqual([
			{ type: 'text', text: 'Read image file [image/png]' },
			{ type: 'image', mimeType: 'image/png', bytes: 3 },
		]);
		// The Claude executor logs an image in the shape of the Anthropic API.
		const anthropic = {
			type: 'image',
			source: { type: 'base64', media_type: 'image/png', data: 'QUJD' },
		};
		expect(loggedToolResult([anthropic])).toEqual([
			{ type: 'image', source: { type: 'base64', media_type: 'image/png', bytes: 3 } },
		]);
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
	async function run(
		agent: AgentDefinition,
		options?: Omit<CreateRuntimeOptions, 'storage'>,
		tool = 'lookup',
	) {
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

	it.each([
		['an absent input field', undefined],
		['input: omit', { thinking: 'start', toolOutput: 'full', input: 'omit' } as const],
	])('logs no input step for %s', async (_name, policy) => {
		const ran = await run(asker(policy));
		expect(sorted(ran.steps)).not.toContain('input');
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

	it('cuts an input step to limits.trace.inputBytes', async () => {
		const log = collectSteps();
		const sink = openTrace({
			room: 'input',
			seat: 'product',
			activation: 'message:2:product:1',
			limits: { toolOutputBytes: 100, inputBytes: 10, stepsPerPass: 10 },
			policy: { thinking: 'omit', toolOutput: 'omit', input: 'full' },
			now: () => 0,
			logger: log.logger,
		});
		sink.startPass('view', 1);
		sink.record({ type: 'input', part: 'record', text: 'a'.repeat(50) });
		await sink.close();
		expect(log.records[1]?.step).toMatchObject({
			type: 'input',
			text: `${'a'.repeat(10)}\n[truncated: 50 bytes]`,
		});
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
			seat: 'product',
			activation: 'message:2:product:1',
			limits: { toolOutputBytes: 100, inputBytes: 100, stepsPerPass: 1 },
			policy: { thinking: 'full', toolOutput: 'full' } as const,
			now: () => 0,
		};
		const log = collectSteps();
		const sink = openTrace({ ...options, logger: log.logger });
		expect(sink.usage()).toBeUndefined();
		sink.startPass('view', 1);
		sink.record({ type: 'text', text: 'dropped', final: true });
		sink.record({ type: 'usage', input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 });
		sink.record({ type: 'usage', input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: 1 });
		expect(sink.usage()).toEqual({
			input: 11,
			output: 22,
			cacheRead: 33,
			cacheWrite: 44,
			cost: 1.5,
		});
		await expect(sink.close()).resolves.toBeUndefined();
		// The cap of one step a pass logged the pass step only.
		expect(log.records.map((record) => record.step.type)).toEqual(['pass']);
		const costless = openTrace({ ...options, activation: 'message:2:product:2' });
		costless.record({ type: 'usage', input: 5, output: 1, cacheRead: 0, cacheWrite: 0 });
		expect(costless.usage()).toEqual({ input: 5, output: 1, cacheRead: 0, cacheWrite: 0 });
		await costless.close();
	});

	it('closes an open text block at a nested step, and keeps the text in two blocks', async () => {
		const log = collectSteps();
		const sink = openTrace({
			room: 'nested',
			seat: 'product',
			activation: 'message:2:product:1',
			limits: { toolOutputBytes: 100, inputBytes: 100, stepsPerPass: 10 },
			policy: { thinking: 'full', toolOutput: 'full' },
			now: () => 0,
			logger: log.logger,
		});
		sink.startPass('view', 1);
		sink.record({ type: 'text', text: 'before ', final: false });
		sink.record({ type: 'tool_call', call: 'n1', name: 'bash', input: {}, parent: 'c1' });
		sink.record({ type: 'text', text: 'after', final: false });
		sink.record({ type: 'tool_result', call: 'n1', output: 'ok', parent: 'c1' });
		await sink.close();
		const steps = log.of('message:2:product:1');
		expect(sorted(steps)).toEqual(['pass', 'text', 'tool_call', 'text', 'tool_result']);
		expect(steps.filter((step) => step.type === 'text')).toEqual([
			expect.objectContaining({ text: 'before ', final: true }),
			expect.objectContaining({ text: 'after', final: true }),
		]);
		expect(steps[2]).toMatchObject({ call: 'n1', parent: 'c1' });
	});

	it('logs a notice in order under the strictest policy, with its data as plain JSON', async () => {
		const log = collectSteps();
		const sink = openTrace({
			room: 'notice',
			seat: 'product',
			activation: 'message:2:product:1',
			limits: { toolOutputBytes: 100, inputBytes: 100, stepsPerPass: 10 },
			policy: { thinking: 'omit', toolOutput: 'omit' },
			now: () => 0,
			logger: log.logger,
		});
		sink.startPass('view', 1);
		sink.record({ type: 'notice', level: 'info', text: 'Plain.' });
		sink.record({
			type: 'notice',
			level: 'warning',
			text: 'Data.',
			data: { thread: 't1', gone: undefined },
		});
		await sink.close();
		expect(log.records.map((record) => record.step)).toMatchObject([
			{ type: 'pass' },
			{ type: 'notice', level: 'info', text: 'Plain.', index: 1 },
			{ type: 'notice', level: 'warning', data: { thread: 't1' }, index: 2 },
		]);
		expect(JSON.stringify(log.records[2]?.step)).not.toContain('gone');
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
		expect(() =>
			defineAgent({
				name: 'x',
				identity: 'x',
				executor: pi({ instructions: '', model: 'scripted/x' }),
				trace: { thinking: 'start', toolOutput: 'full', input: 'all' as never },
			}),
		).toThrow('trace.input must be omit or full.');
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
	readonly leases: LeaseRequest[] = [];
	lastSeq = 1;
	messages: Message[] = [];
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
				context: {
					name: 'played',
					now: 0,
					participants: [],
					messages: this.messages,
					reserve: [],
				},
			},
		};
	}
	async commit(): Promise<CommitResult> {
		return this.answer;
	}
	/** A claim this returns a promise for waits on it. */
	hold: (lease: LeaseRequest) => Promise<void> | undefined = () => undefined;
	async lease(lease: LeaseRequest): Promise<LeaseResponse> {
		this.leases.push(lease);
		await this.hold(lease);
		return { ok: { expiresAt: this.now() + 60_000, through: this.lastSeq } };
	}
}

interface PlayOptions {
	readonly logger?: TraceLogger;
	readonly wrap?: (opener: TraceOpener) => TraceOpener;
	readonly stub?: ActivationOpener;
	readonly policy?: TracePolicy;
}

function play(
	stream: StreamFn,
	{
		logger = collectSteps().logger,
		wrap = (opener) => opener,
		stub,
		policy = { thinking: 'full', toolOutput: 'full' },
	}: PlayOptions = {},
) {
	const clock = fakeClock();
	const runtime = createRuntime({
		storage: memoryJournals(),
		clock,
		execution: piExecution({ sessions: 'memory', stream }),
	});
	const services = createExecutionServices({ stream, sessions: 'memory' });
	const hosting = hostingOf(runtime);
	const room = new PlayedRoom(() => clock.now());
	const events: ActivationEvent[] = [];
	const opener =
		stub ?? createPiOpener({ ...services, definition: product, now: () => clock.now() });
	const actor = new AgentRunner(room, {
		clock,
		call: hosting.limits.call,
		definition: product,
		room: 'played',
		seat: 'product',
		opener,
		emit: (event) => events.push(event),
		trace: wrap(
			traceOpener({
				room: 'played',
				seat: 'product',
				logger,
				limits: hosting.limits.trace,
				policy,
				now: () => 0,
			}),
		),
	});
	return { room, actor, events };
}

const id = 'message:1:product:1';

describe('the steps the driver owns', () => {
	it.each([
		['missed', { missed: [] } as CommitResult],
		['stale', { stale: 'gone' } as CommitResult],
		['refused', { refused: 'no' } as CommitResult],
		['unchanged', { unchanged: { kind: 'seated', name: 'x' } } as CommitResult],
	] as const)('records a %s commit as a room step', async (result, answer) => {
		const log = collectSteps();
		const { room, actor } = play(
			scriptedStream((_c, _a, request) => (request === 1 ? say('Hi.') : quiet())),
			{ logger: log.logger },
		);
		room.answer = answer;
		await actor.run(id);
		const steps = log.of(id);
		expect(steps.find((step) => step.type === 'room')).toMatchObject({
			result,
			call: expect.any(String),
		});
		expect(steps.at(-1)?.type).toBe('end');
	});

	it('records a delta pass and the steers of a running activation', async () => {
		const release = deferred();
		const started = deferred();
		const stream: StreamFn = scriptedStream(async (_context, _agent, request) => {
			if (request === 1) {
				started.resolve();
				await release.promise;
			}
			return quiet();
		});
		const log = collectSteps();
		const { room, actor } = play(stream, {
			logger: log.logger,
			policy: { thinking: 'full', toolOutput: 'full', input: 'full' },
		});
		const done = actor.run(id);
		// Before the first pass, the core holds a steer. The first prompt carries it.
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
		room.messages = [said(2), said(3)];
		release.resolve();
		await done;
		const steps = log.of(id);
		const passes = steps.filter((step) => step.type === 'pass');
		expect(passes).toEqual([
			expect.objectContaining({ input: 'view', pass: 1 }),
			expect.objectContaining({ input: 'delta', pass: 2, through: 4 }),
		]);
		// The system part comes once, right after the first `pass` step. Each pass records its record.
		const inputs = steps.filter((step) => step.type === 'input');
		expect(inputs.map((step) => [step.pass, step.type === 'input' && step.part])).toEqual([
			[1, 'system'],
			[1, 'record'],
			[2, 'record'],
		]);
		expect(steps.indexOf(inputs[0] as TraceStep)).toBe(steps.indexOf(passes[0] as TraceStep) + 1);
		expect(inputs[0]).toMatchObject({ text: expect.stringContaining('Answer.') });
		expect(inputs[2]).toMatchObject({ text: expect.stringContaining('[new]') });
		const steers = steps.filter((step) => step.type === 'steer');
		expect(steers).toEqual([
			expect.objectContaining({ seq: 2, consumed: true, pass: 1 }),
			// The answer closed the request before the second line: the delta pass carries it.
			expect.objectContaining({ seq: 3, consumed: false, pass: 1 }),
		]);
		await tick();
	});

	it('records the steer of a line that waited for a claim the room refused', async () => {
		const log = collectSteps();
		const { room, actor } = play(
			scriptedStream(() => quiet()),
			{ logger: log.logger },
		);
		room.lease = async () => ({ stale: 'gone' });
		const done = actor.run(id);
		await actor.steer({
			room: 'played',
			seat: 'product',
			activation: id,
			after: 1,
			message: said(2),
		});
		await done;
		expect(log.of(id).filter((step) => step.type === 'steer')).toEqual([
			expect.objectContaining({ seq: 2, consumed: false }),
		]);
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
		const log = collectSteps();
		const { actor } = play(
			scriptedStream(() => message),
			{ logger: log.logger },
		);
		await actor.run(id);
		const last = log.of(id).at(-1);
		expect(last).toMatchObject({ type: 'end', ...end });
		expect(last !== undefined && 'failure' in last).toBe('failure' in end);
	});

	it('ends a failure that names no message, and raises one error event for it', async () => {
		const log = collectSteps();
		const failing: ActivationOpener = () => ({
			pass: async () => ({ failed: true, cause: 'permanent' }),
		});
		const { actor, events } = play(
			scriptedStream(() => quiet()),
			{ logger: log.logger, stub: failing },
		);
		await actor.run(id);
		const message = 'The activation failed.';
		expect(log.of(id).at(-1)).toMatchObject({
			type: 'end',
			failure: { cause: 'permanent', message },
		});
		expect(events.filter((event) => event.type === 'error')).toEqual([
			expect.objectContaining({ cause: 'permanent', error: new Error(message) }),
		]);
	});

	const throwing: TraceLogger = () => {
		throw new Error('log down');
	};
	const rejecting: TraceLogger = () => Promise.reject(new Error('log down'));
	it.each([
		['throws', throwing],
		['rejects', rejecting],
	])('never fails the activation when the logger %s', async (_name, logger) => {
		const { room, actor, events } = play(
			scriptedStream(() => quiet()),
			{ logger },
		);
		await actor.run(id);
		await tick();
		expect(room.leases.at(-1)).toMatchObject({ operation: 'release', reason: 'released' });
		expect(events.some((event) => event.type === 'error')).toBe(false);
	});
});

describe('a sink that closes late', () => {
	it('queues a wake that comes during the close, and runs it after', async () => {
		const [first, second, third] = [
			'message:1:product:1',
			'message:2:product:1',
			'message:3:product:1',
		];
		const closing = deferred();
		const closed = deferred();
		const { room, actor } = play(
			scriptedStream(() => quiet()),
			{
				wrap: (opener) => ({
					open: (activation) => {
						const sink = opener.open(activation);
						if (activation !== first) return sink;
						return {
							startPass: (input, through) => sink.startPass(input, through),
							record: (step) => sink.record(step),
							usage: () => sink.usage(),
							close: async () => {
								closing.resolve();
								await closed.promise;
							},
						};
					},
				}),
			},
		);
		const running = actor.run(first);
		await closing.promise;
		// The first activation released its lease and waits on its sink. It
		// still holds the seat, so the next two wakes queue behind it.
		await actor.run(second);
		await actor.run(third);
		expect(room.leases.filter((lease) => lease.operation === 'claim')).toHaveLength(1);
		closed.resolve();
		await running;
		const released = room.leases.flatMap((lease) =>
			lease.operation === 'release' ? [[lease.activation, lease.reason]] : [],
		);
		expect(released).toEqual([
			[first, 'released'],
			[second, 'released'],
			[third, 'released'],
		]);
	});
});

function said(seq: number) {
	return { kind: 'said' as const, seq, at: '', from: 'priya', text: 'More.' };
}
