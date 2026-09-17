import type { JsonValue } from './json.ts';

export type { JsonPrimitive, JsonValue } from './json.ts';

export type EvidenceKind = string;

export type EvalScope = 'agent' | 'room';

export type EvalPhase =
	'setup' | 'run' | 'settle' | 'capture' | 'check' | 'teardown' | 'cleanup' | 'persist';

export interface EvalIds {
	readonly evalId: string;
	readonly sampleId: string;
	readonly attemptId: string;
}

export interface EvalTimeouts {
	readonly setup: number;
	readonly run: number;
	readonly settle: number;
	readonly capture: number;
	readonly check: number;
	readonly teardown: number;
	readonly cleanup: number;
}

export interface EvidenceValue<T extends JsonValue = JsonValue> {
	readonly $evidence: true;
	readonly value: T;
	readonly complete?: boolean;
	readonly provenance?: string;
	readonly refs?: readonly string[];
}

export type Artifacts = Readonly<Record<EvidenceKind, JsonValue | EvidenceValue>>;

export interface SealedEvidence<T extends JsonValue = JsonValue> {
	readonly kind: EvidenceKind;
	readonly value: T;
	readonly complete: boolean;
	readonly provenance?: string;
	readonly refs: readonly string[];
}

export interface ManagedResource {
	abort?(signal: AbortSignal): Promise<void> | void;
	settle?(signal: AbortSignal): Promise<void> | void;
	dispose?(signal: AbortSignal): Promise<void> | void;
	close?(signal: AbortSignal): Promise<void> | void;
}

export type Cleanup = (signal: AbortSignal) => Promise<void> | void;

export interface EvalContextBase<Input> extends EvalIds {
	readonly input: Input;
	readonly model?: string;
	readonly signal: AbortSignal;
}

export interface SetupContext<Input> extends EvalContextBase<Input> {
	defer(cleanup: Cleanup): void;
	manage(resource: ManagedResource): void;
}

export interface RunContext<Input, Fixture> extends EvalContextBase<Input> {
	readonly fixture: Fixture;
	manage(resource: ManagedResource): void;
}

export interface ExecutionOutcome {
	readonly status: 'success' | 'failed' | 'timed_out' | 'aborted';
	readonly outputAvailable: boolean;
	readonly halted: boolean;
	readonly unsafeToContinue: boolean;
	readonly errors: readonly EvaluationError[];
}

export interface CaptureContext<Input, Fixture, Output> extends EvalContextBase<Input> {
	readonly fixture?: Fixture;
	readonly output?: Output;
	readonly outcome: ExecutionOutcome;
}

export interface TeardownContext<Input, Fixture> extends EvalContextBase<Input> {
	readonly fixture?: Fixture;
	readonly outcome: ExecutionOutcome;
}

export interface GradeContext<Output> extends EvalIds {
	readonly input: JsonValue;
	readonly output: Output;
	readonly signal: AbortSignal;
	readonly evidence: Readonly<Record<EvidenceKind, JsonValue>>;
	readonly collections: Readonly<Record<EvidenceKind, SealedEvidence>>;
	readonly model?: string;
	readonly judge?: JudgeRuntime;
}

export interface Judgment {
	readonly verdict: 'pass' | 'fail' | 'inconclusive';
	readonly explanation: string;
	readonly evidenceRefs: readonly string[];
	readonly criteria?: readonly JudgmentCriterion[];
	readonly rawResponse?: JsonValue;
}

export interface JudgmentCriterion {
	readonly id: string;
	readonly verdict: Judgment['verdict'];
	readonly explanation: string;
	readonly evidenceRefs: readonly string[];
}

export interface EvalCheck<Output> {
	readonly id: string;
	readonly requires: readonly EvidenceKind[];
	readonly rubricVersion?: string;
	readonly rubricDigest?: string;
	evaluate(context: GradeContext<Output>): Promise<void> | Promise<Judgment>;
}

export interface Eval<Input, Fixture, Output> {
	readonly id: string;
	readonly version: number;
	readonly scope: EvalScope;
	readonly input: Input;
	setup(context: SetupContext<Input>): Promise<Fixture>;
	run(context: RunContext<Input, Fixture>): Promise<Output>;
	capture(context: CaptureContext<Input, Fixture, Output>): Promise<Artifacts>;
	readonly checks: readonly EvalCheck<Output>[];
	teardown(context: TeardownContext<Input, Fixture>): Promise<void>;
}

export interface JudgeRequest {
	readonly checkId: string;
	readonly rubric: string;
	readonly rubricVersion: string;
	readonly input: JsonValue;
	readonly output: JsonValue;
	readonly packet: JsonValue;
	readonly evidence: Readonly<Record<EvidenceKind, JsonValue>>;
	readonly model?: string;
	readonly signal: AbortSignal;
}

export type JudgeResponse = Judgment | string;

export type JudgeExecutor = (request: JudgeRequest) => Promise<JudgeResponse>;

export interface JudgeRuntime {
	readonly id?: string;
	readonly model?: string;
	readonly execute: JudgeExecutor;
}

export interface JudgeRuntimeOptions {
	readonly id?: string;
	readonly model?: string;
	readonly execute: JudgeExecutor;
}

export interface RoomJudgeOptions {
	readonly id?: string;
	readonly model: string;
	readonly execute?: JudgeExecutor;
}

export interface AgentJudgeOptions<Output> {
	readonly id: string;
	readonly rubric: string;
	readonly rubricVersion?: string;
	readonly requires: readonly EvidenceKind[];
	readonly criteria?: readonly string[];
	readonly select: (context: GradeContext<Output>) => JsonValue;
	readonly judge?: JudgeExecutor;
}

export interface EvaluationError {
	readonly phase: EvalPhase;
	readonly name: string;
	readonly message: string;
	readonly stack?: string;
	readonly cause?: JsonValue;
}

export interface CheckResult {
	readonly id: string;
	readonly status: 'passed' | 'failed' | 'skipped' | 'error';
	readonly durationMs: number;
	readonly requiredEvidence: readonly EvidenceKind[];
	readonly missingEvidence: readonly EvidenceKind[];
	readonly judgment?: Judgment;
	readonly error?: EvaluationError;
	readonly unsafeToContinue?: boolean;
}

export interface SampleReport {
	readonly runId: string;
	readonly evalId: string;
	readonly version: number;
	readonly scope: EvalScope;
	readonly sampleId: string;
	readonly attemptId: string;
	readonly input: JsonValue;
	readonly status: 'passed' | 'failed' | 'error' | 'skipped';
	readonly output?: JsonValue;
	readonly artifacts: Readonly<Record<EvidenceKind, JsonValue>>;
	readonly evidence: Readonly<Record<EvidenceKind, JsonValue>>;
	readonly collections: Readonly<Record<EvidenceKind, SealedEvidence>>;
	readonly checks: readonly CheckResult[];
	readonly errors: readonly EvaluationError[];
	readonly phases: Readonly<Record<EvalPhase, number>>;
	readonly metadata: SampleMetadata;
	readonly outcome: ExecutionOutcome;
}

export interface SampleMetadata {
	readonly modelId?: string;
	readonly judgeModelId?: string;
	readonly judgeId?: string;
	readonly instructionDigest?: string;
	readonly sourceRevision?: string;
	readonly rubricDigests: Readonly<Record<string, string>>;
	readonly startedAt: string;
	readonly finishedAt: string;
	readonly gradingId?: string;
	readonly gradingRubricDigests?: Readonly<Record<string, string>>;
	readonly gradingSourceRevision?: string;
}

export interface EvalReport {
	readonly schemaVersion: 1;
	readonly startedAt: string;
	readonly finishedAt: string;
	readonly metadata: ReportMetadata;
	readonly runId: string;
	readonly passed: boolean;
	readonly gradingId?: string;
	readonly samples: readonly SampleReport[];
}

export interface ReportMetadata {
	readonly modelId?: string;
	readonly judgeModelId?: string;
	readonly judgeId?: string;
	readonly sourceRevision?: string;
	readonly gradingSourceRevision?: string;
	readonly instructionDigest?: string;
	readonly suiteDigest: string;
	readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export interface EvalStore {
	saveSample(sample: SampleReport): Promise<void>;
	saveReport(report: EvalReport): Promise<void>;
	loadReport?(runId?: string): Promise<EvalReport | undefined>;
}

export interface RunEvalsOptions {
	readonly samples?: number;
	readonly samplesPerEval?: number | ((evalDefinition: Eval<unknown, unknown, unknown>) => number);
	readonly model?: string;
	readonly judge?: JudgeRuntime;
	readonly timeouts?: Partial<EvalTimeouts>;
	readonly phaseTimeouts?: Partial<EvalTimeouts>;
	readonly signal?: AbortSignal;
	readonly store?: EvalStore;
	readonly artifactStore?: EvalStore;
	readonly sourceRevision?: string;
	readonly instructionDigest?: string;
	readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export interface RegradeOptions {
	readonly judge?: JudgeRuntime;
	readonly model?: string;
	readonly sourceRevision?: string;
	readonly gradingId?: string;
	readonly store?: EvalStore;
	readonly signal?: AbortSignal;
	readonly timeouts?: Pick<Partial<EvalTimeouts>, 'check'>;
}
