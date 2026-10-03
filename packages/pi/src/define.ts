/**
 * The values you write for a Pi agent: its executor, and its native tools.
 *
 * `pi()` builds the executor an agent definition takes. `fromPiTool` adapts
 * one native Pi tool to the tool the room normalizes.
 */
import type { AmbionTool, Executor, ToolContent } from '@ambionframework/ambion';
import { defineTool } from '@ambionframework/ambion';
import { describeExecutor, type ExecutorBaseOptions } from '@ambionframework/ambion/hosting';
import { quickjsRuntime } from '@ambionframework/compose/runtime';
import type { ModelThinkingLevel, Static, TSchema } from '@earendil-works/pi-ai';
import type { CompactionPolicy } from '@earendil-works/pi-durable';

/** How much the model reasons before it answers. */
export type ThinkingLevel = ModelThinkingLevel;

/** When the harness compacts a session. A field that is absent keeps the default of pi-durable. */
export type CompactionOptions = Partial<CompactionPolicy>;

export interface PiOptions extends ExecutorBaseOptions {
	/** A Pi model identifier, `provider/model-id`. */
	model: string;
	/**
	 * When the harness compacts the session: `enabled`, `reserveTokens`,
	 * `keepRecentTokens`, and `backgroundTokens`. A field that is absent
	 * keeps the default of pi-durable. Compaction also recovers a request
	 * that overflows the context window, so a session with `enabled: false`
	 * fails that request.
	 */
	compaction?: CompactionOptions;
	/**
	 * How much the model reasons before it answers. Absent, `off`. The
	 * provider maps each level to its own setting, and a model with no
	 * reasoning ignores it.
	 */
	thinking?: ThinkingLevel;
}

/**
 * An agent's Pi executor: the pi-durable harness, model, instructions, and
 * tools. Built by `pi()`. The room reads none of the fields Pi adds; the Pi
 * executor does.
 */
export interface PiExecutor extends Executor {
	readonly kind: 'pi';
	readonly model: string;
	readonly compaction?: CompactionOptions;
	readonly thinking?: ThinkingLevel;
}

/** Every level of `thinking`, from none to the most. */
const THINKING: readonly ThinkingLevel[] = [
	'off',
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
	'max',
];

const isThinking = (value: unknown): value is ThinkingLevel =>
	THINKING.some((level) => level === value);

/** Refuse a thinking level that Pi does not name, when the agent is defined. */
export function checkThinking(thinking: unknown): void {
	if (thinking !== undefined && !isThinking(thinking)) {
		throw new RangeError(`Thinking must be one of ${THINKING.join(', ')}.`);
	}
}

const isCount = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) >= 0;

/** Refuse compaction options the harness refuses, when the agent is defined. */
function checkCompaction(options: CompactionOptions): void {
	const counts = [options.reserveTokens, options.keepRecentTokens, options.backgroundTokens];
	if (counts.some((count) => count !== undefined && !isCount(count))) {
		throw new RangeError('Compaction token counts must be non-negative safe integers.');
	}
	if (options.enabled !== undefined && typeof options.enabled !== 'boolean') {
		throw new RangeError('Compaction `enabled` must be a boolean.');
	}
}

/** The Pi executor: the pi-durable harness, model, instructions, and tools. */
export function pi(options: PiOptions): PiExecutor {
	const { compaction, thinking, ...rest } = options;
	if (compaction !== undefined) checkCompaction(compaction);
	checkThinking(thinking);
	return Object.freeze({
		...describeExecutor({
			...rest,
			compose: rest.compose ?? { runtime: quickjsRuntime() },
			kind: 'pi',
		}),
		kind: 'pi' as const,
		model: options.model,
		...(compaction === undefined ? {} : { compaction: Object.freeze({ ...compaction }) }),
		...(thinking === undefined ? {} : { thinking }),
	});
}

/**
 * A native Pi tool: the fields of an `AgentTool` of `@earendil-works/pi-agent-core`.
 * `execute` receives the call id, the checked arguments, the signal, and the
 * update callback.
 */
export interface NativePiTool<TParameters extends TSchema = TSchema, TDetails = unknown> {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: TParameters;
	readonly prepareArguments?: (args: unknown) => Static<TParameters>;
	readonly executionMode?: 'sequential' | 'parallel';
	readonly execute: (
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: (partial: { content: ToolContent[]; details: TDetails }) => void,
	) => Promise<{ content: ToolContent[]; details: TDetails; terminate?: boolean }>;
}

/** Adapt one native Pi tool to the normalized Ambion calling convention. */
export function fromPiTool<TParameters extends TSchema, TDetails>(
	tool: NativePiTool<TParameters, TDetails>,
): AmbionTool {
	if (typeof tool !== 'object' || tool === null) throw new Error('Tool options must be an object.');
	const execute = tool.execute;
	return defineTool<TSchema>({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		label: tool.label,
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		execute: (params, context) =>
			execute(
				context.callId,
				// defineTool validates the captured schema. Pi can use a different TypeBox version.
				params as Static<TParameters>,
				context.signal,
				context.onUpdate,
			),
	});
}

/** The model identifier `pi()` gave the executor. An executor of another kind has none. */
export function modelOf(executor: Executor): string {
	if ('model' in executor && typeof executor.model === 'string') return executor.model;
	throw new Error(`The Pi executor cannot run an executor of kind '${executor.kind}'.`);
}

/** The compaction options `pi()` gave the executor, or none: the defaults of pi-durable. */
export function compactionOf(executor: Executor): CompactionOptions {
	if ('compaction' in executor && isCompaction(executor.compaction)) return executor.compaction;
	return {};
}

/** The thinking level `pi()` gave the executor, or `off`. */
export function thinkingOf(executor: Executor): ThinkingLevel {
	return 'thinking' in executor && isThinking(executor.thinking) ? executor.thinking : 'off';
}

function isCompaction(value: unknown): value is CompactionOptions {
	return typeof value === 'object' && value !== null;
}
