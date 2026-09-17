import { defaultEvalTimeouts } from './definition.ts';
import { isAssertionError } from './errors.ts';
import { hasValidEvidenceRefs, validEvidenceRefs } from './evidence.ts';
import type { JsonValue } from './json.ts';
import { cloneJson, deepFreeze } from './json.ts';
import { inconclusive, validateJudgment } from './judge.ts';
import { phase } from './lifecycle.ts';
import type {
	CheckResult,
	Eval,
	EvalCheck,
	EvalPhase,
	EvaluationError,
	EvidenceKind,
	GradeContext,
	JudgeRequest,
	JudgeRuntime,
	Judgment,
	SampleReport,
	SealedEvidence,
} from './types.ts';

interface GradeOptions {
	judge?: JudgeRuntime;
	model?: string;
	timeout: number;
	signal?: AbortSignal;
	phases?: Record<EvalPhase, number>;
}

export async function gradeChecks(
	definition: Eval<unknown, unknown, unknown>,
	sample: SampleReport,
	judge: JudgeRuntime | undefined,
	model: string | undefined,
	checkTimeout = defaultEvalTimeouts.check,
	parentSignal?: AbortSignal,
	phases?: Record<EvalPhase, number>,
): Promise<CheckResult[]> {
	if (sample.output === undefined)
		return definition.checks.map((check) => skippedCheck(check, 'No output was produced.'));
	const results: CheckResult[] = [];
	let unsafe = false;
	for (const check of definition.checks) {
		const result: CheckResult = unsafe
			? skippedCheck(check, 'A previous check ignored cancellation; further checks cannot start.')
			: await gradeOne(check, sample, {
					judge,
					model,
					timeout: checkTimeout,
					signal: parentSignal,
					phases,
				});
		results.push(result);
		unsafe ||= result.unsafeToContinue === true;
	}
	return results;
}

async function gradeOne(
	check: EvalCheck<unknown>,
	sample: SampleReport,
	options: GradeOptions,
): Promise<CheckResult> {
	const missing = check.requires.filter((kind) => !sample.collections[kind]?.complete);
	if (missing.length > 0)
		return {
			...skippedCheck(check, 'Required evidence is missing or incomplete.'),
			missingEvidence: missing,
		};
	const started = Date.now();
	const result = await phase(
		'check',
		options.timeout,
		options.signal,
		options.phases,
		async (signal) => {
			const judgment = await check.evaluate(gradeContext(sample, options, signal));
			return judgment === undefined ? undefined : validateJudgment(judgment);
		},
	);
	const base = {
		id: check.id,
		durationMs: Date.now() - started,
		requiredEvidence: [...check.requires],
		missingEvidence: [],
	};
	if (!result.ok)
		return {
			...base,
			status: isAssertionError(result.error) ? 'failed' : 'error',
			error: result.error,
			...(result.unsafeToContinue ? { unsafeToContinue: true } : {}),
		};
	if (result.value === undefined) return { ...base, status: 'passed' };
	const judgment = citedJudgment(result.value, sample);
	return { ...base, status: judgmentStatus(judgment), judgment };
}

function gradeContext(
	sample: SampleReport,
	options: GradeOptions,
	signal: AbortSignal,
): GradeContext<unknown> {
	const judge = options.judge;
	return deepFreeze({
		evalId: sample.evalId,
		sampleId: sample.sampleId,
		attemptId: sample.attemptId,
		input: cloneJson(sample.input),
		output: cloneJson(sample.output ?? null),
		signal,
		evidence: cloneJson(sample.evidence),
		collections: cloneJson(sample.collections as unknown as JsonValue) as unknown as Readonly<
			Record<EvidenceKind, SealedEvidence>
		>,
		model: options.model,
		judge:
			judge === undefined
				? undefined
				: { ...judge, execute: (request: JudgeRequest) => judge.execute({ ...request, signal }) },
	});
}

function citedJudgment(judgment: Judgment, sample: SampleReport): Judgment {
	if (judgment.verdict !== 'pass') return judgment;
	if (hasValidEvidenceRefs(judgment.evidenceRefs, new Set(validEvidenceRefs(sample.collections))))
		return judgment;
	return {
		...inconclusive('A passing check must cite sealed evidence.'),
		...(judgment.rawResponse === undefined ? {} : { rawResponse: judgment.rawResponse }),
	};
}

function judgmentStatus(judgment: Judgment): CheckResult['status'] {
	if (judgment.verdict === 'pass') return 'passed';
	return judgment.verdict === 'fail' ? 'failed' : 'skipped';
}

export function skippedCheck(check: EvalCheck<unknown>, reason: string): CheckResult {
	return {
		id: check.id,
		status: 'skipped',
		durationMs: 0,
		requiredEvidence: [...check.requires],
		missingEvidence: [],
		judgment: inconclusive(reason),
	};
}

export function determineStatus(
	checks: readonly CheckResult[],
	errors: readonly EvaluationError[],
	outputAvailable: boolean,
	checkCount: number,
): SampleReport['status'] {
	if (errors.length > 0) return 'error';
	if (!outputAvailable || checkCount === 0) return 'failed';
	if (checks.some((item) => item.status === 'error')) return 'error';
	return checks.every((item) => item.status === 'passed') ? 'passed' : 'failed';
}
