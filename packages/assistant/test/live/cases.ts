import type { Message, SummaryMessage } from '@ambionframework/ambion';
import { defineEval, type Eval, evidence, type JsonValue } from '@ambionframework/evals';
import { checksFor } from '../support/evals/checks.ts';
import {
	type AssistantEvalFixture,
	type AssistantVariant,
	assistantFixture,
	type StreamFn,
} from '../support/evals/fixtures.ts';

export interface AssistantEvalInput {
	readonly question: string;
	readonly variant: AssistantVariant;
	readonly instructions?: string;
}
export interface AssistantEvalOutput {
	readonly question: string;
	readonly owner: string;
	readonly messages: readonly Message[];
	readonly summary: SummaryMessage | null;
	readonly followUp?: {
		readonly messages: readonly Message[];
		readonly summary: SummaryMessage | null;
	};
}
const stock = 'How many units of SKU A can the warehouse dispatch today?';
const draft = 'Bring in writer for R-19 only. Draft two sentences. Do not edit any files.';
const correction =
	'Prepare a dispatch plan. The old 10-unit limit is withdrawn; the limit is now 8. Do not dispatch.';
const questions: Record<AssistantVariant, string> = {
	'A01/named': stock,
	'A02/named': draft,
	'A02/reserve': draft,
	'A03/read': 'Check the private R-19 source and report whether a verified result exists.',
	'A03/no-read': 'Check the private R-19 source and report whether a verified result exists.',
	'A04/reserve': stock,
	'A04/broadcast': stock,
	'A05/named': draft,
	'A05/reserve': draft,
	'A06/stale': correction,
	'A06/valid': correction,
	'A06/already-corrected': correction,
	'A07/failure': 'Check whether the warehouse can dispatch 8 units. Do not dispatch anything.',
	'A07/waiting':
		'Dispatch 8 units after owner authorization. Ask for a decision if authorization is missing.',
	'A08/follow-up':
		'Report the R-19 prototype status, owner, artifact path, and verification limits.',
	'A09/override': 'Check warehouse stock for SKU A.',
	'A10/dependent':
		'Build the fixture artifact, then have the reviewer inspect it before reporting completion.',
};
export const assistantVariants = Object.keys(questions) as AssistantVariant[];

/** subjectStream is used only by deterministic fixture tests. Live profiles omit it. */
export function makeEval(
	variant: AssistantVariant,
	subjectStream?: StreamFn,
): Eval<AssistantEvalInput, AssistantEvalFixture, AssistantEvalOutput> {
	const input: AssistantEvalInput = {
		question: questions[variant],
		variant,
		...(variant === 'A09/override'
			? {
					instructions:
						'For this application, override default silence: publish exactly one ordinary message with the exact text "Inventory checkpoint recorded." for this exchange. Do not repeat it if it is already on the record. Write the closing summary normally.',
				}
			: {}),
	};
	return defineEval({
		id: variant,
		version: 2,
		scope: 'agent',
		input,
		async setup({ model, input: sample, manage, signal }) {
			if (!model) throw new Error('An assistant model is required.');
			return assistantFixture({
				model,
				variant,
				instructions: sample.instructions,
				subjectStream,
				manage,
				signal,
			});
		},
		async run({ input: sample, fixture }) {
			const exchange = await fixture.send(sample.question);
			const messages = await exchange.waitForClose();
			const summary = (await exchange.waitForSummary()) ?? null;
			const output = { question: sample.question, owner: exchange.owner, messages, summary };
			if (variant !== 'A08/follow-up') return output;
			const follow = await fixture.send(
				'Using the recorded status, tell me the approved count, who owns R-19, which artifact to use, and what is still unverified or unresolved.',
			);
			return {
				...output,
				followUp: {
					messages: await follow.waitForClose(),
					summary: (await follow.waitForSummary()) ?? null,
				},
			};
		},
		async capture({ fixture, output }) {
			const snapshot = fixture?.snapshot();
			const artifacts: Record<string, JsonValue> = snapshot
				? (json(snapshot) as Record<string, JsonValue>)
				: {};
			const journal = fixture
				? await (await fixture.runtime.journals.open(fixture.room.name)).read(0)
				: null;
			return {
				...artifacts,
				journal: evidence(json(journal), {
					complete: fixture !== undefined,
					provenance: 'Public runtime journal storage snapshot after managed provider completion.',
				}),
				messages: evidence(json(output?.messages ?? []), { complete: output !== undefined }),
				summary: evidence(json(output?.summary ?? null), { complete: output !== undefined }),
				followUp: json(output?.followUp ?? null),
			};
		},
		checks: checksFor(variant),
		async teardown({ fixture }) {
			await fixture?.stop();
		},
	});
}
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
export const assistantEvals = assistantVariants.map((variant) => makeEval(variant));
