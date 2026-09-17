import { describe, expect, it } from 'vitest';
import { agentJudge, defineEval, runEvals } from '../src/index.ts';
import { buildJudgeInstructions, roomDiagnostic } from '../src/judge.ts';

const makeEval = (check: ReturnType<typeof agentJudge<{ answer: string }>>) =>
	defineEval({
		id: `judge/${check.id}`,
		version: 1,
		scope: 'agent' as const,
		input: { question: 'status?' },
		async setup() {
			return {};
		},
		async run() {
			return { answer: 'ready' };
		},
		async capture() {
			return { trace: 'ready' };
		},
		checks: [check],
		async teardown() {},
	});

describe('agent judge validation', () => {
	it('serializes provider diagnostics without dropping nested or circular causes', () => {
		const primary = new Error('credit exhausted', { cause: new Error('quota reached') });
		(primary.cause as Error).cause = primary;
		expect(roomDiagnostic(primary)).toMatchObject({
			name: 'Error',
			message: 'credit exhausted',
			cause: { name: 'Error', message: 'quota reached', cause: '[Circular Error]' },
		});
	});

	it('builds citation instructions from the sealed collection keys', () => {
		const prompt = buildJudgeInstructions({
			checkId: 'check',
			rubric: 'Use the trace.',
			rubricVersion: 'v1',
			input: {},
			output: {},
			packet: {},
			evidence: { trace: { answer: 'ready' }, summary: { text: 'ok' } },
			signal: new AbortController().signal,
		});
		expect(prompt).toContain('exactly these supplied collection keys: ["summary","trace"]');
		expect(prompt).toContain('cite "summary" exactly');
		expect(prompt).toContain('Do not cite wrapper labels such as "packet", "evidence"');
	});

	it('requires every configured criterion and preserves the raw response', async () => {
		const response = {
			verdict: 'pass' as const,
			explanation: 'Only one criterion was graded.',
			evidenceRefs: ['trace'],
			criteria: [
				{ id: 'first', verdict: 'pass' as const, explanation: 'yes', evidenceRefs: ['trace'] },
			],
		};
		const check = agentJudge<{ answer: string }>({
			id: 'criteria',
			rubric: 'Grade both criteria.',
			criteria: ['first', 'second'],
			requires: ['trace'],
			select: ({ output }) => output,
			judge: async () => response,
		});
		const report = await runEvals([makeEval(check)]);
		const judgment = report.samples[0]?.checks[0]?.judgment;
		expect(judgment?.verdict).toBe('inconclusive');
		expect(judgment?.rawResponse).toEqual(response);
	});

	it('rejects a passing criterion that cites an unknown collection', async () => {
		const response = {
			verdict: 'pass' as const,
			explanation: 'Unsupported citation.',
			evidenceRefs: ['trace'],
			criteria: [
				{ id: 'only', verdict: 'pass' as const, explanation: 'yes', evidenceRefs: ['missing'] },
			],
		};
		const check = agentJudge<{ answer: string }>({
			id: 'refs',
			rubric: 'Grade one criterion.',
			criteria: ['only'],
			requires: ['trace'],
			select: ({ output }) => output,
			judge: async () => response,
		});
		const report = await runEvals([makeEval(check)]);
		expect(report.samples[0]?.checks[0]?.judgment?.verdict).toBe('inconclusive');
	});
});
