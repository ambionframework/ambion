import type { TraceOpener, TraceSink } from '@ambionframework/ambion/hosting';

/** A sink that keeps nothing, for a test that drives an executor or a driver by hand. */
export const noTrace: TraceSink = {
	startPass: () => {},
	record: () => {},
	usage: () => undefined,
	close: async () => {},
};

export const noTraces: TraceOpener = { open: () => noTrace };
