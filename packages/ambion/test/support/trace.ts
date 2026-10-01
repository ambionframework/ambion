import type { TracedStep, TraceLogger, TraceStep } from '../../src/index.ts';

/** A logger that keeps every traced step it receives. The sink logs each step before the release. */
export function collectSteps() {
	const records: TracedStep[] = [];
	const logger: TraceLogger = (traced) => void records.push(traced);
	return {
		records,
		logger,
		/** The steps of one activation, in the order the logger received them. */
		of: (activation: string): TraceStep[] =>
			records.flatMap((record) => (record.step.activation === activation ? [record.step] : [])),
	};
}
