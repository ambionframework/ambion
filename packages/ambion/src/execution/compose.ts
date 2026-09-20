/** Compose execution services and a transport into one room connector. */

import { DEFAULT_TRACE } from '../define.ts';
import type { ExecutionConnector, Hosting, Runtime, Transport } from '../host/runtime.ts';
import { hostingOf } from '../host/runtime.ts';
import type { RoomProtocol } from '../protocol.ts';
import { createPiExecutor } from './activation.ts';
import { inProcessTransport } from './runner.ts';
import { stubModel } from './services.ts';
import { traceOpener } from './trace.ts';

/** Build one connector that captures this room's model stream and transport. */
export function composeExecution(
	runtime: Runtime,
	override?: Hosting['stream'],
): ExecutionConnector {
	const hosting = hostingOf(runtime);
	const transport: Transport = hosting.transport ?? inProcessTransport();
	const stream = override ?? hosting.stream;
	const model = override === undefined ? hosting.model : stubModel;
	return {
		connect(room: RoomProtocol, request) {
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
				trace: traceOpener({
					room: request.room,
					agent: request.seat,
					traces: hosting.traces,
					limits: hosting.limits.trace,
					policy: request.definition.trace ?? DEFAULT_TRACE,
					emit: request.emit,
					now: () => runtime.clock.now(),
				}),
			});
		},
	};
}
