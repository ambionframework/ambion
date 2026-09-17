import { strict as assert } from 'node:assert';
import { describe, expect, it } from 'vitest';
import { defineEval, type EvalCheck, evidence, runEvals } from '../src/index.ts';

describe('generic eval lifecycle', () => {
	it('captures partial setup and runs deferred cleanup after setup failure', async () => {
		const events: string[] = [];
		const result = await runEvals([
			defineEval({
				id: 'partial-setup',
				version: 1,
				scope: 'room',
				input: { value: 1 },
				async setup({ defer }) {
					defer(() => {
						events.push('cleanup');
					});
					throw new Error('fixture acquisition failed');
				},
				async run() {
					throw new Error('run must not execute');
				},
				async capture({ fixture }) {
					events.push(fixture === undefined ? 'capture-without-fixture' : 'bad-fixture');
					return { trace: evidence(['partial'], { complete: false }) };
				},
				checks: [{ id: 'needs-complete-trace', requires: ['trace'], async evaluate() {} }],
				async teardown({ fixture }) {
					events.push(fixture === undefined ? 'teardown-without-fixture' : 'bad-teardown-fixture');
				},
			}),
		]);
		expect(events).toEqual(['capture-without-fixture', 'teardown-without-fixture', 'cleanup']);
		expect(result.samples[0]?.checks[0]?.status).toBe('skipped');
		expect(result.samples[0]?.status).toBe('error');
	});

	it('cannot pass when a required collection is missing or incomplete', async () => {
		const check: EvalCheck<{ value: number }> = {
			id: 'required',
			requires: ['trace'],
			async evaluate() {},
		};
		const make = (capture: () => Promise<Record<string, never | ReturnType<typeof evidence>>>) =>
			defineEval({
				id: `evidence-${Math.random()}`,
				version: 1,
				scope: 'agent' as const,
				input: { value: 1 },
				async setup() {
					return {};
				},
				async run() {
					return { value: 1 };
				},
				capture,
				checks: [check],
				async teardown() {},
			});
		const report = await runEvals([
			make(async () => ({})),
			make(async () => ({ trace: evidence(['partial'], { complete: false }) })),
		]);
		expect(report.samples.map((sample) => sample.status)).toEqual(['failed', 'failed']);
		expect(report.samples.every((sample) => sample.checks[0]?.status === 'skipped')).toBe(true);
	});

	it('does not acquire a fixture after an already-aborted signal', async () => {
		const controller = new AbortController();
		controller.abort(new Error('caller stopped'));
		let setup = false;
		const report = await runEvals(
			[
				defineEval({
					id: 'pre-aborted',
					version: 1,
					scope: 'agent',
					input: {},
					async setup() {
						setup = true;
						return {};
					},
					async run() {
						return {};
					},
					async capture() {
						return { trace: [] };
					},
					checks: [{ id: 'trace', requires: ['trace'], async evaluate() {} }],
					async teardown() {},
				}),
			],
			{ signal: controller.signal },
		);
		expect(setup).toBe(false);
		expect(report.samples[0]?.status).toBe('error');
	});

	it('runs an agent-shaped fixture without an assistant or summary', async () => {
		const check: EvalCheck<{ answer: string }> = {
			id: 'answer-recorded',
			requires: ['discussion'],
			evaluate({ output, evidence: available }) {
				assert.equal(output.answer, 'inventory: 8');
				assert.deepEqual(available.discussion, ['inventory: 8']);
				return Promise.resolve();
			},
		};
		const result = await runEvals([
			defineEval({
				id: 'inventory-room',
				version: 1,
				scope: 'room',
				input: { question: 'stock?' },
				async setup() {
					return { stopped: false };
				},
				async run({ fixture }) {
					return { answer: 'inventory: 8', fixture };
				},
				async capture() {
					return { discussion: evidence(['inventory: 8'], { provenance: 'room-journal' }) };
				},
				checks: [check],
				async teardown({ fixture }) {
					if (fixture !== undefined) fixture.stopped = true;
				},
			}),
		]);
		expect(result.passed).toBe(true);
		expect(result.samples[0]?.metadata.sourceRevision).toBeUndefined();
	});

	it('preserves assertion failures and runs every eligible check', async () => {
		const seen: string[] = [];
		const result = await runEvals([
			defineEval({
				id: 'failed-assertion',
				version: 1,
				scope: 'agent',
				input: { value: 1 },
				async setup() {
					return {};
				},
				async run() {
					return { value: 1 };
				},
				async capture() {
					return { trace: ['captured'] };
				},
				checks: [
					{
						id: 'fails',
						requires: ['trace'],
						async evaluate() {
							assert.equal(1, 2);
						},
					},
					{
						id: 'still-runs',
						requires: ['trace'],
						async evaluate() {
							seen.push('ran');
						},
					},
				],
				async teardown() {},
			}),
		]);
		expect(seen).toEqual(['ran']);
		expect(result.samples[0]?.checks[0]?.status).toBe('failed');
		expect(result.samples[0]?.status).toBe('failed');
		expect(result.samples[0]?.errors).toHaveLength(0);
	});
});
