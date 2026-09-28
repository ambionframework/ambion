/**
 * The routers: how a room picks the execution for a seat by executor kind.
 *
 * `composeExecutions` routes each seat to the execution named for its kind.
 * `missingConnector` serves a seat whose kind no execution serves. Every
 * router ends in it on a miss, so each miss fails the same way: the
 * activation fails at once with a permanent `no_execution` error, and the
 * room does not send the wake again.
 */

import { AmbionError } from '../errors.ts';
import type {
	ConnectorRequest,
	Execution,
	ExecutionConnector,
	ExecutionHost,
} from '../host/runtime.ts';
import { composeConnector } from './connector.ts';
import type { Executor } from './executor.ts';

/**
 * One execution for a room whose seats run on different executor families.
 * It routes each seat to the execution named for the `kind` of its executor,
 * such as `{ pi: piExecution(), claude: claudeExecution() }`. Each activation
 * of a seat of another kind fails at once with a permanent `no_execution`
 * error.
 */
export function composeExecutions(byKind: Readonly<Record<string, Execution>>): Execution {
	return {
		connector(host) {
			const connectors = new Map(
				Object.entries(byKind).map(([kind, execution]) => [kind, execution.connector(host)]),
			);
			const known = [...connectors.keys()].join(', ');
			const missing = missingConnector(
				host,
				(request) =>
					`No execution serves seat '${request.seat}' of kind '${request.definition.executor.kind}'. Known kinds: ${known}.`,
			);
			return {
				connect(room, request) {
					const connector = connectors.get(request.definition.executor.kind) ?? missing;
					return connector.connect(room, request);
				},
			};
		},
	};
}

/**
 * The connector for a seat whose kind has no execution. Each activation
 * fails at once with a permanent `no_execution` error that `reason` states.
 */
export function missingConnector(
	host: ExecutionHost,
	reason: (request: ConnectorRequest) => string,
): ExecutionConnector {
	return composeConnector({
		host,
		traceLimits: host.limits.trace,
		buildExecutor: (request) => missingExecutor(request.seat, reason(request)),
	});
}

/** The executor of a seat with no execution: each activation fails at once, and a retry cannot fix it. */
function missingExecutor(seat: string, reason: string): Executor {
	return {
		open(activation) {
			const error = new AmbionError('no_execution', reason);
			return {
				readThrough: 0,
				cancelled: false,
				async pass() {
					activation.emit({
						type: 'error',
						agent: seat,
						activation: activation.id,
						error,
						cause: 'permanent',
					});
					return { failed: true, cause: 'permanent' };
				},
				shouldRefresh: () => false,
				abort() {},
			};
		},
	};
}
