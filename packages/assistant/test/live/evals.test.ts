import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createJsonFileStore, createRoomJudge, runEvals } from '@ambionframework/evals';
import { describe, expect, it } from 'vitest';
import { defineAssistant } from '../../src/index.ts';
import {
	expectedSamplesForProfile,
	profileFromEnvironment,
	providerCredential,
	sampleCountForProfile,
} from '../support/evals/profile.ts';
import { retainSources } from '../support/evals/provenance.ts';
import { makeAssistantSimulation, simulationVariants } from './simulation-cases.ts';

const model = process.env.AMBION_MODEL ?? 'anthropic/claude-sonnet-5';
const simulatorModel = process.env.AMBION_SIMULATOR_MODEL ?? model;
const judgeModel = process.env.AMBION_JUDGE_MODEL ?? model;
const profile = profileFromEnvironment(process.env.AMBION_EVAL_PROFILE);
const required = process.env.AMBION_EVAL_REQUIRED === '1';

function missingCredentials(): string[] {
	return [
		...new Set(
			[model, simulatorModel, judgeModel]
				.map(providerCredential)
				.filter((key): key is string => key !== undefined && !process.env[key]),
		),
	];
}

describe('assistant room simulations', () => {
	const missing = missingCredentials();
	if (missing.length > 0) {
		if (required)
			it('requires subject, simulator, and judge credentials', () => {
				throw new Error(`Missing required provider credentials: ${missing.join(', ')}`);
			});
		else it.skip(`live simulations skipped; missing ${missing.join(', ')}`);
		return;
	}

	it(
		`runs ${profile} simulations without subject retries`,
		{ timeout: 7_200_000, retry: 0 },
		async ({ signal }) => {
			const runTag = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
			const output = join(
				process.env.AMBION_EVAL_OUTPUT ?? join(process.cwd(), 'eval-results'),
				'assistant-simulations',
				profile,
				runTag,
			);
			const sourceRevision = await retainSources(output);
			const report = await runEvals(
				simulationVariants.map((variant) => makeAssistantSimulation(variant, { simulatorModel })),
				{
					model,
					signal,
					samplesPerEval: sampleCountForProfile(profile),
					judge: createRoomJudge({ id: 'assistant-simulation-judge', model: judgeModel }),
					artifactStore: createJsonFileStore(output),
					sourceRevision,
					instructionDigest: createHash('sha256')
						.update(defineAssistant({ model }).instructions)
						.digest('hex'),
					metadata: {
						simulatorModel,
						profile,
						calibration: 'Full-trace human review pending; this run does not establish readiness.',
					},
					timeouts: { run: 360_000, settle: 90_000, check: 90_000 },
				},
			);
			expect(report.samples).toHaveLength(expectedSamplesForProfile(profile));
			const failures = report.samples
				.filter((sample) => sample.status !== 'passed')
				.map((sample) => ({
					case: sample.evalId,
					sample: sample.sampleId,
					status: sample.status,
					checks: sample.checks.filter((check) => check.status !== 'passed'),
					errors: sample.errors,
				}));
			expect(failures, `Retained simulation evidence: ${output}`).toEqual([]);
			expect(report.passed).toBe(true);
		},
	);
});
