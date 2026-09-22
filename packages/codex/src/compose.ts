/** Compose the Codex executor and a transport into one room connector. */

import type { Execution } from '@ambionframework/ambion/hosting';
import {
	composeConnector,
	DEFAULT_TRACE_LIMITS,
	registerDefaultExecution,
} from '@ambionframework/ambion/hosting';
import { createCodexExecutor } from './executor.ts';
import type { CodexRuntime } from './options.ts';

/** What the Codex execution runs with. Every field is optional. */
export type CodexExecutionOptions = CodexRuntime;

/**
 * The Codex execution for a runtime or a room. Pass it as `execution` to
 * `createRuntime`, `startRoom` or `resumeRoom`. The runtime supplies its
 * clock, storage, limits and transport when it builds the connector.
 */
export function codexExecution(options: CodexExecutionOptions = {}): Execution {
	return {
		connector: (host) =>
			composeConnector({
				host,
				traceLimits: DEFAULT_TRACE_LIMITS,
				buildExecutor: (request) =>
					createCodexExecutor({ definition: request.definition, ...options }),
			}),
	};
}

/**
 * A room with no `execution` runs each `codex` seat on this execution.
 * Loading the package registers it.
 */
registerDefaultExecution('codex', () => codexExecution());
