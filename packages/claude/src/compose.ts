/** The Claude execution: one Claude executor for each seat. */

import { defineExecution } from '@ambionframework/ambion/hosting';
import { createClaudeOpener } from './executor.ts';
import type { ClaudeExecutionOptions } from './options.ts';

/**
 * The Claude execution for a runtime or a room. Pass it as `execution` to
 * `createRuntime`, `startRoom` or `resumeRoom`. It serves the seats of kind
 * `claude`. It does not change the default of that kind. Loading the package
 * defines that default, with no options.
 */
export const claudeExecution = defineExecution<ClaudeExecutionOptions>(
	'claude',
	(_host, options) => (request) =>
		createClaudeOpener({
			definition: request.definition,
			room: request.room,
			seat: request.seat,
			...options,
		}),
);
