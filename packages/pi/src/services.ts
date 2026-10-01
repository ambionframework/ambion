/** Model, stream and session services that a Pi execution host composes. */

import { PermanentError } from '@ambionframework/ambion/hosting';
import type { Api, CredentialStore, Model, Models } from '@earendil-works/pi-ai';
import type { StreamFn } from './models.ts';
import { defaultSessionDir, diskSessions, memorySessions, type PiSessions } from './sessions.ts';

/** Resolves an agent's `provider/model-id` to the model Pi's harness runs. */
export type ModelResolver = (id: string, agent: string) => Model<Api> | Promise<Model<Api>>;

export interface ExecutionServices {
	readonly stream: StreamFn;
	readonly model: ModelResolver;
	/** Where each seat keeps its Pi harness sessions. */
	readonly sessions: PiSessions;
}

export interface PiExecutionOptions {
	/**
	 * The model call. Absent, Pi's registry answers, keyed from the environment.
	 * A scripted stream makes every room deterministic; the model then
	 * resolves to a stub, because a custom stream never reads it.
	 */
	readonly stream?: StreamFn;
	/**
	 * Where each seat keeps its Pi harness sessions. Absent, `'disk'`.
	 * `'memory'` keeps them for as long as the services live, as a test does.
	 */
	readonly sessions?: SessionPlace;
	/**
	 * The directory on the local disk for the sessions. Absent,
	 * `ambion-pi-sessions-<uid>` in the OS temporary directory.
	 */
	readonly sessionDir?: string;
	/**
	 * Where the subscription sign-ins live, such as `fileCredentials(path)`.
	 * A provider with a stored credential answers with it, and Pi does
	 * not read its `<PROVIDER>_API_KEY`. Absent, the registry reads the
	 * environment alone.
	 */
	readonly credentials?: CredentialStore;
}

/**
 * Where each seat keeps its Pi harness sessions: JSONL files on the local
 * disk, or memory for as long as the services live. A test keeps them in
 * memory, so that no room reads a session of another run.
 */
type SessionPlace = 'disk' | 'memory';

let builtinRegistry: Promise<Models> | undefined;

/** The registry. A host with a credential store gets a registry of its own; every other host shares one. */
const loadRegistry = (credentials?: CredentialStore): Promise<Models> =>
	import('@earendil-works/pi-ai/providers/all').then(({ builtinModels }) =>
		credentials === undefined ? builtinModels() : builtinModels({ credentials }),
	);

const sharedRegistry = () => (builtinRegistry ??= loadRegistry());

/** The registry stream. A stored credential owns its provider, so the store skips the environment key. */
const registryStream =
	(registry: () => Promise<Models>, credentials?: CredentialStore): StreamFn =>
	async (model, context, streamOptions) => {
		const envKey = process.env[`${model.provider.toUpperCase().replace(/-/g, '_')}_API_KEY`];
		const owned = envKey && credentials ? await credentials.read(model.provider) : undefined;
		const resolved =
			streamOptions?.apiKey || !envKey || owned
				? streamOptions
				: { ...streamOptions, apiKey: envKey };
		return (await registry()).streamSimple(model, context, resolved);
	};

const registryModel =
	(registry: () => Promise<Models>): ModelResolver =>
	async (id, agent) => {
		const slash = id.indexOf('/');
		if (slash > 0) {
			const model = (await registry()).getModel(id.slice(0, slash), id.slice(slash + 1));
			if (model) return model;
		}
		throw new PermanentError(
			`Unknown model '${id}' for agent '${agent}': expected 'provider/model-id'.`,
		);
	};

/** A custom stream never reads a model, so the harness receives a stub. It names the seat, and a scripted stream routes on that name. */
export const stubModel: ModelResolver = (id, agent): Model<Api> => ({
	id,
	name: agent,
	api: 'scripted',
	provider: 'scripted',
	baseUrl: '',
	reasoning: false,
	input: ['text'],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 64_000,
});

export function createExecutionServices(options: PiExecutionOptions = {}): ExecutionServices {
	const custom = options.stream !== undefined;
	const { credentials } = options;
	let own: Promise<Models> | undefined;
	const registry =
		credentials === undefined ? sharedRegistry : () => (own ??= loadRegistry(credentials));
	return {
		stream: options.stream ?? registryStream(registry, credentials),
		model: custom ? stubModel : registryModel(registry),
		sessions: sessionsOf(options),
	};
}

/** The session store: memory, the named directory, or the default directory. */
function sessionsOf(options: PiExecutionOptions): PiSessions {
	if (options.sessions === 'memory') return memorySessions();
	return diskSessions(options.sessionDir ?? defaultSessionDir);
}
