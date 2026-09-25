/**
 * The values you write for a Pi agent: its executor, and its native tools.
 *
 * `pi()` builds the executor an agent definition takes. `fromPiTool` adapts
 * one native Pi tool to the tool the room normalizes.
 */
import type { AgentExecutor, AmbionTool } from '@ambionframework/ambion';
import { defineTool } from '@ambionframework/ambion';
import { type AgentExecutorBaseOptions, describeExecutor } from '@ambionframework/ambion/hosting';
import type { AgentTool, CompactionSettings, ThinkingLevel } from '@earendil-works/pi-agent-core';
import { DEFAULT_COMPACTION_SETTINGS } from '@earendil-works/pi-agent-core';
import type { TSchema } from 'typebox';

export interface PiOptions extends AgentExecutorBaseOptions {
	/** A Pi model identifier, `provider/model-id`. */
	model: string;
	/**
	 * When the harness compacts the session. Absent, the harness uses Pi's
	 * `DEFAULT_COMPACTION_SETTINGS`.
	 */
	compaction?: CompactionSettings;
	/**
	 * How much the model reasons before it answers. Absent, `off`. The
	 * provider maps each level to its own setting, and a model with no
	 * reasoning ignores it.
	 */
	thinking?: ThinkingLevel;
}

/**
 * An agent's Pi executor: Pi's `AgentHarness`, model, instructions, and
 * tools. Built by `pi()`. The room reads none of the fields Pi adds; the Pi
 * executor does.
 */
export interface PiExecutor extends AgentExecutor {
	readonly kind: 'pi';
	readonly model: string;
	readonly compaction?: CompactionSettings;
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

const isCount = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) >= 0;

/** Refuse compaction settings the harness refuses, when the agent is defined. */
function checkCompaction(settings: CompactionSettings): void {
	if (!isCount(settings.reserveTokens) || !isCount(settings.keepRecentTokens)) {
		throw new RangeError('Compaction token counts must be non-negative safe integers.');
	}
}

/** The Pi executor: Pi's `AgentHarness`, model, instructions, and tools. */
export function pi(options: PiOptions): PiExecutor {
	const { compaction, thinking, ...rest } = options;
	if (compaction !== undefined) checkCompaction(compaction);
	if (thinking !== undefined && !isThinking(thinking)) {
		throw new RangeError(`Thinking must be one of ${THINKING.join(', ')}.`);
	}
	return Object.freeze({
		...describeExecutor({ ...rest, kind: 'pi' }),
		kind: 'pi' as const,
		model: options.model,
		...(compaction === undefined ? {} : { compaction: Object.freeze({ ...compaction }) }),
		...(thinking === undefined ? {} : { thinking }),
	});
}

/** Adapt one native Pi tool to the normalized Ambion calling convention. */
export function fromPiTool<TParameters extends TSchema, TDetails>(
	tool: AgentTool<TParameters, TDetails>,
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
				params as Parameters<AgentTool<TParameters, TDetails>['execute']>[1],
				context.signal,
				context.onUpdate,
			),
	});
}

/** The model identifier `pi()` gave the executor. Another family's executor has none. */
export function modelOf(executor: AgentExecutor): string {
	if ('model' in executor && typeof executor.model === 'string') return executor.model;
	throw new Error(`The Pi executor cannot run an executor of kind '${executor.kind}'.`);
}

/** The compaction settings `pi()` gave the executor, or Pi's defaults. */
export function compactionOf(executor: AgentExecutor): CompactionSettings {
	if ('compaction' in executor && isCompaction(executor.compaction)) return executor.compaction;
	return DEFAULT_COMPACTION_SETTINGS;
}

/** The thinking level `pi()` gave the executor, or `off`. */
export function thinkingOf(executor: AgentExecutor): ThinkingLevel {
	return 'thinking' in executor && isThinking(executor.thinking) ? executor.thinking : 'off';
}

function isCompaction(value: unknown): value is CompactionSettings {
	return (
		typeof value === 'object' &&
		value !== null &&
		'enabled' in value &&
		typeof value.enabled === 'boolean'
	);
}
