import { runEvals } from '@ambionframework/evals';
import { expect, it } from 'vitest';
import { assistantVariants, makeEval } from './live/cases.ts';
import { scriptedSubject } from './support/evals/scripted-subject.ts';

it.each(assistantVariants)(
	'exercises %s through the real room and strict checks',
	async (variant) => {
		const definition = makeEval(variant, scriptedSubject(variant));
		const report = await runEvals(
			[
				{
					...definition,
					checks: definition.checks.filter((check) => check.rubricDigest === undefined),
				},
			],
			{
				model: 'scripted/assistant',
				timeouts: {
					setup: 5_000,
					run: 5_000,
					settle: 5_000,
					capture: 5_000,
					teardown: 5_000,
					cleanup: 5_000,
				},
			},
		);
		expect(
			report.passed,
			JSON.stringify({ errors: report.samples[0]?.errors, checks: report.samples[0]?.checks }),
		).toBe(true);
	},
	40_000,
);
