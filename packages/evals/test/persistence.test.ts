import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	agentJudge,
	createJsonFileStore,
	createRoomJudge,
	defineEval,
	regradeEvals,
	runEvals,
} from '../src/index.ts';

const subject = defineEval({
	id: 'persistence/subject',
	version: 1,
	scope: 'agent',
	input: { question: 'status?' },
	async setup() {
		return {};
	},
	async run() {
		return { answer: 'ready' };
	},
	async capture() {
		return { trace: ['ready'] };
	},
	checks: [
		agentJudge<{ answer: string }>({
			id: 'meaning',
			rubric: 'The answer says ready.',
			requires: ['trace'],
			select: ({ output, evidence }) => ({ output, evidence }),
			judge: async () => ({
				verdict: 'pass',
				explanation: 'The trace supports the answer.',
				evidenceRefs: ['trace'],
			}),
		}),
	],
	async teardown() {},
});

describe('eval report persistence and regrading', () => {
	it('retains distinct case IDs that sanitize to the same filename and refuses replacement', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ambion-eval-collision-'));
		try {
			const store = createJsonFileStore(directory);
			const report = await runEvals(
				[
					{ ...subject, id: 'inventory/named' },
					{ ...subject, id: 'inventory_named' },
				],
				{ store },
			);
			expect(report.passed).toBe(true);
			expect(await readdir(directory)).toHaveLength(3);
			await expect(store.saveReport(report)).rejects.toMatchObject({ code: 'EEXIST' });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('retains a sample persistence failure as an error', async () => {
		const report = await runEvals([subject], {
			store: {
				async saveSample() {
					throw new Error('disk full');
				},
				async saveReport() {},
			},
		});
		expect(report.samples[0]?.status).toBe('error');
		expect(report.samples[0]?.errors.at(-1)?.phase).toBe('persist');
	});

	it('does not turn an execution failure into a regrade pass', async () => {
		const failed = defineEval({
			...subject,
			id: 'persistence/execution-failure',
			async run() {
				throw new Error('provider unavailable');
			},
		});
		const first = await runEvals([failed]);
		const regraded = await regradeEvals(first, [failed], { gradingId: 'failed-grade' });
		expect(first.samples[0]?.status).toBe('error');
		expect(regraded.samples[0]?.status).toBe('error');
		expect(regraded.passed).toBe(false);
	});

	it('turns an invalid room judge schema into a check error', async () => {
		const invalid = defineEval({
			...subject,
			id: 'persistence/invalid-judge',
			checks: [
				agentJudge<{ answer: string }>({
					id: 'invalid',
					rubric: 'Return a valid judgment.',
					requires: ['trace'],
					select: ({ output }) => output,
				}),
			],
		});
		const report = await runEvals([invalid], {
			judge: createRoomJudge({
				model: 'test/judge',
				execute: async () =>
					({ verdict: 'maybe', explanation: 'bad', evidenceRefs: ['trace'] }) as never,
			}),
		});
		expect(report.samples[0]?.checks[0]?.status).toBe('error');
		expect(report.samples[0]?.status).toBe('error');
	});

	it('retains each run and regrades sealed artifacts without setup', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ambion-evals-'));
		try {
			const store = createJsonFileStore(directory);
			const first = await runEvals([subject], { store, sourceRevision: 'source-a' });
			const second = await runEvals([subject], { store, sourceRevision: 'source-b' });
			expect(first.runId).not.toBe(second.runId);
			expect((await store.loadReport?.(first.runId))?.runId).toBe(first.runId);
			expect((await store.loadReport?.(second.runId))?.runId).toBe(second.runId);
			const regraded = await regradeEvals(first, [subject], {
				store,
				gradingId: 'grade-1',
				sourceRevision: 'grader-b',
			});
			expect(regraded.runId).toBe(first.runId);
			expect(regraded.gradingId).toBe('grade-1');
			expect(regraded.metadata.sourceRevision).toBe('source-a');
			expect(regraded.metadata.gradingSourceRevision).toBe('grader-b');
			expect(regraded.samples[0]?.metadata.gradingSourceRevision).toBe('grader-b');
			expect((await store.loadReport(first.runId))?.gradingId).toBeUndefined();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

it('retains every original sample but halts regrading when a check ignores cancellation', async () => {
	const original = await runEvals([subject], { samples: 2 });
	let calls = 0;
	let release: () => void = () => {};
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	try {
		const graded = await regradeEvals(
			original,
			[
				{
					...subject,
					checks: [
						{
							id: 'stuck',
							requires: ['trace'],
							async evaluate() {
								calls += 1;
								await pending;
							},
						},
					],
				},
			],
			{ timeouts: { check: 5 } },
		);
		expect(calls).toBe(1);
		expect(graded.passed).toBe(false);
		expect(graded.samples).toHaveLength(2);
		expect(graded.samples[1]?.output).toEqual(original.samples[1]?.output);
		expect(graded.samples[1]?.checks[0]?.status).toBe('skipped');
	} finally {
		release();
	}
});
