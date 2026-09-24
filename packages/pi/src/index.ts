/**
 * The Pi executor for Ambion rooms: `pi()` defines an agent that runs on
 * Pi's `AgentHarness`, and `piExecution()` gives a runtime or a room the
 * services that run it. The kernel, `@ambionframework/ambion`, names no
 * model library. This package holds Pi and the model registry.
 */

export { type PiExecutionOptions, piExecution } from './compose.ts';
export { fromPiTool, type PiExecutor, type PiOptions, pi } from './define.ts';
export { createPiExecutor, type PiExecutorOptions } from './executor.ts';
export {
	createExecutionServices,
	type ExecutionServices,
	type ExecutionServicesOptions,
	type ModelResolver,
	type SessionPlace,
	stubModel,
} from './services.ts';
export { memorySessions, type PiSessions, type SessionScope } from './sessions.ts';

/** Kept in step with package.json by a test. */
export const PACKAGE_NAME = '@ambionframework/pi';
