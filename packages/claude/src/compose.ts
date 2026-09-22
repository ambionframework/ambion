/** Compose the Claude executor and a transport into one room connector. */

import type { Execution } from '@ambionframework/ambion/hosting';
import {
	composeConnector,
	DEFAULT_TRACE_LIMITS,
	registerDefaultExecution,
} from '@ambionframework/ambion/hosting';
import { createClaudeExecutor } from './executor.ts';
import type { ClaudeRuntime } from './options.ts';

/** What the Claude execution runs with. Every field is optional. */
export type ClaudeExecutionOptions = ClaudeRuntime;

/**
 * The Claude execution for a runtime or a room. Pass it as `execution` to
 * `createRuntime`, `startRoom` or `resumeRoom`. The runtime supplies its
 * clock, storage, limits and transport when it builds the connector.
 */
export function claudeExecution(options: ClaudeExecutionOptions = {}): Execution {
	return {
		connector: (host) =>
			composeConnector({
				host,
				traceLimits: DEFAULT_TRACE_LIMITS,
				buildExecutor: (request) =>
					createClaudeExecutor({ definition: request.definition, ...options }),
			}),
	};
}

/**
 * A room with no `execution` runs each `claude` seat on this execution.
 * Loading the package registers it.
 */
registerDefaultExecution('claude', () => claudeExecution());
