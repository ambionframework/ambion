/** One operation shared by concurrent callers. */
export interface SingleFlight<T> {
	promise?: Promise<T> | undefined;
}

/** Clear failures for retry. Keep a successful promise only when the operation is final. */
export function singleFlight<T>(
	flight: SingleFlight<T>,
	start: () => Promise<T>,
	retainSuccess = false,
): Promise<T> {
	if (flight.promise !== undefined) return flight.promise;
	const operation = start().then(
		(result) => {
			if (!retainSuccess && flight.promise === operation) flight.promise = undefined;
			return result;
		},
		(error: unknown) => {
			if (flight.promise === operation) flight.promise = undefined;
			throw error;
		},
	);
	flight.promise = operation;
	return operation;
}
