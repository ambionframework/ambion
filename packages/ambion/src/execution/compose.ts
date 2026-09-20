/** Compose execution services and a transport into one room connector. */

import type { ExecutionConnector, Hosting, Runtime, Transport } from '../host/runtime.ts';
import { hostingOf } from '../host/runtime.ts';
import type { SeatRoom } from '../protocol.ts';
import { createPiExecutor } from './activation.ts';
import { inProcessTransport } from './runner.ts';
import { stubModel } from './services.ts';

/** Build one connector that captures this room's model stream and transport. */
export function composeExecution(
	runtime: Runtime,
	streamFn?: Hosting['stream'],
): ExecutionConnector {
	const hosting = hostingOf(runtime);
	const transport: Transport = hosting.transport ?? inProcessTransport();
	const stream = streamFn ?? hosting.stream;
	const model = streamFn === undefined ? hosting.model : stubModel;
	return {
		connect(room: SeatRoom, request) {
			const executor = createPiExecutor({
				definition: request.definition,
				model,
				stream,
				transcripts: hosting.transcripts,
				room: request.room,
				now: () => runtime.clock.now(),
			});
			return transport.connect(room, {
				clock: runtime.clock,
				call: hosting.limits.call,
				definition: request.definition,
				room: request.room,
				seat: request.seat,
				executor,
				emit: request.emit,
			});
		},
	};
}
