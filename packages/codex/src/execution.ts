/** The Codex execution: one Codex executor for each seat. */

import { localExecution } from '@ambionframework/ambion/hosting';
import { createCodexOpener } from './executor.ts';
import type { CodexExecutionOptions } from './options.ts';

/**
 * The Codex execution for a runtime or a room. Pass it as `execution` to
 * `createRuntime`, `startRoom` or `resumeRoom`. It serves the seats of kind
 * `codex`.
 */
export function codexExecution(options: CodexExecutionOptions = {}) {
	return localExecution(
		'codex',
		() => (request) => createCodexOpener({ definition: request.definition, ...options }),
	);
}
