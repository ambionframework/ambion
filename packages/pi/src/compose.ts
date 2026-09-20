/** Compose Pi execution services and a transport into one room connector. */

import type {
	Execution,
	ExecutionConnector,
	ExecutionHost,
	RoomProtocol,
	Transport,
} from '@ambionframework/ambion/hosting';
import { inProcessTransport } from '@ambionframework/ambion/hosting';
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
}

/**
 * The Pi execution for a runtime or a room. Pass it as `execution` to
 * `createRuntime`, `startRoom` or `resumeRoom`. The runtime supplies its
 * clock, storage, limits and transport when it builds the connector.
 */
export function piExecution(options: PiExecutionOptions = {}): Execution {
	return { connector: (host) => connectorFor(host, options) };
}

function connectorFor(host: ExecutionHost, options: PiExecutionOptions): ExecutionConnector {
	const services = createExecutionServices({
		storage: host.storage,
		clock: host.clock,
		call: host.limits.call,
		...(options.stream === undefined ? {} : { stream: options.stream }),
	});
	const transport: Transport = host.transport ?? inProcessTransport();
	return {
		connect(room: RoomProtocol, request) {
			const executor = createPiExecutor({
				definition: request.definition,
				model: services.model,
				stream: services.stream,
				transcripts: services.transcripts,
				room: request.room,
				now: () => host.clock.now(),
			});
			return transport.connect(room, {
				clock: host.clock,
				call: host.limits.call,
				definition: request.definition,
				room: request.room,
				seat: request.seat,
				executor,
				emit: request.emit,
			});
		},
	};
}
