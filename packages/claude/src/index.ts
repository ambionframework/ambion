/**
 * The Claude executor for Ambion rooms: `claude()` defines an agent that
 * runs on the Claude Agent SDK, and `claudeExecution()` gives a runtime or
 * a room the services that run it. The kernel, `@ambionframework/ambion`,
 * names no model library. This package holds the Claude Agent SDK.
 */

export { type ClaudeExecutor, type ClaudeOptions, type ClaudePolicy, claude } from './define.ts';
export { claudeExecution } from './execution.ts';
export type { ClaudeExecutionOptions } from './options.ts';

/** Kept in step with package.json by a test. */
export const PACKAGE_NAME = '@ambionframework/claude';
