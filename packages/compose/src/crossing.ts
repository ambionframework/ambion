/**
 * The JSON that crosses between a host and the code of a compose call: the
 * text of a binding value, and the text of a failure that a binding raised.
 * The code sees a failure as an `Error` with the same message and `details`.
 */
import type { EvaluatorInput, JsonValue } from '@ambionframework/ambion';

/** What a rejected binding carries: the message, and the details when JSON can hold them. */
export interface Failure {
	readonly message: string;
	readonly details?: JsonValue;
}

/** The JSON text of a binding value. A value that JSON cannot hold throws. */
export function valueText(value: JsonValue): string {
	return JSON.stringify(value) ?? 'null';
}

/** The message and the JSON details of what a binding rejected with. */
export function failureOf(failure: unknown): Failure {
	if (typeof failure !== 'object' || failure === null) return { message: String(failure) };
	const message = 'message' in failure ? String(failure.message) : String(failure);
	if (!('details' in failure) || failure.details === undefined) return { message };
	try {
		const details = JSON.parse(JSON.stringify(failure.details)) as JsonValue;
		return { message, details };
	} catch {
		return { message };
	}
}

/** The setup of the context: the code, the binding names, and `unlisted` and `args` when the input has them. */
export function configText(input: EvaluatorInput): string {
	const { code, bindings, unlisted, args } = input;
	return JSON.stringify({
		code,
		bindings,
		...(unlisted === undefined ? {} : { unlisted }),
		...(args === undefined ? {} : { args }),
	});
}
