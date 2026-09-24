import {
	composeConnector,
	type Execution,
	type ExecutionHost,
	type ExecutorSession,
} from '@ambionframework/ambion/hosting';

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
		connector: (host: ExecutionHost) =>
			composeConnector({
				host,
				traceLimits: host.limits.trace,
				buildExecutor: (request) => ({
					open: (activation) =>
						failing(`Seat '${request.seat}' cannot run: ${reason}`, (error) =>
							activation.emit({
								type: 'error',
								agent: request.seat,
								activation: activation.id,
								error,
								cause: 'permanent',
							}),
						),
				}),
			}),
	};
}
