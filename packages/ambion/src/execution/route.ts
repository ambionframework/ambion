/**
 * The router selects the first supplied execution for each seat's executor
 * kind. A seat with no execution fails with a permanent `no_execution` error.
 */

import { AmbionError } from '../errors.ts';
import type {
	ConnectorRequest,
	Execution,
	ExecutionConnector,
	ExecutionHost,
} from '../host/runtime.ts';
import { localConnector } from './connector.ts';
import type { ActivationOpener } from './contract.ts';
import type { AgentRunner } from './runner.ts';

/**
 * The execution of one executor kind. `build` runs once for each connector,
 * over the host of the runtime, and returns what builds the executor of one
 * seat. Each seat runs as an `AgentRunner` in this process, with the trace
 * limits of the host.
 */
export function localExecution(
	kind: string,
	build: (host: ExecutionHost) => (request: ConnectorRequest) => ActivationOpener,
): Execution<AgentRunner> {
	return { kind, connector: (host) => localConnector(host, build(host)) };
}

/** What `route` serves a room from. */
export interface RouteInput {
	/** The executions of the room, then those of its runtime, in order. */
	readonly executions: readonly Execution[];
	readonly host: ExecutionHost;
}

/**
 * The connector of one room. A seat runs on the first execution that serves
 * its kind. With no matching execution, it fails at once with a
 * permanent `no_execution` error. Each execution builds its connector once,
 * on the first seat that it serves.
 */
export function route(input: RouteInput): ExecutionConnector {
	const { host } = input;
	const connectors = new Map<Execution, ExecutionConnector>();
	const explicit = (execution: Execution): ExecutionConnector => {
		const known = connectors.get(execution) ?? execution.connector(host);
		connectors.set(execution, known);
		return known;
	};
	const missing = localConnector(host, (request) => missingOpener(request, knownKinds(input)));
	const connectorOf = (kind: string): ExecutionConnector => {
		const execution = input.executions.find((one) => one.kind === undefined || one.kind === kind);
		if (execution !== undefined) return explicit(execution);
		return missing;
	};
	return {
		connect: (room, request) =>
			connectorOf(request.definition.executor.kind).connect(room, request),
	};
}

/** The kinds that the supplied executions serve, sorted. */
function knownKinds(input: RouteInput): string {
	const kinds = new Set<string>();
	for (const execution of input.executions) {
		if (execution.kind !== undefined) kinds.add(execution.kind);
	}
	return kinds.size === 0 ? 'none' : [...kinds].sort().join(', ');
}

/** The opener of a seat with no execution: each activation fails at once, and a retry cannot fix it. */
function missingOpener(request: ConnectorRequest, known: string): ActivationOpener {
	const seat = request.seat;
	const reason = `No execution serves seat '${seat}' of kind '${request.definition.executor.kind}'. Pass an \`execution\` of the kind, such as \`piExecution()\` from @ambionframework/pi, to startRoom or createRuntime. Known kinds: ${known}.`;
	return () => {
		const error = new AmbionError('no_execution', reason);
		return {
			pass: async () => ({ failed: true, cause: 'permanent', message: reason, error }),
		};
	};
}
