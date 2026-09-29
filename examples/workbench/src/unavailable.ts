import { type Execution, localExecution } from '@ambionframework/ambion/hosting';

/**
 * The execution for a family that cannot run. Each activation of a seat of
 * `kind` fails at once and gives the reason, and the core raises the error
 * event. The other seats keep running.
 */
export function unavailable(kind: string, reason: string): Execution {
	return localExecution(kind, () => (request) => ({
		open: () => ({
			async pass() {
				const message = `Seat '${request.seat}' cannot run: ${reason}`;
				return { failed: true, cause: 'permanent', message };
			},
		}),
	}));
}
