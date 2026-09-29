/** The Pi execution: Pi's model services and one Pi executor for each seat. */

import type {
	AgentRunner,
	ConnectorRequest,
	Execution,
	ExecutionHost,
	Executor,
} from '@ambionframework/ambion/hosting';
import { defineExecution, localExecution } from '@ambionframework/ambion/hosting';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { createPiExecutor } from './executor.ts';
import { createExecutionServices, type SessionPlace } from './services.ts';

export interface PiExecutionOptions {
	/**
	 * The model call. Absent, Pi's registry answers, keyed from the environment.
	 * A scripted stream makes every room deterministic; the model then
	 * resolves to a stub, because a custom stream never reads it.
	 */
	readonly stream?: StreamFn;
	/**
	 * Where each seat keeps its Pi harness sessions. Absent, `'disk'`.
	 * `'memory'` keeps them for as long as the connector lives, as a test does.
	 */
	readonly sessions?: SessionPlace;
	/**
	 * The directory on the local disk for the sessions. Absent,
	 * `ambion-pi-sessions-<uid>` in the OS temporary directory.
	 */
	readonly sessionDir?: string;
}

/**
 * The Pi execution for a runtime or a room. Pass it as `execution` to
 * `createRuntime`, `startRoom` or `resumeRoom`. The runtime supplies its
 * clock, limits, and logger when it builds the connector. It serves the
 * seats of kind `pi`. It does not change the default of that kind.
 */
export function piExecution(options: PiExecutionOptions = {}): Execution<AgentRunner> {
	return localExecution('pi', piBuild(options));
}

/** What builds the Pi executor of each seat, over the host of one connector. */
function piBuild(
	options: PiExecutionOptions,
): (host: ExecutionHost) => (request: ConnectorRequest) => Executor {
	return (host) => {
		const services = createExecutionServices({
			clock: host.clock,
			call: host.limits.call,
			trace: host.limits.trace,
			...(options.stream === undefined ? {} : { stream: options.stream }),
			...(options.sessions === undefined ? {} : { sessions: options.sessions }),
			...(options.sessionDir === undefined ? {} : { sessionDir: options.sessionDir }),
		});
		return (request) =>
			createPiExecutor({
				definition: request.definition,
				model: services.model,
				stream: services.stream,
				now: () => host.clock.now(),
				sessions: services.sessions,
			});
	};
}

/**
 * A room with no execution for a `pi` seat runs it on the default of the
 * kind. Loading the package defines that default, with no options.
 */
defineExecution('pi', piBuild({}));
