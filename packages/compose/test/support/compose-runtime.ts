/**
 * A runtime for tests: it runs the code as the body of an `AsyncFunction`
 * in the process of the test. It gives the code a `tools` proxy and the
 * global `args` of a macro, and it has
 * none of the isolation of a real runtime, so only tests import it.
 */
import type { ComposeRuntime, ComposeRuntimeInput, JsonValue } from '../../src/index.ts';

type Body = (tools: unknown, args: JsonValue | undefined) => Promise<JsonValue | undefined>;

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
	tools: string,
	args: string,
	code: string,
) => Body;

/** The `Error` that code reads from a rejected binding: the message, and the details. */
function errorOf(failure: unknown): Error {
	const { message, details } = failure as { message: string; details?: JsonValue };
	return Object.assign(new Error(message), details === undefined ? {} : { details });
}

/** One binding for each name that the code reads, so a name outside `uses` reaches `compose`. */
function bindingsOf(input: ComposeRuntimeInput, signal: AbortSignal): unknown {
	return new Proxy(
		{},
		{
			get: (_target, name) => (args: JsonValue) => {
				if (typeof name !== 'string') return undefined;
				const call = signal.aborted
					? Promise.reject(new Error('The runtime was cut.'))
					: input.call(name, args).catch((failure: unknown) => {
							throw errorOf(failure);
						});
				// Code that drops the promise of a call leaves its rejection unobserved, as in a real guest.
				call.catch(() => {});
				return call;
			},
		},
	);
}

/** Runs the code in the test process, and stops waiting for it at the signal. */
export const functionRuntime: ComposeRuntime = {
	async evaluate(input, signal) {
		const run = new AsyncFunction('tools', 'args', input.code);
		const cut = new Promise<never>((_resolve, reject) => {
			signal.addEventListener('abort', () => reject(new Error('The runtime was cut.')), {
				once: true,
			});
		});
		cut.catch(() => {});
		return Promise.race([run(bindingsOf(input, signal), input.args), cut]);
	},
};
