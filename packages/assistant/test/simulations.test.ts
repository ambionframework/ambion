import {
	type HumanSimulator,
	type Judgment,
	runEvals,
	type SimulationResult,
} from '@ambionframework/evals';
import { expect, it } from 'vitest';
import { makeEval } from './live/cases.ts';
import {
	makeAssistantSimulation,
	type SimulationVariant,
	simulationVariants,
} from './live/simulation-cases.ts';
import { scriptedSubject } from './support/evals/scripted-subject.ts';

function scriptedHuman(variant: SimulationVariant): HumanSimulator {
	return {
		async decide({ actions, observation }) {
			expect(observation.exchange).toBeUndefined();
			if (actions.length === 0)
				return { action: { kind: 'say', human: 'priya', text: makeEval(variant).input.question } };
			if (variant === 'A08/follow-up' && actions.length === 1)
				return {
					action: {
						kind: 'say',
						human: 'cara',
						text: 'Using the recorded status, tell me the approved count, owner, artifact path, and what remains unverified or unresolved.',
					},
				};
			return { action: { kind: 'finish', reason: 'The requested interaction is complete.' } };
		},
	};
}

/** This stub tests lifecycle wiring; it does not establish semantic quality. */
async function passingJudge({ rubric }: { rubric: string }): Promise<Judgment> {
	const criteria: string[] = JSON.parse(rubric.split('Required criteria IDs (JSON): ')[1] ?? '[]');
	return {
		verdict: 'pass',
		explanation: 'Harness-only stub.',
		evidenceRefs: ['simulation'],
		criteria: criteria.map((id) => ({
			id,
			verdict: 'pass',
			explanation: 'Harness-only stub.',
			evidenceRefs: ['simulation'],
		})),
	};
}

it.each(simulationVariants)(
	'runs %s through human decisions, room settlement, and sealed checks',
	async (variant) => {
		const definition = makeAssistantSimulation(variant, {
			simulatorModel: 'scripted/human',
			simulator: scriptedHuman(variant),
			subjectStream: scriptedSubject(variant),
		});
		const report = await runEvals([definition], {
			model: 'scripted/assistant',
			judge: { execute: passingJudge },
		});
		expect(report.passed, JSON.stringify(report.samples[0]?.checks)).toBe(true);
		const output = report.samples[0]?.output as unknown as SimulationResult;
		expect(output.termination.status).toBe('finished');
		expect(output.exchanges.map((exchange) => exchange.owner)).toEqual(
			variant === 'A08/follow-up' ? ['priya', 'cara'] : ['priya'],
		);
	},
	30_000,
);

it('rejects a human simulator that omits the second human objective even when its judge passes', async () => {
	const definition = makeAssistantSimulation('A08/follow-up', {
		simulatorModel: 'scripted/human',
		simulator: scriptedHuman('A01/named'),
		subjectStream: scriptedSubject('A08/follow-up'),
	});
	const report = await runEvals([definition], {
		model: 'scripted/assistant',
		judge: { execute: passingJudge },
	});
	expect(report.passed).toBe(false);
	expect(
		report.samples[0]?.checks.find((check) => check.id === 'human-objective-and-exchange-ownership')
			?.status,
	).toBe('failed');
});
