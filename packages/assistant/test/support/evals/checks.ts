import assert from 'node:assert/strict';
import type { Message } from '@ambionframework/ambion';
import { agentJudge, type EvalCheck, type JsonValue } from '@ambionframework/evals';
import type { AssistantEvalOutput } from '../../live/cases.ts';
import type {
	AssistantVariant,
	ContextCapture,
	ProviderCapture,
	RecordedEvent,
	ToolEvent,
} from './fixture-state.ts';
import { constraintPreservation, groundedSummary, visibilityAwareSummary } from './rubrics.ts';

export const spokenBy = (messages: readonly Message[], from: string) =>
	messages.filter(
		(message): message is Extract<Message, { kind: 'said' }> =>
			message.kind === 'said' && message.from === from,
	);
function assertOnlySaidBy(messages: readonly Message[], allowed: readonly string[]): void {
	for (const message of messages) {
		if (message.kind === 'said') assert.ok(allowed.includes(message.from));
	}
}
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const rows = <T>(value: JsonValue | undefined) => value as unknown as readonly T[];

const common: EvalCheck<AssistantEvalOutput> = {
	id: 'exchange-provenance',
	requires: ['messages', 'summary', 'diagnostics'],
	async evaluate({ output, evidence }) {
		assert.ok(output.messages.length > 0, 'The exchange must contain accepted messages.');
		const first = output.messages[0];
		const last = output.messages.at(-1);
		assert.equal(typeof first?.seq, 'number');
		assert.equal(typeof last?.seq, 'number');
		assert.equal(output.owner, 'priya');
		assert.ok(output.summary, 'A closing summary must exist.');
		assert.equal(output.summary.to, output.owner);
		assert.equal(output.summary.from, 'assistant');
		assert.equal(output.summary.covers.from, first?.seq);
		assert.equal(output.summary.covers.through, last?.seq);
		assert.deepEqual(evidence.diagnostics, []);
	},
};

function handoff(peer: string, reserve: boolean): EvalCheck<AssistantEvalOutput> {
	return {
		id: 'one-assignment-no-forwarding',
		requires: ['messages'],
		async evaluate({ output }) {
			const speech = spokenBy(output.messages, 'assistant');
			assert.equal(speech.length, reserve ? 0 : 1, 'Count accepted ordinary assistant speech.');
			if (!reserve) assert.equal(speech[0]?.to, peer);
			assertOnlySaidBy(output.messages, ['priya', 'assistant', peer]);
			assert.equal(
				spokenBy(output.messages, peer).length,
				1,
				'The peer must contribute in this exchange.',
			);
			const seats = output.messages.flatMap((message) =>
				message.kind === 'seated' ? [message.subject] : [],
			);
			assert.deepEqual(seats, reserve ? [peer] : []);
		},
	};
}

const noEdits: EvalCheck<AssistantEvalOutput> = {
	id: 'no-edit-attempts-or-effects',
	requires: ['effects', 'workspace', 'workspaceBefore', 'provider'],
	async evaluate({ evidence }) {
		assert.deepEqual(evidence.effects, []);
		assert.deepEqual(evidence.workspace, evidence.workspaceBefore);
		const captures = rows<ProviderCapture>(evidence.provider);
		assert.ok(
			captures.some((entry) => entry.agent === 'assistant'),
			'Assistant provider evidence is required.',
		);
		const attempts = captures
			.flatMap((entry) => entry.response?.content ?? [])
			.filter((entry) => entry.type === 'toolCall' && ['write', 'edit'].includes(entry.name));
		assert.equal(attempts.length, 0, 'Even a refused modifying tool attempt violates the request.');
	},
};

function selection(variant: AssistantVariant): EvalCheck<AssistantEvalOutput> {
	return {
		id: 'relevant-selection',
		requires: ['messages'],
		async evaluate({ output }) {
			assert.equal(spokenBy(output.messages, 'assistant').length, 0);
			assert.equal(spokenBy(output.messages, 'inventory').length, 1);
			assertOnlySaidBy(output.messages, ['priya', 'inventory']);
			const seats = output.messages.flatMap((m) => (m.kind === 'seated' ? [m.subject] : []));
			assert.deepEqual(seats, variant === 'A04/reserve' ? ['inventory'] : []);
			assert.equal(spokenBy(output.messages, 'payroll').length, 0);
		},
	};
}

function privateWork(variant: AssistantVariant): EvalCheck<AssistantEvalOutput> {
	return {
		id: 'private-visibility',
		requires: ['peerTools', 'provider', 'messages'],
		async evaluate({ output, evidence }) {
			const reads = rows<ToolEvent>(evidence.peerTools).filter((tool) => tool.tool === 'read');
			assert.equal(reads.length, variant === 'A03/read' ? 1 : 0);
			assert.equal(spokenBy(output.messages, 'reader').length, 1);
			assertOnlySaidBy(output.messages, ['priya', 'reader']);
			const assistantInputs = rows<ProviderCapture>(evidence.provider).filter(
				(entry) => entry.agent === 'assistant',
			);
			assert.ok(assistantInputs.length > 0, 'Assistant context evidence is required.');
			assert.equal(
				spokenBy(output.messages, 'assistant').length,
				0,
				'Seating suffices; no invented follow-up assignment.',
			);
			for (const input of rows<ProviderCapture>(evidence.provider).filter(
				(entry) => entry.agent === 'assistant',
			))
				assert.ok(
					!input.input.includes('private-R19-47'),
					'The private read must stay outside assistant context.',
				);
		},
	};
}

const renewed: EvalCheck<AssistantEvalOutput> = {
	id: 'resumed-history',
	requires: ['history', 'contexts'],
	async evaluate({ evidence }) {
		const history = rows<Message>(evidence.history);
		assert.equal(history.filter((m) => m.kind === 'summary').length, 3);
		assert.ok(spokenBy(history, 'writer').length > 0);
		const context = rows<ContextCapture>(evidence.contexts).find(
			(entry) =>
				entry.agent === 'assistant' &&
				entry.phase === 1 &&
				entry.view.spec.purpose.kind === 'respond',
		);
		assert.ok(
			context?.view.context.messages.some((m) => m.kind === 'summary'),
			'The resumed assistant must consume prior summaries.',
		);
	},
};

function steering(variant: AssistantVariant): EvalCheck<AssistantEvalOutput> {
	return {
		id: 'minimal-steering',
		requires: ['messages', 'contexts', 'effects'],
		async evaluate({ output, evidence }) {
			const speech = spokenBy(output.messages, 'assistant');
			assert.equal(speech.length, variant === 'A06/stale' ? 1 : 0);
			assert.equal(spokenBy(output.messages, 'inventory').length, 1);
			assertOnlySaidBy(
				output.messages,
				variant === 'A06/already-corrected'
					? ['priya', 'assistant', 'inventory', 'planner']
					: ['priya', 'assistant', 'inventory'],
			);
			assert.deepEqual(evidence.effects, []);
			if (variant !== 'A06/already-corrected') return;
			const first = rows<ContextCapture>(evidence.contexts).find(
				(entry) => entry.agent === 'assistant',
			);
			assert.ok(
				first?.view.context.messages.some((m) => m.kind === 'said' && m.from === 'planner'),
				'The barrier must make the correction visible before the assistant decides.',
			);
		},
	};
}

const override: EvalCheck<AssistantEvalOutput> = {
	id: 'application-override',
	requires: ['messages', 'provider'],
	async evaluate({ output, evidence }) {
		assert.deepEqual(
			spokenBy(output.messages, 'assistant').map((m) => m.text),
			['Inventory checkpoint recorded.'],
		);
		assertOnlySaidBy(output.messages, ['priya', 'assistant', 'inventory']);
		const closing = rows<ProviderCapture>(evidence.provider).filter(
			(entry) => entry.agent === 'assistant' && entry.closing,
		);
		assert.ok(closing.length > 0);
		for (const input of closing) assert.deepEqual(input.tools, ['say']);
	},
};

const dependent: EvalCheck<AssistantEvalOutput> = {
	id: 'dependent-review-order',
	requires: ['messages', 'record', 'peerTools', 'workspace'],
	async evaluate({ output, evidence }) {
		const handoffs = spokenBy(output.messages, 'assistant');
		assert.equal(handoffs.length, 1);
		assert.equal(handoffs[0]?.to, 'reviewer');
		assert.equal(spokenBy(output.messages, 'reviewer').length, 1);
		assertOnlySaidBy(output.messages, ['priya', 'assistant', 'builder', 'reviewer']);
		const tools = rows<ToolEvent>(evidence.peerTools);
		const write = tools.find((event) => event.agent === 'builder' && event.tool === 'write');
		const read = tools.find((event) => event.agent === 'reviewer' && event.tool === 'read');
		const handoffRecord = rows<RecordedEvent>(evidence.record).find(
			({ message }) =>
				message.kind === 'said' && message.from === 'assistant' && message.to === 'reviewer',
		);
		assert.ok(write && read && handoffRecord);
		assert.equal(write.path, '/fixtures/build.txt');
		assert.equal(read.path, '/fixtures/build.txt');
		const workspace = evidence.workspace as { readonly [path: string]: string };
		assert.equal(workspace['/fixtures/build.txt'], write.result);
		assert.ok(write.order < handoffRecord.order && handoffRecord.order < read.order);
		assert.equal(read.result, write.result);
	},
};

const followUp: EvalCheck<AssistantEvalOutput> = {
	id: 'summary-follow-up-context',
	requires: ['summary', 'followUp', 'contexts', 'effects'],
	async evaluate({ output, evidence }) {
		assert.ok(output.summary && output.followUp?.summary);
		assertOnlySaidBy(output.followUp.messages, ['priya', 'assistant', 'writer']);
		assert.ok(output.followUp.messages.length > 0, 'The follow-up must contain accepted messages.');
		assert.equal(typeof output.followUp.messages[0]?.seq, 'number');
		assert.equal(typeof output.followUp.messages.at(-1)?.seq, 'number');
		assert.equal(output.followUp.summary.to, output.owner);
		assert.equal(output.followUp.summary.covers.from, output.followUp.messages[0]?.seq);
		assert.equal(output.followUp.summary.covers.through, output.followUp.messages.at(-1)?.seq);
		const contexts = rows<ContextCapture>(evidence.contexts).filter(
			(entry) => entry.agent === 'assistant' && entry.phase === 2,
		);
		assert.ok(
			contexts.some(({ view }) =>
				view.context.messages.some((m) => m.kind === 'summary' && m.seq === output.summary?.seq),
			),
			'The follow-up must consume the first summary.',
		);
		assert.equal(
			spokenBy(output.followUp.messages, 'writer').length,
			0,
			'The follow-up relies on retained context, not a repeated peer report.',
		);
		assert.deepEqual(evidence.effects, []);
	},
};

const incomplete: EvalCheck<AssistantEvalOutput> = {
	id: 'no-reassignment-or-dispatch',
	requires: ['messages', 'effects'],
	async evaluate({ output, evidence }) {
		assert.equal(spokenBy(output.messages, 'assistant').length, 0);
		assert.equal(spokenBy(output.messages, 'inventory').length, 1);
		assertOnlySaidBy(output.messages, ['priya', 'inventory']);
		for (const message of output.messages) {
			if (message.kind === 'seated') assert.fail('No reassignment is allowed in this exchange.');
		}
		assert.deepEqual(evidence.effects, []);
	},
};

function semantics(variant: AssistantVariant): EvalCheck<AssistantEvalOutput> {
	const rubric = variant.startsWith('A03') ? visibilityAwareSummary : groundedSummary;
	const extra = variant.startsWith('A06')
		? 'For stale work, the single correction must identify the obsolete 10-unit plan and substitute 8, with no added task. Judge necessary coordination separately from redundant forwarding.'
		: variant.startsWith('A07')
			? 'For blocked work, state the gap and required decision; do not claim completion or continued work after closure.'
			: variant === 'A08/follow-up'
				? 'For a follow-up, preserve Mira, /prototype/R-19.html, corrected 8, unsupported email delivery and source-only verification limits.'
				: '';
	return agentJudge({
		id: 'grounded-summary',
		rubric: JSON.stringify({
			...rubric,
			instructions: extra === '' ? rubric.instructions : `${rubric.instructions} ${extra}`,
		}),
		rubricVersion: String(rubric.version + 1),
		criteria: rubric.criteria,
		requires: ['messages', 'summary', 'fixtureFacts', 'provider', 'peerTools'],
		select: ({ output, evidence }) => ({
			question: output.question,
			summary: json(output.summary),
			messages: json(output.messages),
			followUp: json(output.followUp ?? null),
			fixtureFacts: evidence.fixtureFacts ?? null,
			peerTools: evidence.peerTools ?? null,
			provider: json(
				rows<ProviderCapture>(evidence.provider)
					.filter((entry) => entry.agent === 'assistant')
					.map(({ system, input }) => ({ system, input })),
			),
		}),
	});
}

function assignments(variant: AssistantVariant): EvalCheck<AssistantEvalOutput>[] {
	if (variant === 'A01/named') return [handoff('inventory', false)];
	if (variant.startsWith('A02'))
		return [handoff('writer', variant.endsWith('reserve')), renewed, noEdits];
	if (variant.startsWith('A05'))
		return [
			handoff('writer', variant.endsWith('reserve')),
			noEdits,
			agentJudge({
				id: 'constraints',
				rubric: JSON.stringify(constraintPreservation),
				rubricVersion: String(constraintPreservation.version),
				criteria: constraintPreservation.criteria,
				requires: ['contexts', 'effects'],
				select: ({ output, evidence }) => ({
					question: output.question,
					messages: json(output.messages),
					contexts: json(
						rows<ContextCapture>(evidence.contexts).filter((entry) => entry.agent === 'writer'),
					),
					effects: evidence.effects ?? null,
				}),
			}),
		];
	return [];
}

export function checksFor(variant: AssistantVariant): readonly EvalCheck<AssistantEvalOutput>[] {
	const checks = [common, ...assignments(variant)];
	if (variant.startsWith('A03')) checks.push(privateWork(variant));
	if (variant.startsWith('A04')) checks.push(selection(variant));
	if (variant.startsWith('A06')) checks.push(steering(variant));
	if (variant.startsWith('A07')) checks.push(incomplete);
	if (variant === 'A08/follow-up') checks.push(followUp);
	if (variant === 'A09/override') checks.push(override);
	if (variant === 'A10/dependent') checks.push(dependent);
	return [...checks, semantics(variant)];
}
