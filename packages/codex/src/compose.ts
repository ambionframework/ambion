/** The Codex execution: one Codex executor for each seat. */

import type {
	AgentRunner,
	ConnectorRequest,
	Execution,
	Executor,
} from '@ambionframework/ambion/hosting';
import { defineExecution, localExecution } from '@ambionframework/ambion/hosting';
import { createCodexExecutor } from './executor.ts';
import type { CodexRuntime } from './options.ts';

/** What the Codex execution runs with. Every field is optional. */
export type CodexExecutionOptions = CodexRuntime;

/**
 * The Codex execution for a runtime or a room. Pass it as `execution` to
 * `createRuntime`, `startRoom` or `resumeRoom`. The runtime supplies its
 * clock, limits, and logger when it builds the connector. It serves the
 * seats of kind `codex`. It does not change the default of that kind.
 */
export function codexExecution(options: CodexExecutionOptions = {}): Execution<AgentRunner> {
	return localExecution('codex', codexBuild(options));
}

/** What builds the Codex executor of each seat. */
function codexBuild(options: CodexExecutionOptions): () => (request: ConnectorRequest) => Executor {
	return () => (request) => createCodexExecutor({ definition: request.definition, ...options });
}

/**
 * A room with no execution for a `codex` seat runs it on the default of the
 * kind. Loading the package defines that default, with no options.
 */
defineExecution('codex', codexBuild({}));
