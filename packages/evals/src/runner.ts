import { defaultEvalTimeouts } from './definition.ts';
import { sealArtifacts } from './evidence.ts';
import { determineStatus, gradeChecks, skippedCheck } from './grading.ts';
import type { JsonValue } from './json.ts';
import { cloneJson, digestJson, toJsonValue } from './json.ts';
import type { PhaseFailure } from './lifecycle.ts';
import {
	cleanupDeferred,
	cleanupManaged,
	emptyPhases,
	phase,
	settleResources,
} from './lifecycle.ts';
import type {
	CheckResult,
	Cleanup,
	Eval,
	EvalIds,
	EvalPhase,
	EvalTimeouts,
	EvaluationError,
	EvidenceKind,
	ExecutionOutcome,
	ManagedResource,
	RunEvalsOptions,
	SampleMetadata,
	SampleReport,
	SealedEvidence,
} from './types.ts';

export async function executeSample(
	definition: Eval<unknown, unknown, unknown>,
	index: number,
	runId: string,
	options: RunEvalsOptions,
): Promise<SampleReport> {
	const state = createSampleState(definition, index, runId, options);
	await runSetup(state, definition, options);
	await runOutput(state, definition, options);
	await settleState(state);
	await captureState(state, definition, options);
	const checkResults = await runChecks(state, definition, options);
	await cleanupState(state, definition, options);
	const status = determineStatus(
		checkResults,
		state.errors,
		state.outputAvailable,
		definition.checks.length,
	);
	return {
		...makePartialSample(
			definition,
			state.ids,
			runId,
			state.input,
			state.output,
			state.artifacts,
			state.collections,
			state.errors,
			state.phases,
			{
				status: state.runStatus,
				outputAvailable: state.outputAvailable,
				halted: state.halted,
				unsafeToContinue: state.unsafeToContinue,
				errors: [...state.errors],
			},
			state.startedAt,
		),
		status,
		checks: checkResults,
		metadata: makeMetadata(definition, options, state.startedAt),
	};
}

interface SampleState {
	readonly ids: EvalIds;
	readonly input: JsonValue;
	readonly callbackInput: unknown;
	readonly timeouts: EvalTimeouts;
	readonly errors: EvaluationError[];
	readonly phases: Record<EvalPhase, number>;
	readonly deferred: Cleanup[];
	readonly managed: ManagedResource[];
	readonly startedAt: string;
	fixture: unknown;
	output: unknown;
	outputAvailable: boolean;
	setupOk: boolean;
	halted: boolean;
	unsafeToContinue: boolean;
	runStatus: ExecutionOutcome['status'];
	artifacts: Readonly<Record<EvidenceKind, JsonValue>>;
	collections: Readonly<Record<EvidenceKind, SealedEvidence>>;
}

function createSampleState(
	definition: Eval<unknown, unknown, unknown>,
	index: number,
	runId: string,
	options: RunEvalsOptions,
): SampleState {
	const sampleId = `${runId}/${definition.id}/sample-${index}`;
	const input = toJsonValue(definition.input, `${definition.id} input`);
	return {
		ids: { evalId: definition.id, sampleId, attemptId: `${sampleId}/attempt-1` },
		input,
		callbackInput: cloneJson(input),
		timeouts: { ...defaultEvalTimeouts, ...options.timeouts, ...options.phaseTimeouts },
		errors: [],
		phases: emptyPhases(),
		deferred: [],
		managed: [],
		startedAt: new Date().toISOString(),
		fixture: undefined,
		output: undefined,
		outputAvailable: false,
		setupOk: false,
		halted: false,
		unsafeToContinue: false,
		runStatus: 'failed',
		artifacts: {},
		collections: {},
	};
}

function recordPhaseFailure(state: SampleState, result: PhaseFailure): void {
	state.errors.push(result.error);
	state.halted ||= result.timedOut || result.unsafeToContinue;
	state.unsafeToContinue ||= result.unsafeToContinue;
}

async function runSetup(
	state: SampleState,
	definition: Eval<unknown, unknown, unknown>,
	options: RunEvalsOptions,
): Promise<void> {
	const result = await phase(
		'setup',
		state.timeouts.setup,
		options.signal,
		state.phases,
		async (signal) => {
			state.fixture = await definition.setup({
				...state.ids,
				input: state.callbackInput,
				model: options.model,
				signal,
				defer: (cleanup) => state.deferred.push(cleanup),
				manage: (resource) => state.managed.push(resource),
			});
			return state.fixture;
		},
	);
	if (result.ok) state.setupOk = true;
	else recordPhaseFailure(state, result);
}

async function runOutput(
	state: SampleState,
	definition: Eval<unknown, unknown, unknown>,
	options: RunEvalsOptions,
): Promise<void> {
	if (!state.setupOk) return;
	const result = await phase(
		'run',
		state.timeouts.run,
		options.signal,
		state.phases,
		async (signal) => {
			const output = await definition.run({
				...state.ids,
				input: state.callbackInput,
				fixture: state.fixture as never,
				model: options.model,
				signal,
				manage: (resource) => state.managed.push(resource),
			});
			state.output = toJsonValue(output, `${definition.id} output`);
			state.outputAvailable = true;
			return state.output;
		},
	);
	if (result.ok) state.runStatus = 'success';
	else {
		state.runStatus = result.timedOut ? 'timed_out' : result.aborted ? 'aborted' : 'failed';
		recordPhaseFailure(state, result);
	}
}

async function settleState(state: SampleState): Promise<void> {
	const result = await settleResources(
		state.managed,
		state.timeouts.settle,
		undefined,
		state.phases,
		!state.setupOk || state.runStatus !== 'success',
	);
	state.errors.push(...result.errors);
	state.halted ||= result.timedOut || result.unsafeToContinue;
	state.unsafeToContinue ||= result.unsafeToContinue;
}

async function captureState(
	state: SampleState,
	definition: Eval<unknown, unknown, unknown>,
	options: RunEvalsOptions,
): Promise<void> {
	const outcome = executionOutcome(state);
	const result = await phase(
		'capture',
		state.timeouts.capture,
		options.signal,
		state.phases,
		async (signal) => {
			const captured = await definition.capture({
				...state.ids,
				input: state.callbackInput,
				fixture: state.setupOk ? (state.fixture as never) : undefined,
				output: state.output as never,
				outcome,
				model: options.model,
				signal,
			});
			return sealArtifacts(captured);
		},
	);
	if (result.ok) {
		state.collections = result.value.collections;
		state.artifacts = result.value.values;
	} else recordPhaseFailure(state, result);
}

function executionOutcome(state: SampleState): ExecutionOutcome {
	return {
		status: state.runStatus,
		outputAvailable: state.outputAvailable,
		halted: state.halted,
		unsafeToContinue: state.unsafeToContinue,
		errors: [...state.errors],
	};
}

async function runChecks(
	state: SampleState,
	definition: Eval<unknown, unknown, unknown>,
	options: RunEvalsOptions,
): Promise<CheckResult[]> {
	if (!state.setupOk || state.runStatus !== 'success' || !state.outputAvailable)
		return definition.checks.map((check) =>
			skippedCheck(check, 'No successful output was produced.'),
		);
	const sample = makePartialSample(
		definition,
		state.ids,
		state.ids.sampleId.split('/')[0] ?? state.ids.sampleId,
		state.input,
		state.output,
		state.artifacts,
		state.collections,
		state.errors,
		state.phases,
		executionOutcome(state),
		state.startedAt,
	);
	const results = await gradeChecks(
		definition,
		sample,
		options.judge,
		options.model,
		state.timeouts.check,
		options.signal,
		state.phases,
	);
	for (const result of results) {
		if (result.error !== undefined && result.status === 'error') state.errors.push(result.error);
		state.unsafeToContinue ||= result.unsafeToContinue === true;
	}
	return results;
}

async function cleanupState(
	state: SampleState,
	definition: Eval<unknown, unknown, unknown>,
	options: RunEvalsOptions,
): Promise<void> {
	const outcome = executionOutcome(state);
	const teardown = await phase(
		'teardown',
		state.timeouts.teardown,
		undefined,
		state.phases,
		async (signal) => {
			await definition.teardown({
				...state.ids,
				input: state.callbackInput,
				fixture: state.setupOk ? (state.fixture as never) : undefined,
				outcome,
				model: options.model,
				signal,
			});
		},
	);
	if (!teardown.ok) recordPhaseFailure(state, teardown);
	const deferred = await cleanupDeferred(
		state.deferred,
		state.timeouts.cleanup,
		undefined,
		state.phases,
	);
	appendCleanupResult(state, deferred);
	const managed = await cleanupManaged(
		state.managed,
		state.timeouts.cleanup,
		undefined,
		state.phases,
	);
	appendCleanupResult(state, managed);
}

function appendCleanupResult(
	state: SampleState,
	result: { errors: EvaluationError[]; timedOut: boolean; unsafeToContinue: boolean },
): void {
	state.errors.push(...result.errors);
	state.halted ||= result.timedOut || result.unsafeToContinue;
	state.unsafeToContinue ||= result.unsafeToContinue;
}

function makePartialSample(
	definition: Eval<unknown, unknown, unknown>,
	ids: EvalIds,
	runId: string,
	input: JsonValue,
	output: unknown,
	artifacts: Readonly<Record<EvidenceKind, JsonValue>>,
	collections: Readonly<Record<EvidenceKind, SealedEvidence>>,
	errors: readonly EvaluationError[],
	phases: Readonly<Record<EvalPhase, number>>,
	outcome: ExecutionOutcome,
	startedAt: string,
): SampleReport {
	return {
		runId,
		evalId: definition.id,
		version: definition.version,
		scope: definition.scope,
		sampleId: ids.sampleId,
		attemptId: ids.attemptId,
		input,
		status: 'error',
		...(output === undefined ? {} : { output: toJsonValue(output, `${definition.id} output`) }),
		artifacts,
		evidence: Object.fromEntries(
			Object.entries(collections).map(([key, item]) => [key, item.value]),
		),
		collections,
		checks: [],
		errors,
		phases,
		metadata: {
			rubricDigests: {},
			startedAt,
			finishedAt: new Date().toISOString(),
		},
		outcome,
	};
}

function makeMetadata(
	definition: Eval<unknown, unknown, unknown>,
	options: RunEvalsOptions,
	startedAt: string,
): SampleMetadata {
	return {
		...(options.model === undefined ? {} : { modelId: options.model }),
		...(options.judge?.model === undefined ? {} : { judgeModelId: options.judge.model }),
		...(options.judge?.id === undefined ? {} : { judgeId: options.judge.id }),
		...(options.sourceRevision === undefined ? {} : { sourceRevision: options.sourceRevision }),
		...(options.instructionDigest === undefined
			? {}
			: { instructionDigest: options.instructionDigest }),
		rubricDigests: Object.fromEntries(
			definition.checks.map((check) => [check.id, check.rubricDigest ?? digestJson(check.id)]),
		),
		startedAt,
		finishedAt: new Date().toISOString(),
	};
}
