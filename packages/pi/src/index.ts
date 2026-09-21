/**
 * The Pi executor for Ambion rooms: `pi()` defines an agent that runs on
 * Pi's model loop, and `piExecution()` gives a runtime or a room the
 * services that run it. The kernel, `@ambionframework/ambion`, names no
 * model library. This package holds Pi, the model registry, and the audit
 * of each seat's transcript.
 */

export { type PiExecutionOptions, piExecution } from './compose.ts';
export { fromPiTool, type PiExecutor, type PiOptions, pi } from './define.ts';
export { createPiExecutor, type PiExecutorOptions } from './executor.ts';
export {
	createExecutionServices,
	type ExecutionServices,
	type ExecutionServicesOptions,
	type ModelResolver,
	seatSessionId,
	stubModel,
} from './services.ts';

/** Kept in step with package.json by a test. */
export const PACKAGE_NAME = '@ambionframework/pi';
