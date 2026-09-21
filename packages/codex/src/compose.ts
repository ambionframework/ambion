/** Compose the Codex executor and a transport into one room connector. */

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
import { createCodexExecutor } from './executor.ts';
import type { CodexRuntime } from './options.ts';

/** What the Codex execution runs with. Every field is optional. */
export type CodexExecutionOptions = CodexRuntime;

/** What the trace keeps of a step, and how many steps one pass keeps. */
const TRACE_LIMITS = { toolOutputBytes: 65_536, stepsPerPass: 1_000 };

/**
 * The Codex execution for a runtime or a room. Pass it as `execution` to
 * `createRuntime`, `startRoom` or `resumeRoom`. The runtime supplies its
 * clock, storage, limits and transport when it builds the connector.
 */
export function codexExecution(options: CodexExecutionOptions = {}): Execution {
	return { connector: (host) => connectorFor(host, options) };
}

/**
 * A room with no `execution` runs each `codex` seat on this execution.
 * Loading the package registers it.
 */
registerDefaultExecution('codex', () => codexExecution());

function connectorFor(host: ExecutionHost, options: CodexExecutionOptions): ExecutionConnector {
	const traces = traceJournals(host.storage);
	const transport: Transport = host.transport ?? inProcessTransport();
	return {
		connect(room: RoomProtocol, request) {
			const executor = createCodexExecutor({ definition: request.definition, ...options });
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
