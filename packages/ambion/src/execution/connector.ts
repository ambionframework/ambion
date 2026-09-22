/**
 * The connector composer: what every executor package wires the same way.
 *
 * A connector opens the trace journal over the host's storage, picks the
 * host's transport or the in-process default, and builds one seat's
 * execution context from the request the room sends. `seatContext` is the
 * inner value: the context one seat needs to run, with its trace opener
 * built from the definition's policy. `composeConnector` folds it into an
 * `ExecutionConnector`, and takes the executor build as a closure, so an
 * executor package supplies only what makes it different: how it builds one
 * seat's `Executor`, and what its trace keeps.
 */

import type { JournalOpener } from '@ambionframework/journal';
import { DEFAULT_TRACE } from '../define.ts';
import type {
	AgentExecutionContext,
	ConnectorRequest,
	ExecutionConnector,
	ExecutionHost,
	Limits,
} from '../host/runtime.ts';
import type { AgentDefinition, Clock, ExecutionEvent } from '../types.ts';
import type { Executor } from './executor.ts';
import { inProcessTransport } from './runner.ts';
import { traceJournals, traceOpener } from './trace.ts';

/** What one seat needs to run: its definition, its executor, and where its trace goes. */
export interface SeatContextInput {
	readonly clock: Clock;
	readonly call: Limits['call'];
	readonly definition: AgentDefinition;
	readonly room: string;
	readonly seat: string;
	readonly executor: Executor;
	readonly emit: (event: ExecutionEvent) => void;
	readonly traces: JournalOpener;
	readonly limits: Limits['trace'];
}

/** The context of one seat, with its trace opener built from the definition's policy. */
export function seatContext(input: SeatContextInput): AgentExecutionContext {
	const { traces, limits, ...rest } = input;
	return {
		...rest,
		trace: traceOpener({
			room: input.room,
			agent: input.seat,
			traces,
			limits,
			policy: input.definition.trace ?? DEFAULT_TRACE,
			emit: input.emit,
			now: () => input.clock.now(),
		}),
	};
}

/** What an execution package gives the composer. */
export interface ConnectorComposition {
	readonly host: ExecutionHost;
	/** Builds the executor of one seat. The composer calls it once per connect. */
	buildExecutor(request: ConnectorRequest): Executor;
	/** What the trace keeps. Pi passes the host's; Claude and Codex pass `DEFAULT_TRACE_LIMITS`. */
	readonly traceLimits: Limits['trace'];
}

/** One `ExecutionConnector`, wired from an executor package's own build and trace limits. */
export function composeConnector(composition: ConnectorComposition): ExecutionConnector {
	const { host, buildExecutor, traceLimits } = composition;
	const traces = traceJournals(host.storage);
	const transport = host.transport ?? inProcessTransport();
	return {
		connect(room, request) {
			return transport.connect(
				room,
				seatContext({
					clock: host.clock,
					call: host.limits.call,
					definition: request.definition,
					room: request.room,
					seat: request.seat,
					executor: buildExecutor(request),
					emit: request.emit,
					traces,
					limits: traceLimits,
				}),
			);
		},
	};
}
