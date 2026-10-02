/** The Codex execution: one Codex executor for each seat. */

import { defineExecution } from '@ambionframework/ambion/hosting';
import { createCodexOpener } from './executor.ts';
import type { CodexExecutionOptions } from './options.ts';

/**
 * The Codex execution for a runtime or a room. Pass it as `execution` to
 * `createRuntime`, `startRoom` or `resumeRoom`. It serves the seats of kind
 * `codex`. It does not change the default of that kind. Loading the package
 * defines that default, with no options.
 */
export const codexExecution = defineExecution<CodexExecutionOptions>(
	'codex',
	(_host, options) => (request) =>
		createCodexOpener({ definition: request.definition, ...options }),
);
