import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';
import { agentJudge, defineEval, type EvalCheck, runEvals } from '../src/index.ts';

const makeEval = (checks: readonly EvalCheck<{ count: number }>[]) =>
	defineEval({
		id: 'review/inventory',
		version: 1,
		scope: 'agent',
		input: { sku: 'A' },
		async setup() {
			return {};
		},
		async run() {
			return { count: 42 };
		},
		async capture() {
			return { stock: { count: 42 } };
		},
		checks,
		async teardown() {},
	});

const correct: EvalCheck<{ count: number }> = {
	id: 'correct',
	requires: ['stock'],
	async evaluate({ output, evidence }) {
		assert.equal(output.count, 42);
		assert.deepEqual(evidence.stock, { count: 42 });
	},
};

describe('independent architecture review', () => {
	it('does not let one checker rewrite the next checker or retained evidence', async () => {
		const mutation: EvalCheck<{ count: number }> = {
			id: 'mutation',
			requires: ['stock'],
			async evaluate({ output, evidence }) {
				output.count = 0;
				(evidence.stock as { count: number }).count = 0;
			},
		};
		const report = await runEvals([makeEval([mutation, correct])]);
		expect(report.samples[0]?.checks.find((check) => check.id === 'correct')?.status).toBe(
			'passed',
		);
		expect(report.samples[0]?.output).toEqual({ count: 42 });
		expect(report.samples[0]?.evidence.stock).toEqual({ count: 42 });
	});

	it('continues grading after an assertion fails and retains failure classification', async () => {
		const failure: EvalCheck<{ count: number }> = {
			id: 'failure',
			requires: ['stock'],
			async evaluate() {
				assert.equal(1, 2);
			},
		};
		const report = await runEvals([makeEval([failure, correct])]);
		expect(report.samples[0]?.checks.map((check) => check.status)).toEqual(['failed', 'passed']);
		expect(report.samples[0]?.status).toBe('failed');
	});

	it('does not run the next sample while a timed-out callback remains alive', async () => {
		let started = 0;
		let release: () => void = () => {};
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const subject = defineEval({
			...makeEval([correct]),
			async run() {
				started += 1;
				await pending;
				return { count: 42 };
			},
		});
		try {
			const report = await runEvals([subject], {
				samples: 2,
				timeouts: { run: 5, settle: 5, cleanup: 5 },
			});
			expect(started).toBe(1);
			expect(report.samples[0]?.status).not.toBe('passed');
		} finally {
			release();
		}
	});

	it.each([Number.NaN, Infinity, () => 1, undefined])(
		'rejects lossy JSON output without bypassing cleanup (%s)',
		async (value) => {
			let disposed = false;
			const subject = defineEval({
				id: 'review/json',
				version: 1,
				scope: 'agent',
				input: {},
				async setup({ defer }) {
					defer(() => {
						disposed = true;
					});
					return {};
				},
				async run() {
					return { nested: value };
				},
				async capture() {
					return { stock: 42 };
				},
				checks: [{ id: 'noop', requires: ['stock'], async evaluate() {} }],
				async teardown() {},
			});
			const report = await runEvals([subject]);
			expect(disposed).toBe(true);
			expect(report.samples[0]?.status).not.toBe('passed');
		},
	);

	it('rejects a judge pass that contains a failed required criterion', async () => {
		const check = agentJudge<{ count: number }>({
			id: 'judge',
			rubric: 'Every criterion must pass.',
			requires: ['stock'],
			select: ({ output }) => output,
			judge: async () => ({
				verdict: 'pass',
				explanation: 'Overall pass.',
				evidenceRefs: ['stock'],
				criteria: [
					{ id: 'correct', verdict: 'fail', explanation: 'Wrong.', evidenceRefs: ['stock'] },
				],
			}),
		});
		const report = await runEvals([makeEval([check])]);
		expect(report.samples[0]?.status).not.toBe('passed');
	});

	it('passes cancellation to a directly supplied judge executor', async () => {
		let cancelled = false;
		const check = agentJudge<{ count: number }>({
			id: 'judge',
			rubric: 'Check stock.',
			requires: ['stock'],
			select: ({ output }) => output,
			judge: ({ signal }) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener(
						'abort',
						() => {
							cancelled = true;
							reject(signal.reason);
						},
						{ once: true },
					);
				}),
		});
		const report = await runEvals([makeEval([check])], { timeouts: { check: 5 } });
		expect(cancelled).toBe(true);
		expect(report.samples[0]?.status).not.toBe('passed');
	});
});

it('does not abort successful managed work before capture', async () => {
	const calls: string[] = [];
	const subject = defineEval({
		...makeEval([correct]),
		async setup({ manage }) {
			manage({
				abort() {
					calls.push('abort');
				},
				settle() {
					calls.push('settle');
				},
				dispose() {
					calls.push('dispose');
				},
			});
			return {};
		},
	});
	const report = await runEvals([subject]);
	expect(report.samples[0]?.status).toBe('passed');
	expect(calls).toEqual(['settle', 'dispose']);
});

it('keeps run identities distinct so later runs cannot overwrite old samples', async () => {
	const subject = makeEval([correct]);
	const first = await runEvals([subject]);
	const second = await runEvals([subject]);
	expect(first.samples[0]?.sampleId).not.toBe(second.samples[0]?.sampleId);
});

it('cleans up when an execution error has a non-JSON cause', async () => {
	let disposed = false;
	const subject = defineEval({
		...makeEval([correct]),
		async setup({ defer }) {
			defer(() => {
				disposed = true;
			});
			return {};
		},
		async run(): Promise<{ count: number }> {
			throw new Error('provider failed', { cause: new Error('socket closed') });
		},
	});
	const report = await runEvals([subject]);
	expect(disposed).toBe(true);
	expect(report.samples[0]?.status).toBe('error');
	expect(JSON.stringify(report)).toContain('socket closed');
});

it('contains malformed custom judgments inside grading so cleanup still runs', async () => {
	let disposed = false;
	const malformed: EvalCheck<{ count: number }> = {
		id: 'malformed',
		requires: ['stock'],
		async evaluate() {
			return JSON.parse('{"verdict":"pass"}') as never;
		},
	};
	const subject = defineEval({
		...makeEval([malformed, correct]),
		async setup({ defer }) {
			defer(() => {
				disposed = true;
			});
			return {};
		},
	});
	const report = await runEvals([subject]);
	expect(disposed).toBe(true);
	expect(report.samples[0]?.status).not.toBe('passed');
	expect(report.samples[0]?.checks.at(-1)?.status).toBe('passed');
});

it('halts further samples when a judge ignores cancellation', async () => {
	let executions = 0;
	let release: () => void = () => {};
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const check: EvalCheck<{ count: number }> = {
		id: 'stuck',
		requires: ['stock'],
		async evaluate() {
			await pending;
		},
	};
	const subject = defineEval({
		...makeEval([check]),
		async run() {
			executions += 1;
			return { count: 42 };
		},
	});
	try {
		await runEvals([subject], { samples: 2, timeouts: { check: 5 } });
		expect(executions).toBe(1);
	} finally {
		release();
	}
});

it('gives cleanup a fresh signal when the caller cancels execution', async () => {
	const controller = new AbortController();
	let cleanedWithFreshSignal = false;
	const subject = defineEval({
		...makeEval([correct]),
		async setup({ defer }) {
			defer((signal) => {
				cleanedWithFreshSignal = !signal.aborted;
			});
			return {};
		},
		async run() {
			controller.abort();
			throw new Error('cancelled');
		},
	});
	const report = await runEvals([subject], { signal: controller.signal });
	expect(report.passed).toBe(false);
	expect(cleanedWithFreshSignal).toBe(true);
});

it('isolates each sample input from writes in lifecycle callbacks', async () => {
	const seen: string[] = [];
	const subject = defineEval({
		...makeEval([correct]),
		async setup({ input }) {
			seen.push(input.sku);
			input.sku = 'changed';
			return {};
		},
	});
	const report = await runEvals([subject], { samples: 2 });
	expect(seen).toEqual(['A', 'A']);
	expect(subject.input.sku).toBe('A');
	expect(report.samples.map((sample) => sample.input)).toEqual([{ sku: 'A' }, { sku: 'A' }]);
});

it('retains raw judge output when invalid references prevent a pass', async () => {
	const response = {
		verdict: 'pass' as const,
		explanation: 'Unsupported citation.',
		evidenceRefs: ['invented'],
	};
	const check = agentJudge<{ count: number }>({
		id: 'bad-reference',
		rubric: 'Use stock evidence.',
		requires: ['stock'],
		select: ({ evidence }) => evidence.stock ?? null,
		judge: async () => response,
	});
	const report = await runEvals([makeEval([check])]);
	expect(report.passed).toBe(false);
	expect(report.samples[0]?.checks[0]?.judgment?.rawResponse).toEqual(response);
});

it('does not run another check after an uncooperative check timeout', async () => {
	let laterRan = false;
	let release: () => void = () => {};
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	try {
		const subject = makeEval([
			{
				id: 'stuck-check',
				requires: ['stock'],
				async evaluate() {
					await pending;
				},
			},
			{
				id: 'later-check',
				requires: ['stock'],
				async evaluate() {
					laterRan = true;
				},
			},
		]);
		const report = await runEvals([subject], { timeouts: { check: 5 } });
		expect(report.passed).toBe(false);
		expect(laterRan).toBe(false);
		expect(report.samples[0]?.checks[1]?.status).toBe('skipped');
	} finally {
		release();
	}
});

it('preserves ordinary JSON objects with a value field in captured evidence', async () => {
	const definition = makeEval([
		{
			id: 'plain-object',
			requires: ['stock'],
			async evaluate({ evidence }) {
				assert.deepEqual(evidence.stock, { value: 42 });
			},
		},
	]);
	const report = await runEvals([
		{
			...definition,
			async capture() {
				return { stock: { value: 42 } };
			},
		},
	]);
	expect(report.passed).toBe(true);
	expect(report.samples[0]?.evidence.stock).toEqual({ value: 42 });
});
