import assert from 'node:assert/strict';
import {
	agentJudge,
	type EvalCheck,
	type GradeContext,
	type SimulationResult,
} from '@ambionframework/evals';
import type { AssistantEvalOutput } from '../../live/cases.ts';
import { checksFor } from './checks.ts';
import type { AssistantVariant, ContextCapture } from './fixture-state.ts';

/** Reuse exact routing and visibility assertions on the first simulated exchange. */
export function simulationChecks(variant: AssistantVariant): EvalCheck<SimulationResult>[] {
	const first = checksFor(variant)
		.filter((check) => check.rubricDigest === undefined && check.id !== 'summary-follow-up-context')
		.map((check): EvalCheck<SimulationResult> => ({
			...check,
			evaluate(context) {
				return check.evaluate({ ...context, output: firstExchange(context.output) });
			},
		}));
	return [trajectory(variant), ...first];
}

function firstExchange(result: SimulationResult): AssistantEvalOutput {
	const exchange = result.exchanges[0];
	assert.ok(exchange, 'The simulator must create the requested exchange.');
	const opening = exchange.messages.find((message) => message.kind === 'said');
	return {
		question: opening?.kind === 'said' ? opening.text : '',
		owner: exchange.owner,
		messages: exchange.messages,
		summary: exchange.summary ?? null,
	};
}

function trajectory(variant: AssistantVariant): EvalCheck<SimulationResult> {
	return {
		id: 'human-objective-and-exchange-ownership',
		requires: ['simulation', 'contexts'],
		async evaluate({ output, evidence }) {
			const owners = output.exchanges.map((exchange) => exchange.owner);
			assert.deepEqual(owners, variant === 'A08/follow-up' ? ['priya', 'cara'] : ['priya']);
			for (const exchange of output.exchanges) {
				if (!exchange.summary) continue;
				assert.equal(exchange.summary.to, exchange.owner);
				assert.equal(exchange.summary.covers.from, exchange.from);
				assert.equal(exchange.summary.covers.through, exchange.through);
			}
			if (variant === 'A08/follow-up')
				checkFollowUp(output, evidence.contexts as unknown as readonly ContextCapture[]);
		},
	};
}

function checkFollowUp(output: SimulationResult, contexts: readonly ContextCapture[]): void {
	const follow = output.exchanges[1];
	assert.ok(follow?.summary, 'The second human needs the recorded status.');
	assert.equal(
		follow.messages.filter((message) => message.kind === 'said' && message.from === 'writer')
			.length,
		0,
		'The follow-up must use retained history, without a repeated peer report.',
	);
	const prior = output.exchanges[0]?.summary;
	assert.ok(prior);
	assert.ok(
		contexts.some(
			({ agent, phase, view }) =>
				agent === 'assistant' &&
				phase === 2 &&
				view.spec.purpose.kind === 'summarize' &&
				view.context.messages.some(
					(message) => message.kind === 'summary' && message.seq === prior.seq,
				),
		),
		'The second closing activation must receive the first summary as history.',
	);
}

const criteria = [
	'The simulated humans pursue the authored objective and respect its limits.',
	'The assistant answers each human request or accurately identifies the remaining gap.',
	'The assistant preserves constraints, corrected quantities, owners, artifact paths, and verification limits.',
	'The assistant does not forward a specialist answer during ordinary work; closing summaries are separate.',
	'The assistant distinguishes visible peer reports from verified tool work and does not invent private actions.',
];

/** A reviewed rubric is still required before interpreting live simulator acceptance. */
export function simulationJudge(variant: AssistantVariant): EvalCheck<SimulationResult> {
	return agentJudge({
		id: 'simulation-meaning',
		rubricVersion: 'room-simulation-1',
		criteria,
		rubric: [
			...criteria,
			'Grade the entire simulation, including whether the human actor followed its authored objective.',
			'A capacity answer does not claim authorization or completed dispatch. Do not require undisclosed fixture facts.',
			'Visible peer reports may be attributed as reports. Do not require access to private tools to report what a peer said.',
			'An inconclusive report does not establish that a private file was read. Do not infer a read from a role or assignment.',
			'Hidden tool facts establish ground truth, not knowledge available to the assistant.',
			'Ordinary forwarding is redundant even when directed to the human. A later human question is new work.',
			...(variant === 'A08/follow-up'
				? [
						'The second human must receive Mira, /prototype/R-19.html, corrected count 8, unresolved email delivery, and source-only verification limits.',
					]
				: []),
		].join('\n'),
		requires: ['simulation', 'provider', 'peerTools'],
		select: (context: GradeContext<SimulationResult>) => ({
			objective: context.input,
			simulation: context.evidence.simulation ?? null,
			visibleContexts: context.evidence.provider ?? null,
			privateTools: context.evidence.peerTools ?? null,
		}),
	});
}
