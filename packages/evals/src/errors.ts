import type { JsonValue } from './json.ts';
import { toJsonValue } from './json.ts';
import type { EvalPhase, EvaluationError, SampleReport } from './types.ts';

export function makeError(phaseName: EvalPhase, error: unknown): EvaluationError {
	if (error instanceof Error) {
		let cause: JsonValue | undefined;
		if (error.cause !== undefined) {
			try {
				cause = toJsonValue(error.cause, `${phaseName} error cause`);
			} catch {
				cause = String(error.cause);
			}
		}
		return {
			phase: phaseName,
			name: error.name,
			message: error.message,
			...(error.stack === undefined ? {} : { stack: error.stack }),
			...(cause === undefined ? {} : { cause }),
		};
	}
	return { phase: phaseName, name: 'Error', message: String(error) };
}

export function isAssertionError(error: EvaluationError): boolean {
	return (
		error.name === 'AssertionError' ||
		error.name === 'AssertionError [ERR_ASSERTION]' ||
		error.message.startsWith('Expected ')
	);
}

export function addPersistenceError(sample: SampleReport, error: unknown): SampleReport {
	const persistence = makeError('persist', error);
	return {
		...sample,
		status: 'error',
		errors: [...sample.errors, persistence],
		outcome: { ...sample.outcome, errors: [...sample.outcome.errors, persistence] },
	};
}
