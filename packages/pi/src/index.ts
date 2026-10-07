/**
 * The Pi executor for Ambion rooms: `pi()` defines an agent that runs on
 * the pi-durable harness, and `piExecution()` gives a runtime or a room the
 * services that run it. The kernel, `@ambionframework/ambion`, names no
 * model library. This package holds Pi and the model registry.
 */

export { fileCredentials } from './credentials.ts';
export {
	type CompactionOptions,
	fromPiTool,
	type NativePiTool,
	type PiChoice,
	type PiExecutor,
	type PiOptions,
	pi,
	type ThinkingLevel,
} from './define.ts';
export { piExecution } from './execution.ts';
export { loginPi, type TerminalStreams, terminalInteraction } from './login.ts';
export type { StreamFn } from './models.ts';
export {
	type RunAgentCall,
	type RunAgentRequest,
	type RunAgentResult,
	runAgent,
} from './run-agent.ts';
export {
	createExecutionServices,
	type ExecutionServices,
	type ModelResolver,
	type PiExecutionOptions,
	stubModel,
} from './services.ts';
export {
	type CreatedSession,
	memorySessions,
	type PiSessions,
	type SessionScope,
} from './sessions.ts';

/** Kept in step with package.json by a test. */
export const PACKAGE_NAME = '@ambionframework/pi';
