import { sampleCount, validateSuite } from './definition.ts';
import { addPersistenceError } from './errors.ts';
import { gradeChecks, skippedCheck } from './grading.ts';
import { cloneJson, digestJson } from './json.ts';
import { executeSample } from './runner.ts';
import { EvalPersistenceError, validateStoredReport } from './store.ts';
import type {
	CheckResult,
	Eval,
	EvalReport,
	EvalStore,
	EvaluationError,
	RegradeOptions,
	RunEvalsOptions,
	SampleMetadata,
	SampleReport,
} from './types.ts';

export async function runEvals(
	evals: readonly Eval<unknown, unknown, unknown>[],
	options: RunEvalsOptions = {},
): Promise<EvalReport> {
	validateSuite(evals);
	const startedAt = new Date().toISOString();
	const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	const store = options.store ?? options.artifactStore;
	const samples = await executeSuite(evals, options, runId, store);
	const report = createReport(evals, options, runId, startedAt, samples);
	if (store !== undefined) {
		try {
			await store.saveReport(report);
		} catch (error) {
			throw new EvalPersistenceError('The eval report could not be persisted.', error, report);
		}
	}
	return report;
}

function createReport(
	evals: readonly Eval<unknown, unknown, unknown>[],
	options: RunEvalsOptions,
	runId: string,
	startedAt: string,
	samples: readonly SampleReport[],
): EvalReport {
	return {
		schemaVersion: 1,
		startedAt,
		finishedAt: new Date().toISOString(),
		metadata: {
			...(options.model === undefined ? {} : { modelId: options.model }),
			...(options.judge?.model === undefined ? {} : { judgeModelId: options.judge.model }),
			...(options.judge?.id === undefined ? {} : { judgeId: options.judge.id }),
			...(options.sourceRevision === undefined ? {} : { sourceRevision: options.sourceRevision }),
			...(options.instructionDigest === undefined
				? {}
				: { instructionDigest: options.instructionDigest }),
			suiteDigest: digestJson(evals.map((item) => ({ id: item.id, version: item.version }))),
			...(options.metadata === undefined ? {} : { metadata: cloneJson(options.metadata) }),
		},
		runId,
		passed: samples.length > 0 && samples.every((sample) => sample.status === 'passed'),
		samples,
	};
}

async function executeSuite(
	evals: readonly Eval<unknown, unknown, unknown>[],
	options: RunEvalsOptions,
	runId: string,
	store: EvalStore | undefined,
): Promise<SampleReport[]> {
	const samples: SampleReport[] = [];
	for (const definition of evals) {
		for (const sample of await executeDefinitionSamples(
			definition,
			sampleCount(definition, options),
			runId,
			options,
			store,
		)) {
			samples.push(sample);
			if (sample.outcome.unsafeToContinue) return samples;
		}
	}
	return samples;
}

async function executeDefinitionSamples(
	definition: Eval<unknown, unknown, unknown>,
	count: number,
	runId: string,
	options: RunEvalsOptions,
	store: EvalStore | undefined,
): Promise<SampleReport[]> {
	const samples: SampleReport[] = [];
	for (let index = 0; index < count; index += 1) {
		const sample = await executeSample(definition, index + 1, runId, options);
		const persisted = await persistSample(sample, store);
		samples.push(persisted);
		if (persisted.outcome.unsafeToContinue) break;
	}
	return samples;
}

async function persistSample(
	sample: SampleReport,
	store: EvalStore | undefined,
): Promise<SampleReport> {
	if (store === undefined) return sample;
	try {
		await store.saveSample(sample);
		return sample;
	} catch (error) {
		return addPersistenceError(sample, error);
	}
}

export async function regradeEvals(
	report: EvalReport,
	evals: readonly Eval<unknown, unknown, unknown>[],
	options: RegradeOptions = {},
): Promise<EvalReport> {
	validateStoredReport(report);
	validateSuite(evals);
	const definitions = new Map(evals.map((item) => [item.id, item]));
	const gradingId =
		options.gradingId ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	const samples: SampleReport[] = [];
	let unsafe = false;
	for (const sample of report.samples) {
		const graded = await regradeSample(sample, definitions, options, gradingId, unsafe);
		samples.push(graded);
		unsafe ||= graded.checks.some((check) => check.unsafeToContinue);
	}
	const next: EvalReport = {
		...report,
		finishedAt: new Date().toISOString(),
		metadata: {
			...report.metadata,
			...(options.judge?.model === undefined ? {} : { judgeModelId: options.judge.model }),
			...(options.judge?.id === undefined ? {} : { judgeId: options.judge.id }),
			...(options.sourceRevision === undefined
				? {}
				: { gradingSourceRevision: options.sourceRevision }),
		},
		passed: samples.length > 0 && samples.every((sample) => sample.status === 'passed'),
		gradingId,
		samples,
	};
	if (options.store !== undefined) await options.store.saveReport(next);
	return next;
}

async function regradeSample(
	sample: SampleReport,
	definitions: ReadonlyMap<string, Eval<unknown, unknown, unknown>>,
	options: RegradeOptions,
	gradingId: string,
	unsafe: boolean,
): Promise<SampleReport> {
	const definition = definitions.get(sample.evalId);
	if (definition === undefined) return sample;
	const checks = await regradeChecks(definition, sample, options, unsafe);
	const errors = sample.errors.filter((item) => item.phase !== 'check');
	return {
		...sample,
		status: regradedStatus(sample, checks, errors),
		checks,
		errors,
		metadata: regradedMetadata(sample, definition, options, gradingId),
	};
}

async function regradeChecks(
	definition: Eval<unknown, unknown, unknown>,
	sample: SampleReport,
	options: RegradeOptions,
	unsafe: boolean,
): Promise<CheckResult[]> {
	if (unsafe || sample.outcome.status !== 'success')
		return definition.checks.map((check) =>
			skippedCheck(
				check,
				unsafe
					? 'A previous check ignored cancellation; further samples cannot be graded.'
					: 'The original execution did not succeed.',
			),
		);
	return gradeChecks(
		definition,
		sample,
		options.judge,
		options.model,
		options.timeouts?.check,
		options.signal,
	);
}

function regradedStatus(
	sample: SampleReport,
	checks: readonly CheckResult[],
	errors: readonly EvaluationError[],
): SampleReport['status'] {
	if (sample.outcome.status !== 'success') return sample.status === 'error' ? 'error' : 'failed';
	if (checks.some((item) => item.status === 'error')) return 'error';
	return checks.every((item) => item.status === 'passed') && errors.length === 0
		? 'passed'
		: 'failed';
}

function regradedMetadata(
	sample: SampleReport,
	definition: Eval<unknown, unknown, unknown>,
	options: RegradeOptions,
	gradingId: string,
): SampleMetadata {
	return {
		...sample.metadata,
		...(options.judge?.model === undefined ? {} : { judgeModelId: options.judge.model }),
		...(options.judge?.id === undefined ? {} : { judgeId: options.judge.id }),
		gradingId,
		...(options.sourceRevision === undefined
			? {}
			: { gradingSourceRevision: options.sourceRevision }),
		gradingRubricDigests: Object.fromEntries(
			definition.checks.map((check) => [check.id, check.rubricDigest ?? digestJson(check.id)]),
		),
		finishedAt: new Date().toISOString(),
	};
}
