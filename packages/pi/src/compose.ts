/** Compose Pi execution services and a transport into one room connector. */

import type { Execution } from '@ambionframework/ambion/hosting';
import { composeConnector, registerDefaultExecution } from '@ambionframework/ambion/hosting';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { createPiExecutor } from './executor.ts';
import { createExecutionServices } from './services.ts';

export interface PiExecutionOptions {
	/**
	 * The model call. Absent, Pi's registry answers, keyed from the environment.
	 * A scripted stream makes every room deterministic; the model then
	 * resolves to a stub, because a custom stream never reads it.
	 */
	readonly stream?: StreamFn;
	/**
	 * The directory on the local disk where each seat keeps its Pi harness
	 * sessions. Absent, a custom stream keeps them in memory, and the
	 * registry stream keeps them in `ambion-pi-sessions-<uid>` in the OS
	 * temporary directory.
	 */
	readonly sessionDir?: string;
}

/**
 * The Pi execution for a runtime or a room. Pass it as `execution` to
 * `createRuntime`, `startRoom` or `resumeRoom`. The runtime supplies its
 * clock, limits, logger and transport when it builds the connector.
 */
export function piExecution(options: PiExecutionOptions = {}): Execution {
	return {
		connector: (host) => {
			const services = createExecutionServices({
				clock: host.clock,
				call: host.limits.call,
				trace: host.limits.trace,
				...(options.stream === undefined ? {} : { stream: options.stream }),
				...(options.sessionDir === undefined ? {} : { sessionDir: options.sessionDir }),
			});
			return composeConnector({
				host,
				traceLimits: services.trace,
				buildExecutor: (request) =>
					createPiExecutor({
						definition: request.definition,
						model: services.model,
						stream: services.stream,
						now: () => host.clock.now(),
						sessions: services.sessions,
					}),
			});
		},
	};
}

/**
 * A room with no `execution` runs each `pi` seat on this execution.
 * Loading the package registers it.
 */
registerDefaultExecution('pi', () => piExecution());
