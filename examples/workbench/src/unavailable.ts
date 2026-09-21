import {
	DEFAULT_TRACE,
	type Execution,
	type ExecutionHost,
	type Executor,
	type ExecutorSession,
	inProcessTransport,
	traceJournals,
	traceOpener,
} from '@ambionframework/ambion/hosting';

const TRACE_LIMITS = { toolOutputBytes: 65_536, stepsPerPass: 1_000 };

/** A session that fails each pass with the reason. It calls no model. */
function failing(message: string, report: (error: Error) => void): ExecutorSession {
	let cancelled = false;
	return {
		readThrough: 0,
		get cancelled() {
			return cancelled;
		},
		abort() {
			cancelled = true;
		},
		shouldRefresh: () => false,
		async pass() {
			report(new Error(message));
			return { failed: true, cause: 'permanent', message };
		},
	};
}

/**
 * The execution for a family that cannot run. Each activation of a seat on it
 * fails at once and gives the reason. The other seats keep running.
 */
export function unavailable(reason: string): Execution {
	return {
		connector(host: ExecutionHost) {
			const traces = traceJournals(host.storage);
			const transport = host.transport ?? inProcessTransport();
			return {
				connect(room, request) {
					const message = `Seat '${request.seat}' cannot run: ${reason}`;
					const executor: Executor = {
						open: (activation) =>
							failing(message, (error) =>
								activation.emit({
									type: 'error',
									agent: request.seat,
									activation: activation.id,
									error,
									cause: 'permanent',
								}),
							),
					};
					return transport.connect(room, {
						clock: host.clock,
						call: host.limits.call,
						definition: request.definition,
						room: request.room,
						seat: request.seat,
						executor,
						emit: request.emit,
						trace: traceOpener({
							room: request.room,
							agent: request.seat,
							traces,
							limits: TRACE_LIMITS,
							policy: request.definition.trace ?? DEFAULT_TRACE,
							emit: request.emit,
							now: () => host.clock.now(),
						}),
					});
				},
			};
		},
	};
}
