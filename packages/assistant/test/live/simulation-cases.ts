import { defineHuman } from '@ambionframework/ambion';
import {
	createHumanSimulator,
	defineRoomEval,
	evidence,
	type HumanSimulator,
	type JsonValue,
} from '@ambionframework/evals';
import { assistantFixture, type StreamFn } from '../support/evals/fixtures.ts';
import { simulationChecks, simulationJudge } from '../support/evals/simulation-checks.ts';
import { makeEval } from './cases.ts';

export const simulationVariants = [
	'A01/named',
	'A02/named',
	'A03/read',
	'A03/no-read',
	'A08/follow-up',
] as const;
export type SimulationVariant = (typeof simulationVariants)[number];

const priya = defineHuman({ name: 'priya', identity: 'Owns the initial request.' });
const cara = defineHuman({ name: 'cara', identity: 'Needs to act on the recorded R-19 status.' });

export function simulationObjective(variant: SimulationVariant): string {
	const first = makeEval(variant).input.question;
	return [
		`Represent Priya. Her objective is: ${first}`,
		'Ask for that work once in your own words, preserving every constraint. Read the result before finishing.',
		'Do not coach the assistant, reveal expected checks, authorize additional work, or retry a failed task.',
		...(variant === 'A08/follow-up'
			? [
					'After Priya receives a result, represent Cara. Cara has read the room record.',
					'Cara asks once for the approved count, who owns R-19, the artifact path, and what remains unverified or unresolved.',
					'After Cara receives a result, finish. An incomplete result is also a reason to finish; do not repair it for the room.',
				]
			: ['After the room answers or reports a gap, finish without further human messages.']),
	].join('\n');
}

export function makeAssistantSimulation(
	variant: SimulationVariant,
	options: { simulatorModel: string; simulator?: HumanSimulator; subjectStream?: StreamFn },
) {
	const objective = simulationObjective(variant);
	return defineRoomEval({
		id: `assistant-simulation/${variant}`,
		version: 1,
		input: { objective, variant, simulatorModel: options.simulatorModel },
		humans: variant === 'A08/follow-up' ? [priya, cara] : [priya],
		simulator:
			options.simulator ??
			createHumanSimulator({ model: options.simulatorModel, instructions: objective }),
		limits: { maxActions: variant === 'A08/follow-up' ? 2 : 1, settleTimeoutMs: 90_000 },
		async setup(context) {
			if (!context.model) throw new Error('A subject model is required.');
			const fixture = await assistantFixture({
				model: context.model,
				variant,
				manage: context.manage,
				signal: context.signal,
				subjectStream: options.subjectStream,
			});
			return { room: fixture.room, fixture };
		},
		beforeAction({ fixture, action }) {
			if (action.kind === 'say') fixture.state.phase += 1;
		},
		async capture({ fixture, result }) {
			const snapshot = fixture?.snapshot();
			const first = result?.exchanges[0];
			return {
				...(snapshot ? (json(snapshot) as Record<string, JsonValue>) : {}),
				messages: evidence(json(first?.messages ?? []), { complete: result !== undefined }),
				summary: evidence(json(first?.summary ?? null), { complete: result !== undefined }),
				journal: evidence(
					json(
						fixture ? await (await fixture.runtime.journals.open(fixture.room.name)).read(0) : null,
					),
					{
						complete: fixture !== undefined,
						provenance: 'Subject room journal after the simulation settles.',
					},
				),
			};
		},
		checks: simulationChecks(variant),
		judge: simulationJudge(variant),
		async teardown({ fixture }) {
			await fixture?.stop();
		},
	});
}

const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
