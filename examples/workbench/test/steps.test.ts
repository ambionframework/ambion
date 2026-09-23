import type { ExchangeActivation, TraceStep, Usage } from '@ambionframework/ambion';
import { describe, expect, it } from 'vitest';
import {
	type ActivationSteps,
	activationLine,
	ended,
	formatUsage,
	stepLog,
	stepsView,
} from '../src/steps.ts';

const AT = '2026-01-01T00:00:00Z';
const usage = (extra: Partial<Usage> = {}): Usage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	...extra,
});

const read = (steps: Record<string, unknown>[][]): ActivationSteps =>
	({
		activation: 'a',
		passes: steps.map((list, pass) => ({
			pass: pass + 1,
			input: pass === 0 ? 'view' : 'delta',
			through: 10 * (pass + 1),
			steps: list.map((step, index) => ({
				activation: 'a',
				at: AT,
				pass: pass + 1,
				index,
				...step,
			})),
		})),
	}) as unknown as ActivationSteps;

describe('stepsView', () => {
	it('groups a trace by pass, in order, with one line per step', () => {
		const passes = stepsView(
			read([
				[
					{ type: 'pass', input: 'view', through: 10 },
					{ type: 'thinking', text: 'Consider the LED.\nSecond line.', final: true },
					{ type: 'tool_call', call: 'c', name: 'read', input: { path: '/a' } },
					{ type: 'tool_result', call: 'c', output: 'ok' },
				],
				[
					{ type: 'pass', input: 'delta', through: 20 },
					{ type: 'tool_result', call: 'c', output: null, error: 'boom' },
					{
						type: 'room',
						call: 'r',
						intent: { kind: 'said', text: 'hi' },
						result: 'committed',
						seq: 7,
					},
					{ type: 'steer', seq: 8, consumed: false },
					{ type: 'usage', ...usage({ cost: 0.5 }) },
					{ type: 'end', stop: 'stopped' },
				],
			]),
		);
		expect(passes.map((pass) => [pass.pass, pass.input, pass.through])).toEqual([
			[1, 'view', 10],
			[2, 'delta', 20],
		]);
		expect(passes[0]?.lines).toEqual([
			{ kind: 'thinking', text: 'Consider the LED.' },
			{ kind: 'tool', text: 'read {"path":"/a"}' },
			{ kind: 'result', text: 'ok' },
		]);
		expect(passes[1]?.lines.map((line) => line.text)).toEqual([
			'failed: boom',
			'room committed at 7',
			'steer 8 queued',
			'$0.5000',
			'ended: stopped',
		]);
	});

	it('shows a partial trace with no end step, and reports it as not ended', () => {
		const partial = read([[{ type: 'pass', input: 'view', through: 1 }]]);
		expect(stepsView(partial)[0]?.lines).toEqual([]);
		expect(ended(partial)).toBe(false);
		expect(stepsView({ activation: 'a', passes: [] })).toEqual([]);
	});

	it('shows the failure of an activation and the harness permission steps', () => {
		const lines = stepsView(
			read([
				[
					{ type: 'approval', call: 'c', name: 'bash' },
					{ type: 'approval', call: 'c', name: 'bash', decision: 'deny' },
					{ type: 'approval', call: 'd', name: 'edit', decision: 'allow' },
					{
						type: 'end',
						stop: 'aborted',
						failure: { cause: 'error', message: 'provider down' },
					},
				],
			]),
		)[0]?.lines;
		expect(lines?.map((line) => line.text)).toEqual([
			'bash: waiting for the harness permission',
			'bash: harness permission denied',
			'edit: harness permission allowed',
			'ended: provider down',
		]);
	});
});

describe('formatUsage', () => {
	it('prefers cost, falls back to tokens, and shows nothing without usage', () => {
		expect(formatUsage(usage({ input: 9000, output: 3300, cost: 0.0123 }))).toBe('$0.0123');
		expect(formatUsage(usage({ input: 9000, output: 3300 }))).toBe('12.3k tokens');
		expect(formatUsage(usage({ input: 12 }))).toBe('12 tokens');
		expect(formatUsage(usage())).toBe('');
		expect(formatUsage(undefined)).toBe('');
	});
});

describe('activationLine', () => {
	it('names the seat, purpose, attempt, state, and cost', () => {
		const base: ExchangeActivation = {
			id: 'a',
			seat: 'design',
			attempt: 1,
			purpose: 'respond',
			outcome: { status: 'released' },
			usage: usage({ cost: 0.0031 }),
		};
		expect(activationLine(base)).toBe('design · respond · attempt 1 · $0.0031');
		expect(activationLine({ ...base, usage: undefined, outcome: { status: 'running' } })).toBe(
			'design · respond · attempt 1 · running',
		);
	});
});

describe('stepLog', () => {
	const step = (activation: string, pass: number, index: number, extra: object): TraceStep =>
		({ activation, pass, index, at: AT, ...extra }) as TraceStep;
	const opened = (activation: string, pass: number) =>
		step(activation, pass, 0, { type: 'pass', pass, input: 'view', through: 3 });

	it('groups the steps of an activation by pass, and keeps only the latest activations', () => {
		const log = stepLog(2);
		log.logger({ room: 'lab', seat: 'product', step: opened('first', 1) });
		log.logger({ room: 'lab', seat: 'product', step: opened('second', 1) });
		log.logger({
			room: 'lab',
			seat: 'product',
			step: step('second', 1, 1, { type: 'end', stop: 'stopped' }),
		});
		log.logger({ room: 'lab', seat: 'product', step: opened('second', 2) });
		log.logger({ room: 'other', seat: 'product', step: opened('third', 1) });
		expect(log.read('lab', 'first')).toBeUndefined();
		expect(log.read('lab', 'third')).toBeUndefined();
		const second = log.read('lab', 'second');
		expect(second?.activation).toBe('second');
		expect(second?.passes.map((pass) => [pass.pass, pass.steps.length])).toEqual([
			[1, 2],
			[2, 1],
		]);
		expect(second && ended(second)).toBe(true);
	});
});
