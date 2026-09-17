import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	agentJudge,
	defineEval,
	type EvalReport,
	type JudgeExecutor,
	type Judgment,
	runEvals,
} from '@ambionframework/evals';
import { type AssistantRubric, type CalibrationExample, calibrationExamples } from './rubrics.ts';

export const calibrationProvenance = 'suite-authored expected labels; pending human review';
export interface CalibrationResult {
	readonly exampleId: string;
	readonly rubric: string;
	readonly expected: CalibrationExample['label'];
	readonly observed: Judgment['verdict'];
	readonly disagreement: boolean;
	readonly reviewRequired: boolean;
	readonly explanation: string;
}
interface CalibrationPacket {
	readonly answer: string;
	readonly evidence: string;
}

export interface CalibrationReport {
	readonly provenance: typeof calibrationProvenance;
	readonly examples: readonly CalibrationResult[];
	readonly disagreements: readonly CalibrationResult[];
	readonly grading: EvalReport;
}

/** The production check path also grades calibration; labels stay outside judge input. */
export async function runCalibration(
	execute: JudgeExecutor,
	model?: string,
	signal?: AbortSignal,
): Promise<CalibrationReport> {
	const definitions = calibrationExamples.map((example) =>
		defineEval<CalibrationPacket, object, CalibrationPacket>({
			id: `calibration/${example.id}`,
			version: 1,
			scope: 'agent',
			input: { answer: example.answer, evidence: example.evidence },
			async setup() {
				return {};
			},
			async run({ input }) {
				return input;
			},
			async capture({ output }) {
				return { answer: output?.answer ?? '', evidence: output?.evidence ?? '' };
			},
			checks: [
				agentJudge({
					id: `calibration/${example.id}`,
					rubric: example.rubric,
					criteria: (JSON.parse(example.rubric) as AssistantRubric).criteria,
					requires: ['answer', 'evidence'],
					select: ({ evidence }) => ({
						answer: evidence.answer ?? null,
						evidence: evidence.evidence ?? null,
					}),
				}),
			],
			async teardown() {},
		}),
	);
	const grading = await runEvals(definitions, {
		judge: { id: 'calibration-judge', model, execute },
		signal,
		timeouts: { check: 30_000 },
	});
	const examples = calibrationExamples.map((example): CalibrationResult => {
		const sample = grading.samples.find((item) => item.evalId === `calibration/${example.id}`);
		const check = sample?.checks[0];
		const observed = check?.judgment?.verdict ?? 'inconclusive';
		return {
			exampleId: example.id,
			rubric: example.rubric,
			expected: example.label,
			observed,
			disagreement: observed !== example.label,
			reviewRequired: observed !== example.label,
			explanation:
				check?.judgment?.explanation ??
				check?.error?.message ??
				sample?.errors[0]?.message ??
				'Calibration did not produce a valid judgment.',
		};
	});
	return {
		provenance: calibrationProvenance,
		examples,
		disagreements: examples.filter((example) => example.disagreement),
		grading,
	};
}

export async function persistCalibrationReport(
	directory: string,
	report: CalibrationReport,
): Promise<void> {
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, 'calibration.json'), JSON.stringify(report, null, 2));
}
