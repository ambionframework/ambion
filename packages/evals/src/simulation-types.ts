import type {
	HumanDefinition,
	Message,
	Room,
	RoomSnapshot,
	SummaryMessage,
} from '@ambionframework/ambion';
import type {
	Artifacts,
	Eval,
	EvalCheck,
	EvalIds,
	ExecutionOutcome,
	JsonValue,
	SetupContext,
	TeardownContext,
} from './types.ts';

/** One serial action taken by a simulated person. */
export type HumanAction =
	| {
			readonly kind: 'say';
			readonly human: string;
			readonly text: string;
			readonly to?: string;
	  }
	| { readonly kind: 'finish'; readonly reason: string };

/** The simulator may retain the model's original structured response for evidence. */
export interface HumanDecision {
	readonly action: HumanAction;
	readonly rawResponse?: JsonValue;
}

export interface HumanSimulatorContext {
	readonly humans: readonly HumanDefinition[];
	/** A detached public room read; no live room handle is exposed to the decision callback. */
	readonly observation: RoomSnapshot;
	readonly actions: readonly HumanAction[];
	readonly signal: AbortSignal;
}

export interface HumanSimulator {
	decide(context: HumanSimulatorContext): Promise<HumanDecision>;
}

export interface SimulationLimits {
	readonly maxActions: number;
	readonly settleTimeoutMs: number;
}

export interface SimulationExchange {
	readonly from: number;
	readonly owner: string;
	readonly through?: number;
	readonly messages: readonly Message[];
	readonly summary?: SummaryMessage;
	readonly summaryStatus: 'pending' | 'published' | 'silent' | 'failed';
}

export type SimulationTermination =
	| { readonly status: 'finished'; readonly reason: string }
	| { readonly status: 'incomplete'; readonly reason: string }
	| { readonly status: 'action_limit'; readonly reason: string }
	| { readonly status: 'timed_out'; readonly reason: string }
	| { readonly status: 'aborted'; readonly reason: string }
	| { readonly status: 'failed'; readonly reason: string };

export interface SimulationDiagnostic {
	readonly name: string;
	readonly message: string;
	readonly cause?: JsonValue;
}

export interface SimulationResult {
	/** Whether the final public room snapshot reached the settling boundary. */
	readonly settled: boolean;
	readonly settledSnapshot: RoomSnapshot;
	readonly exchanges: readonly SimulationExchange[];
	readonly actions: readonly HumanAction[];
	readonly decisions: readonly HumanDecision[];
	readonly termination: SimulationTermination;
	readonly errors: readonly string[];
	readonly diagnostics: readonly SimulationDiagnostic[];
	/** True when an unresolved room or simulator operation may still be running. */
	readonly unsafeToContinue: boolean;
}

export interface RoomEvalSetupResult<Fixture> {
	readonly room: Room;
	readonly fixture: Fixture;
}

export interface RoomEvalBeforeActionContext<Input, Fixture> extends EvalIds {
	readonly input: Input;
	readonly fixture: Fixture;
	readonly action: HumanAction;
	readonly index: number;
	readonly signal: AbortSignal;
}

export interface RoomEvalCaptureContext<Input, Fixture> extends EvalIds {
	readonly input: Input;
	readonly fixture?: Fixture;
	readonly result?: SimulationResult;
	readonly outcome: ExecutionOutcome;
	readonly model?: string;
	readonly signal: AbortSignal;
}

export interface RoomEvalTeardownContext<Input, Fixture> extends TeardownContext<Input, Fixture> {
	readonly room?: Room;
	readonly result?: SimulationResult;
}

export interface RoomEval<Input, Fixture> {
	readonly id: string;
	readonly version: number;
	readonly input: Input;
	readonly humans: readonly HumanDefinition[];
	readonly simulator: HumanSimulator;
	readonly limits: SimulationLimits;
	setup(context: SetupContext<Input>): Promise<RoomEvalSetupResult<Fixture>>;
	beforeAction?(context: RoomEvalBeforeActionContext<Input, Fixture>): Promise<void> | void;
	capture(context: RoomEvalCaptureContext<Input, Fixture>): Promise<Artifacts>;
	readonly checks: readonly EvalCheck<SimulationResult>[];
	readonly judge: EvalCheck<SimulationResult>;
	teardown(context: RoomEvalTeardownContext<Input, Fixture>): Promise<void> | void;
}

export type RoomEvalAsEval<Input, Fixture> = Eval<
	Input,
	RoomEvalSetupResult<Fixture>,
	SimulationResult
>;
