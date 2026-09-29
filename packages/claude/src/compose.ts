/** The Claude execution: one Claude executor for each seat. */

import type { AgentRunner, Execution } from '@ambionframework/ambion/hosting';
import { defineExecution } from '@ambionframework/ambion/hosting';
import { createClaudeExecutor } from './executor.ts';
import type { ClaudeRuntime } from './options.ts';

/** What the Claude execution runs with. Every field is optional. */
export type ClaudeExecutionOptions = ClaudeRuntime;

/**
 * The Claude execution for a runtime or a room. Pass it as `execution` to
 * `createRuntime`, `startRoom` or `resumeRoom`. The runtime supplies its
 * clock, limits, and logger when it builds the connector. It serves the
 * seats of kind `claude`, and it becomes the default of that kind.
 */
export function claudeExecution(options: ClaudeExecutionOptions = {}): Execution<AgentRunner> {
	return defineExecution(
		'claude',
		() => (request) => createClaudeExecutor({ definition: request.definition, ...options }),
	);
}

/**
 * A room with no execution for a `claude` seat runs it on the default of the
 * kind. Loading the package defines that default.
 */
claudeExecution();
