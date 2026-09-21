/**
 * The Codex adapter example: `codex()` defines an agent that runs on the
 * Codex SDK, and `codexExecution()` gives a runtime or a room the services
 * that run it. The room tools reach Codex through a stdio MCP server over a
 * local socket. `README.md` describes the path.
 */

export { type CodexExecutionOptions, codexExecution } from './compose.ts';
export { type CodexExecutor, type CodexOptions, type CodexPolicy, codex } from './define.ts';
export { type CodexExecutorOptions, createCodexExecutor } from './executor.ts';
export type { CodexRuntime } from './options.ts';
