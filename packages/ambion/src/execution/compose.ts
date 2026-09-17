/** Compose execution services and a transport into one room connector. */

import type { ExecutionConnector, Runtime, Transport } from '../host/runtime.ts';
import type { SeatRoom } from '../protocol.ts';
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
			return transport.connect(room, {
				clock: runtime.clock,
				call: runtime.call,
				definition: request.definition,
				room: request.room,
				seat: request.seat,
				transcripts: runtime.transcripts,
				stream,
				model,
				emit: request.emit,
			});
		},
	};
}
