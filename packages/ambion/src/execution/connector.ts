/**
 * The local connector: each seat runs as an `AgentRunner` in this process.
 *
 * `seatContext` is the inner value: the context one seat needs to run, with
 * a trace opener over the host's logger, the host's trace limits, and the
 * definition's policy. `localConnector` builds one runner for each seat
 * that the room connects, over the executor that `executorOf` builds.
 */

import { DEFAULT_TRACE } from '../define.ts';
import type {
	AgentExecutionContext,
	ConnectorRequest,
	ExecutionConnector,
	ExecutionHost,
	Limits,
} from '../host/runtime.ts';
import type { ActivationEvent, AgentDefinition, Clock, TraceLogger } from '../types.ts';
import type { Executor } from './executor.ts';
import { AgentRunner } from './runner.ts';
import { traceOpener } from './trace.ts';

/** What one seat needs to run: its definition, its executor, and where its trace goes. */
export interface SeatContextInput {
	readonly clock: Clock;
	readonly call: Limits['call'];
	readonly definition: AgentDefinition;
	readonly room: string;
	readonly seat: string;
	readonly executor: Executor;
	readonly emit: (event: ActivationEvent) => void;
	/** Where the steps of each activation go. Absent, the trace drops them. */
	readonly logger?: TraceLogger;
	readonly limits: Limits['trace'];
}

/** The context of one seat, with its trace opener built from the definition's policy. */
export function seatContext(input: SeatContextInput): AgentExecutionContext {
	const { logger, limits, ...rest } = input;
	return {
		...rest,
		trace: traceOpener({
			room: input.room,
			seat: input.seat,
			logger,
			limits,
			policy: input.definition.trace ?? DEFAULT_TRACE,
			now: () => input.clock.now(),
		}),
	};
}

/** A connector that runs each seat in this process, on the executor that `executorOf` builds for it. */
export function localConnector(
	host: ExecutionHost,
	executorOf: (request: ConnectorRequest) => Executor,
): ExecutionConnector<AgentRunner> {
	return {
		connect(room, request) {
			return new AgentRunner(
				room,
				seatContext({
					clock: host.clock,
					call: host.limits.call,
					definition: request.definition,
					room: request.room,
					seat: request.seat,
					executor: executorOf(request),
					emit: request.emit,
					logger: host.logger,
					limits: host.limits.trace,
				}),
			);
		},
	};
}
