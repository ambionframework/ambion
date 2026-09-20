/** Compose execution services and a transport into one room connector. */

import type { ExecutionConnector, Runtime, Transport } from '../host/runtime.ts';
import type { SeatRoom } from '../protocol.ts';
import { createPiExecutor } from './activation.ts';
import { inProcessTransport } from './runner.ts';
import { stubModel } from './services.ts';

/** Build one connector that captures this room's model stream and transport. */
export function composeExecution(
	runtime: Runtime,
	streamFn?: Runtime['stream'],
): ExecutionConnector {
	const transport: Transport = runtime.transport ?? inProcessTransport();
	const stream = streamFn ?? runtime.stream;
	const model = streamFn === undefined ? runtime.model : stubModel;
	return {
		connect(room: SeatRoom, request) {
			const executor = createPiExecutor({
				definition: request.definition,
				model,
				stream,
				transcripts: runtime.transcripts,
				room: request.room,
				now: () => runtime.clock.now(),
			});
			return transport.connect(room, {
				clock: runtime.clock,
				call: runtime.call,
				definition: request.definition,
				room: request.room,
				seat: request.seat,
				executor,
				emit: request.emit,
			});
		},
	};
}
