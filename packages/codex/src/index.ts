/**
 * The Codex adapter example: `codex()` defines an agent that runs on the
 * `codex app-server`, and `codexExecution()` gives a runtime or a room the
 * services that run it. The room tools are dynamic tools of the Codex thread.
 * `README.md` describes the path.
 */

export { codexExecution } from './compose.ts';
export { type CodexExecutor, type CodexOptions, codex } from './define.ts';
export type { CodexExecutionOptions } from './options.ts';
