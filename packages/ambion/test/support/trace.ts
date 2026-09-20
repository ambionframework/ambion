import { readTrace, type TraceOpener, type TraceSink } from '../../src/execution/trace.ts';
import { hostingOf } from '../../src/hosting.ts';
import type { Runtime, TraceStep } from '../../src/index.ts';

/** A sink that keeps nothing, for a test that drives an executor or a driver by hand. */
export const noTrace: TraceSink = {
	startPass: () => {},
	record: () => {},
	usage: () => undefined,
	close: async () => {},
};

export const noTraces: TraceOpener = { open: () => noTrace };

/**
 * The steps of one activation, once its `end` step landed. The driver
 * closes the trace after it releases the lease, so a room that reports
 * quiet may still be writing.
 */
export async function traceOf(
	runtime: Runtime,
	room: string,
	activation: string,
): Promise<TraceStep[]> {
	const traces = hostingOf(runtime).traces;
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const steps = await readTrace(traces, room, activation);
		if (steps.some((step) => step.type === 'end')) return steps;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	return readTrace(traces, room, activation);
}
