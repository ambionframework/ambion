import type { TraceLogger, TraceRecord, TraceStep } from '../../src/index.ts';

/** A logger that keeps every record it receives. The sink logs each step before the release. */
export function collectSteps() {
	const records: TraceRecord[] = [];
	const logger: TraceLogger = (record) => void records.push(record);
	return {
		records,
		logger,
		/** The steps of one activation, in the order the logger received them. */
		of: (activation: string): TraceStep[] =>
			records.flatMap((record) => (record.step.activation === activation ? [record.step] : [])),
	};
}
