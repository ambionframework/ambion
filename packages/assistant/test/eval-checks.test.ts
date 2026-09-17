import type { Message } from '@ambionframework/ambion';
import type { EvalCheck, GradeContext, JsonValue, Judgment } from '@ambionframework/evals';
import { expect, it } from 'vitest';
import { type AssistantEvalOutput, assistantVariants } from './live/cases.ts';
import { checksFor } from './support/evals/checks.ts';
import type {
	AssistantVariant,
	ContextCapture,
	ProviderCapture,
	RecordedEvent,
	ToolEvent,
} from './support/evals/fixture-state.ts';

const signal = new AbortController().signal;

it('rejects one intentionally invalid strict output or evidence packet for every variant', async () => {
	for (const variant of assistantVariants) {
		const check = strictCheck(variant);
		const { output, evidence } = invalidPacket(variant, check.id);
		let result: Judgment | undefined;
		let rejected = false;
		try {
			const evaluated = await evaluate(check, output, evidence);
			result = evaluated === undefined ? undefined : evaluated;
		} catch (error) {
			void error;
			rejected = true;
		}
		expect(
			rejected || result?.verdict === 'fail' || result?.verdict === 'inconclusive',
			`${variant}/${check.id}`,
		).toBe(true);
	}
});

it('keeps every semantic judge negative when the judge rejects the packet', async () => {
	for (const variant of assistantVariants) {
		const check = checksFor(variant).at(-1);
		if (check === undefined) throw new Error(`No semantic check for ${variant}.`);
		const packet = validPacket(variant);
		const result = await evaluate(check, packet.output, packet.evidence, {
			async execute({ rubric }): Promise<Judgment> {
				const criteria = rubricCriteria(rubric).map((id) => ({
					id,
					verdict: 'fail' as const,
					explanation: 'The intentionally misleading summary is unsupported.',
					evidenceRefs: ['messages'],
				}));
				return {
					verdict: 'fail',
					explanation: 'The intentionally misleading summary is unsupported.',
					evidenceRefs: ['messages'],
					criteria,
				};
			},
		});
		expect(result?.verdict, variant).toBe('fail');
	}
});

it('scopes semantic rubric additions to the variants that need them', async () => {
	const seen: string[] = [];
	const judge: NonNullable<GradeContext<AssistantEvalOutput>['judge']> = {
		async execute({ rubric }): Promise<Judgment> {
			seen.push(rubric);
			const criteria = rubricCriteria(rubric).map((id) => ({
				id,
				verdict: 'pass' as const,
				explanation: 'The fixture evidence supports this criterion.',
				evidenceRefs: ['messages'],
			}));
			return {
				verdict: 'pass',
				explanation: 'The fixture evidence supports the summary.',
				evidenceRefs: ['messages'],
				criteria,
			};
		},
	};
	for (const variant of ['A03/read', 'A08/follow-up'] as const) {
		const check = checksFor(variant).at(-1);
		if (check === undefined) throw new Error(`No semantic check for ${variant}.`);
		const packet = validPacket(variant);
		await evaluate(check, packet.output, packet.evidence, judge);
	}
	const a03 = seen[0];
	if (a03 === undefined) throw new Error('A03 semantic rubric was not captured.');
	const a08 = seen.at(-1);
	if (a08 === undefined) throw new Error('A08 semantic rubric was not captured.');
	expect(a03).not.toContain('Mira');
	expect(a03).not.toContain('/prototype/R-19.html');
	expect(a03).toContain('private');
	expect(a08).toContain('Mira');
	expect(a08).toContain('/prototype/R-19.html');
});

it('rejects strengthened checks when their required evidence is vacuous', async () => {
	const commonPacket = validPacket('A01/named');
	commonPacket.output = { ...commonPacket.output, messages: [] };
	await expectRejected(
		checksFor('A01/named').find((check) => check.id === 'exchange-provenance'),
		commonPacket,
		'A01 common provenance must reject an empty exchange',
	);

	const noEditsPacket = validPacket('A05/named');
	noEditsPacket.evidence.provider = [];
	await expectRejected(
		checksFor('A05/named').find((check) => check.id === 'no-edit-attempts-or-effects'),
		noEditsPacket,
		'A05 no-edits must require assistant provider evidence',
	);

	const privatePacket = validPacket('A03/read');
	privatePacket.evidence.peerTools = json([tool('read', 'reader', false)]);
	privatePacket.evidence.provider = [];
	await expectRejected(
		checksFor('A03/read').find((check) => check.id === 'private-visibility'),
		privatePacket,
		'A03 visibility must require assistant context evidence',
	);

	const resumedPacket = validPacket('A02/named');
	resumedPacket.evidence.history = json([
		summary(10, 1, 2),
		said(11, 'writer', 'Draft.', 'assistant'),
		summary(12, 3, 4),
		summary(13, 5, 6),
	]);
	resumedPacket.evidence.contexts = json([
		{
			agent: 'assistant',
			phase: 0,
			view: {
				spec: { purpose: { kind: 'respond' } },
				context: { messages: [summary(10, 1, 2)] },
			},
		},
	]);
	await expectRejected(
		checksFor('A02/named').find((check) => check.id === 'resumed-history'),
		resumedPacket,
		'A02 history must come from the resumed phase',
	);

	const followUpPacket = validPacket('A08/follow-up');
	const followUpOutput = {
		...followUpPacket.output,
		followUp: { messages: [], summary: summary(4, 4, 4) },
	};
	await expectRejected(
		checksFor('A08/follow-up').find((check) => check.id === 'summary-follow-up-context'),
		{ ...followUpPacket, output: followUpOutput },
		'A08 follow-up must require accepted messages',
	);

	const participantPacket = validPacket('A01/named');
	const participantOutput = {
		...participantPacket.output,
		messages: [
			said(1, 'priya', 'Request.', undefined),
			said(2, 'assistant', 'Check inventory.', 'inventory'),
			said(3, 'inventory', '8 units.', 'assistant'),
			said(4, 'payroll', 'Unrelated.', 'assistant'),
		],
	};
	await expectRejected(
		checksFor('A01/named').find((check) => check.id === 'one-assignment-no-forwarding'),
		{ ...participantPacket, output: participantOutput },
		'A01 handoff must reject unrelated participants',
	);

	const dependentPacket = validPacket('A10/dependent');
	const dependentOutput = {
		...dependentPacket.output,
		messages: [
			said(1, 'priya', 'Request.', undefined),
			said(2, 'assistant', 'Review.', 'reviewer'),
			said(3, 'reviewer', 'Reviewed.', 'assistant'),
		],
	};
	dependentPacket.evidence.peerTools = json([
		tool('write', 'builder', false),
		tool('read', 'reviewer', false),
	]);
	dependentPacket.evidence.record = json([
		record(1, said(1, 'builder', 'Built.', 'assistant')),
		record(2, said(2, 'assistant', 'Review.', 'reviewer')),
		record(3, said(3, 'reviewer', 'Reviewed.', 'assistant')),
	]);
	dependentPacket.evidence.workspace = json({ '/fixtures/other.txt': 'result' });
	await expectRejected(
		checksFor('A10/dependent').find((check) => check.id === 'dependent-review-order'),
		{ ...dependentPacket, output: dependentOutput },
		'A10 dependency check must require the named artifact path',
	);
});

const strictIds: Partial<Record<AssistantVariant, string>> = {
	'A01/named': 'one-assignment-no-forwarding',
	'A02/named': 'resumed-history',
	'A02/reserve': 'resumed-history',
	'A03/read': 'private-visibility',
	'A03/no-read': 'private-visibility',
	'A04/reserve': 'relevant-selection',
	'A04/broadcast': 'relevant-selection',
	'A05/named': 'no-edit-attempts-or-effects',
	'A05/reserve': 'no-edit-attempts-or-effects',
	'A06/stale': 'minimal-steering',
	'A06/valid': 'minimal-steering',
	'A06/already-corrected': 'minimal-steering',
	'A07/failure': 'no-reassignment-or-dispatch',
	'A07/waiting': 'no-reassignment-or-dispatch',
	'A08/follow-up': 'summary-follow-up-context',
	'A09/override': 'application-override',
	'A10/dependent': 'dependent-review-order',
};

function strictCheck(variant: AssistantVariant): EvalCheck<AssistantEvalOutput> {
	const id = strictIds[variant];
	if (id === undefined) throw new Error(`No strict check mapping for ${variant}.`);
	const check = checksFor(variant).find((candidate) => candidate.id === id);
	if (check === undefined) throw new Error(`Missing strict check ${id} for ${variant}.`);
	return check;
}

async function expectRejected(
	check: EvalCheck<AssistantEvalOutput> | undefined,
	packet: ReturnType<typeof validPacket>,
	label: string,
): Promise<void> {
	if (check === undefined) throw new Error(`Missing check for ${label}.`);
	let result: Judgment | undefined;
	let rejected = false;
	try {
		const evaluated = await evaluate(check, packet.output, packet.evidence);
		result = evaluated === undefined ? undefined : evaluated;
	} catch (error) {
		void error;
		rejected = true;
	}
	expect(rejected || result?.verdict === 'fail' || result?.verdict === 'inconclusive', label).toBe(
		true,
	);
}

function rubricCriteria(rubric: string): readonly string[] {
	const match = rubric.match(/"criteria"\s*:\s*(\[[^\]]*\])/u);
	const encoded = match?.[1];
	return encoded === undefined ? [] : (JSON.parse(encoded) as readonly string[]);
}

function invalidPacket(variant: AssistantVariant, checkId: string) {
	const packet = validPacket(variant);
	const output: {
		question: string;
		owner: string;
		messages: Message[];
		summary: Extract<Message, { kind: 'summary' }>;
		followUp?: AssistantEvalOutput['followUp'];
	} = {
		question: packet.output.question,
		owner: packet.output.owner,
		messages: [...packet.output.messages],
		summary: packet.output.summary as Extract<Message, { kind: 'summary' }>,
		followUp: packet.output.followUp,
	};
	const evidence = structuredClone(packet.evidence);
	if (checkId === 'one-assignment-no-forwarding')
		output.messages = [
			said(1, 'assistant', 'Here is the result.', undefined),
			said(2, 'inventory', '8 units.', 'assistant'),
		];
	if (checkId === 'resumed-history') evidence.history = [];
	if (checkId === 'private-visibility')
		evidence.peerTools = json(variant === 'A03/read' ? [] : [tool('read', 'reader', false)]);
	if (checkId === 'relevant-selection')
		output.messages = [
			said(1, 'assistant', 'Inventory says 8 units.', undefined),
			said(2, 'inventory', '8 units.', 'assistant'),
		];
	if (checkId === 'no-edit-attempts-or-effects')
		evidence.effects = json([tool('write', 'writer', true)]);
	if (checkId === 'minimal-steering')
		output.messages =
			variant === 'A06/stale' ? [] : [said(1, 'assistant', 'Unneeded correction.', undefined)];
	if (checkId === 'no-reassignment-or-dispatch')
		output.messages = [
			said(1, 'assistant', 'Dispatch complete.', undefined),
			said(2, 'inventory', 'Unavailable.', 'assistant'),
		];
	if (checkId === 'summary-follow-up-context') output.followUp = undefined;
	if (checkId === 'application-override')
		output.messages = [said(1, 'assistant', 'Wrong checkpoint.', undefined)];
	if (checkId === 'dependent-review-order')
		evidence.record = json([
			record(2, said(1, 'assistant', 'Review.', 'reviewer')),
			record(1, said(2, 'builder', 'Built.', 'assistant')),
		]);
	return { output: output as AssistantEvalOutput, evidence };
}

function validPacket(variant: AssistantVariant) {
	const messages: Message[] = [
		said(1, 'priya', 'Request.', undefined),
		said(2, peerFor(variant), 'Evidence.', 'assistant'),
	];
	const output: AssistantEvalOutput = {
		question: 'Request.',
		owner: 'priya',
		messages,
		summary: summary(3, 1, 2),
	};
	const contexts: ContextCapture[] = [];
	const provider: ProviderCapture[] = [
		{
			agent: 'assistant',
			phase: 1,
			closing: false,
			tools: ['say'],
			system: '',
			input: '',
			model: 'scripted/assistant',
		},
	];
	const evidence: Record<string, JsonValue> = {
		messages: JSON.parse(JSON.stringify(messages)),
		summary: JSON.parse(JSON.stringify(output.summary)),
		diagnostics: [],
		history: [summary(10, 1, 2), summary(11, 3, 4), summary(12, 5, 6)] as unknown as JsonValue,
		contexts: json(contexts),
		provider: json(provider),
		peerTools: [],
		effects: [],
		workspace: { '/fixtures/R-19.md': 'x' },
		workspaceBefore: { '/fixtures/R-19.md': 'x' },
		fixtureFacts: { result: 'recorded' },
		record: [],
		followUp: null,
	};
	return { output, evidence };
}

async function evaluate(
	check: EvalCheck<AssistantEvalOutput>,
	output: AssistantEvalOutput,
	evidence: Record<string, JsonValue>,
	judge?: GradeContext<AssistantEvalOutput>['judge'],
) {
	const collections = Object.fromEntries(
		Object.keys(evidence).map((kind) => [
			kind,
			{ kind, value: evidence[kind] ?? null, complete: true, refs: [kind] },
		]),
	);
	return check.evaluate({
		evalId: 'negative',
		sampleId: 'sample',
		attemptId: 'attempt',
		input: 'Request.',
		output,
		signal,
		evidence,
		collections,
		judge,
	});
}

function peerFor(variant: AssistantVariant): string {
	if (variant.startsWith('A02') || variant.startsWith('A05') || variant === 'A08/follow-up')
		return 'writer';
	if (variant.startsWith('A03')) return 'reader';
	if (variant === 'A10/dependent') return 'reviewer';
	return 'inventory';
}

function said(
	seq: number,
	from: string,
	text: string,
	to: string | undefined,
): Extract<Message, { kind: 'said' }> {
	return {
		kind: 'said',
		seq,
		from,
		text,
		at: new Date(0).toISOString(),
		...(to === undefined ? {} : { to }),
	};
}

function summary(
	seq: number,
	from: number,
	through: number,
): Extract<Message, { kind: 'summary' }> {
	return {
		kind: 'summary',
		seq,
		from: 'assistant',
		to: 'priya',
		text: 'Summary.',
		at: new Date(0).toISOString(),
		covers: { from, through },
	};
}

function tool(toolName: string, agent: string, mutated: boolean): ToolEvent {
	return {
		order: 1,
		phase: 1,
		agent,
		tool: toolName,
		path: '/fixtures/R-19.md',
		result: 'result',
		mutated,
	};
}

function record(order: number, message: Message): RecordedEvent {
	return { order, phase: 1, message };
}

function json(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value)) as JsonValue;
}
