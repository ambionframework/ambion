/**
 * The router: how a room picks the execution for a seat by executor kind.
 *
 * `localExecution` builds the execution of one executor kind.
 * `defineExecution` defines an executor kind: the executions of one kind,
 * by options, and the default of that kind. `route` serves every seat of a room: the first execution of the
 * room or its runtime that serves the kind of the seat, else the default of
 * the kind. On a miss, the activation fails at once with a permanent
 * `no_execution` error, and the room does not send the wake again.
 */

import { AmbionError } from '../errors.ts';
import type {
	ConnectorRequest,
	Execution,
	ExecutionConnector,
	ExecutionHost,
} from '../host/runtime.ts';
import type { ActivationOpener } from '../protocol.ts';
import { localConnector } from './connector.ts';
import type { AgentRunner } from './runner.ts';

/** The execution that each kind defined last. A room with no execution for a kind runs it. */
const defaults = new Map<string, Execution>();

/**
 * The execution of one executor kind. `build` runs once for each connector,
 * over the host of the runtime, and returns what builds the executor of one
 * seat. Each seat runs as an `AgentRunner` in this process, with the trace
 * limits of the host. The execution does not change the default of `kind`.
 */
export function localExecution(
	kind: string,
	build: (host: ExecutionHost) => (request: ConnectorRequest) => ActivationOpener,
): Execution<AgentRunner> {
	return { kind, connector: (host) => localConnector(host, build(host)) };
}

/**
 * What builds the executor of one seat, over the host of one connector. An
 * executor kind reads its own options here. The default of the kind
 * builds with no options.
 */
type ExecutionBuild<Options> = (
	host: ExecutionHost,
	options: Options | undefined,
) => (request: ConnectorRequest) => ActivationOpener;

/**
 * The executions of one executor kind. The result takes the options of the
 * kind and returns an execution that `localExecution` builds. The call also
 * makes the execution with no options the default of `kind`: a room with no
 * execution for a seat of that kind runs it. A later definition of the same
 * kind replaces the default. An executor package defines its kind once,
 * when the package loads.
 */
export function defineExecution<Options = undefined>(
	kind: string,
	build: ExecutionBuild<Options>,
): (options?: Options) => Execution<AgentRunner> {
	const execution = (options?: Options) => localExecution(kind, (host) => build(host, options));
	defaults.set(kind, execution());
	return execution;
}

/** What `route` serves a room from. */
export interface RouteInput {
	/** The executions of the room, then those of its runtime, in order. */
	readonly executions: readonly Execution[];
	readonly host: ExecutionHost;
	/** The connectors of the defaults that the runtime built, by kind. The route adds each one it builds. */
	readonly built: Map<string, ExecutionConnector>;
}

/**
 * The connector of one room. A seat runs on the first execution that serves
 * its kind, else on the default of its kind, else it fails at once with a
 * permanent `no_execution` error. Each execution builds its connector once,
 * on the first seat that it serves.
 */
export function route(input: RouteInput): ExecutionConnector {
	const { host, built } = input;
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
		const known = built.get(kind);
		if (known !== undefined) return known;
		const fallback = defaults.get(kind);
		if (fallback === undefined) return missing;
		const connector = fallback.connector(host);
		built.set(kind, connector);
		return connector;
	};
	return {
		connect: (room, request) =>
			connectorOf(request.definition.executor.kind).connect(room, request),
	};
}

/** The kinds that the executions of the room and its runtime and the defaults serve, sorted. */
function knownKinds(input: RouteInput): string {
	const kinds = new Set(defaults.keys());
	for (const execution of input.executions) {
		if (execution.kind !== undefined) kinds.add(execution.kind);
	}
	return kinds.size === 0 ? 'none' : [...kinds].sort().join(', ');
}

/** The opener of a seat with no execution: each activation fails at once, and a retry cannot fix it. */
function missingOpener(request: ConnectorRequest, known: string): ActivationOpener {
	const seat = request.seat;
	const reason = `No execution serves seat '${seat}' of kind '${request.definition.executor.kind}'. Load the executor package of the kind, or pass an \`execution\` of the kind, such as \`piExecution()\` from @ambionframework/pi, to startRoom or createRuntime. Known kinds: ${known}.`;
	return () => {
		const error = new AmbionError('no_execution', reason);
		return {
			pass: async () => ({ failed: true, cause: 'permanent', message: reason, error }),
		};
	};
}
