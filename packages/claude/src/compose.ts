/** Compose the Claude executor and a transport into one room connector. */

import type {
	Execution,
	ExecutionConnector,
	ExecutionHost,
	RoomProtocol,
	Transport,
} from '@ambionframework/ambion/hosting';
import {
	DEFAULT_TRACE,
	inProcessTransport,
	registerDefaultExecution,
	traceJournals,
	traceOpener,
} from '@ambionframework/ambion/hosting';
import { createClaudeExecutor } from './executor.ts';
import type { ClaudeRuntime } from './options.ts';

/** What the Claude execution runs with. Every field is optional. */
export type ClaudeExecutionOptions = ClaudeRuntime;

/** What the trace keeps of a step, and how many steps one pass keeps. */
const TRACE_LIMITS = { toolOutputBytes: 65_536, stepsPerPass: 1_000 };

/**
 * The Claude execution for a runtime or a room. Pass it as `execution` to
 * `createRuntime`, `startRoom` or `resumeRoom`. The runtime supplies its
 * clock, storage, limits and transport when it builds the connector.
 */
export function claudeExecution(options: ClaudeExecutionOptions = {}): Execution {
	return { connector: (host) => connectorFor(host, options) };
}

/**
 * A room with no `execution` runs each `claude` seat on this execution.
 * Loading the package registers it.
 */
registerDefaultExecution('claude', () => claudeExecution());

function connectorFor(host: ExecutionHost, options: ClaudeExecutionOptions): ExecutionConnector {
	const traces = traceJournals(host.storage);
	const transport: Transport = host.transport ?? inProcessTransport();
	return {
		connect(room: RoomProtocol, request) {
			const executor = createClaudeExecutor({ definition: request.definition, ...options });
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
}
