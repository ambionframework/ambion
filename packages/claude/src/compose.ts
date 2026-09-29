/** The Claude execution: one Claude executor for each seat. */

import type {
	AgentRunner,
	ConnectorRequest,
	Execution,
	Executor,
} from '@ambionframework/ambion/hosting';
import { defineExecution, localExecution } from '@ambionframework/ambion/hosting';
import { createClaudeExecutor } from './executor.ts';
import type { ClaudeRuntime } from './options.ts';

/** What the Claude execution runs with. Every field is optional. */
export type ClaudeExecutionOptions = ClaudeRuntime;

/**
 * The Claude execution for a runtime or a room. Pass it as `execution` to
 * `createRuntime`, `startRoom` or `resumeRoom`. The runtime supplies its
 * clock, limits, and logger when it builds the connector. It serves the
 * seats of kind `claude`. It does not change the default of that kind.
 */
export function claudeExecution(options: ClaudeExecutionOptions = {}): Execution<AgentRunner> {
	return localExecution('claude', claudeBuild(options));
}

/** What builds the Claude executor of each seat. */
function claudeBuild(
	options: ClaudeExecutionOptions,
): () => (request: ConnectorRequest) => Executor {
	return () => (request) => createClaudeExecutor({ definition: request.definition, ...options });
}

/**
 * A room with no execution for a `claude` seat runs it on the default of the
 * kind. Loading the package defines that default, with no options.
 */
defineExecution('claude', claudeBuild({}));
