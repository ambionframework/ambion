/**
 * The runtime: what a host owns and every room borrows.
 *
 * A record lives in a repo, a provider's key comes from an environment, and a
 * model is resolved in a registry. All three are fields of a value the host
 * builds with `createRuntime` and passes to `startSession`, `readSession` and
 * `defineWorkspace`. The value also keeps what those calls remember between
 * them: which names are running, and which workspace names are taken. Two
 * runtimes in one process share nothing. A call without a runtime uses the
 * default instance, which holds an in-memory repo, `process.env` and Pi's
 * builtin registry.
 */
import { InMemorySessionRepo } from '@earendil-works/pi-agent-core';
import type { Models } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import {
	isRuntime,
	RUNTIME_BRAND,
	type Runtime,
	type RuntimeOptions,
	type Session,
} from './types.ts';

/** What the public value does not show: the names running, and the workspace names taken. */
export interface RuntimeState extends Runtime {
	/** One run per name: a second live room over one record would diverge from it. */
	readonly running: Map<string, Session>;
	/** One handle per name: two handles over one backend would each destroy it. */
	readonly taken: Set<string>;
}

/**
 * Builds a runtime. Every option is optional: a missing repo is a fresh
 * `InMemorySessionRepo`, a missing environment source reads `process.env`,
 * and a missing registry is Pi's builtin catalog, built on first use.
 */
export function createRuntime(options: RuntimeOptions = {}): Runtime {
	return build(options);
}

function build(options: RuntimeOptions): RuntimeState {
	let builtin: Models | undefined;
	return {
		[RUNTIME_BRAND]: true,
		repo: options.repo ?? new InMemorySessionRepo(),
		env: options.env ?? ((name) => process.env[name]),
		registry:
			options.registry ??
			(() => {
				builtin ??= builtinModels();
				return builtin;
			}),
		running: new Map(),
		taken: new Set(),
	};
}

let fallback: RuntimeState | undefined;

/** The instance every call without a `runtime` shares. Built on first use. */
function defaultRuntime(): RuntimeState {
	fallback ??= build({});
	return fallback;
}

/** The state behind a runtime the host passed, or behind the default one. */
export function runtimeState(runtime: Runtime | undefined): RuntimeState {
	const value = runtime ?? defaultRuntime();
	if (!isRuntime(value)) throw new Error('Runtimes must come from createRuntime.');
	return value as RuntimeState;
}
