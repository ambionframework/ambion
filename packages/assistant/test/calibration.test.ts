import type { JudgeExecutor } from '@ambionframework/evals';
import { expect, it } from 'vitest';
import { calibrationProvenance, runCalibration } from './support/evals/calibration.ts';
import { calibrationExamples } from './support/evals/rubrics.ts';

it('retains suite-authored calibration labels and explicit review provenance', () => {
	const ids = calibrationExamples.map((example) => example.id);
	expect(new Set(ids).size).toBe(ids.length);
	expect(calibrationExamples).toHaveLength(11);
	for (const example of calibrationExamples) {
		expect(example.reason.length).toBeGreaterThan(0);
		expect(example.rubric.length).toBeGreaterThan(0);
	}
	expect(calibrationProvenance).toContain('pending human review');
});

it('records judge disagreement without relabeling the authored baseline', async () => {
	const judge: JudgeExecutor = async ({ checkId, rubric }) => {
		const verdict = checkId.endsWith('grounded-pass') ? 'fail' : 'inconclusive';
		return {
			verdict,
			explanation: 'Calibration stub result.',
			evidenceRefs: ['answer'],
			criteria: rubricCriteria(rubric).map((id) => ({
				id,
				verdict,
				explanation: 'Calibration stub criterion result.',
				evidenceRefs: ['answer'],
			})),
		};
	};
	const report = await runCalibration(judge, 'scripted/judge');
	const disagreement = report.disagreements.find(
		(example) => example.exampleId === 'grounded-pass',
	);
	expect(report.provenance).toBe(calibrationProvenance);
	expect(disagreement).toMatchObject({
		expected: 'pass',
		observed: 'fail',
		disagreement: true,
		reviewRequired: true,
	});
	const incomplete = report.examples.find((example) => example.exampleId === 'grounded-incomplete');
	expect(incomplete?.expected).toBe('fail');
	const noReadGuess = report.examples.find(
		(example) => example.exampleId === 'visibility-no-read-guess',
	);
	expect(noReadGuess?.expected).toBe('fail');
});

it('records an aborted calibration call as inconclusive for every remaining example', async () => {
	const controller = new AbortController();
	const judge: JudgeExecutor = async () => {
		controller.abort();
		return new Promise<never>(() => {});
	};
	const report = await runCalibration(judge, 'scripted/judge', controller.signal);
	expect(report.examples).toHaveLength(11);
	expect(report.examples.every((example) => example.observed === 'inconclusive')).toBe(true);
});

function rubricCriteria(rubric: string): readonly string[] {
	const match = rubric.match(/"criteria"\s*:\s*(\[[^\]]*\])/u);
	const encoded = match?.[1];
	return encoded === undefined ? [] : (JSON.parse(encoded) as readonly string[]);
}
