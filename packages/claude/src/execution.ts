/** The Claude execution: one Claude executor for each seat. */

import { localExecution } from '@ambionframework/ambion/hosting';
import { createClaudeOpener } from './executor.ts';
import type { ClaudeExecutionOptions } from './options.ts';

/**
 * The Claude execution for a runtime or a room. Pass it as `execution` to
 * `createRuntime`, `startRoom` or `resumeRoom`. It serves the seats of kind
 * `claude`.
 */
export function claudeExecution(options: ClaudeExecutionOptions = {}) {
	return localExecution(
		'claude',
		() => (request) =>
			createClaudeOpener({
				definition: request.definition,
				room: request.room,
				seat: request.seat,
				...options,
			}),
	);
}
