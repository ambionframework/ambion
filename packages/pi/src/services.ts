/** Model, stream and session services that a Pi execution host composes. */

import { PermanentError } from '@ambionframework/ambion/hosting';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { Api, Model, Models } from '@earendil-works/pi-ai';
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
}

/**
 * Where each seat keeps its Pi harness sessions: JSONL files on the local
 * disk, or memory for as long as the services live. A test keeps them in
 * memory, so that no room reads a session of another run.
 */
type SessionPlace = 'disk' | 'memory';

let builtinRegistry: Promise<Models> | undefined;

const registry = () =>
	(builtinRegistry ??= import('@earendil-works/pi-ai/providers/all').then(({ builtinModels }) =>
		builtinModels(),
	));

const registryStream: StreamFn = async (model, context, streamOptions) => {
	const envKey = process.env[`${model.provider.toUpperCase().replace(/-/g, '_')}_API_KEY`];
	const resolved =
		streamOptions?.apiKey || !envKey ? streamOptions : { ...streamOptions, apiKey: envKey };
	return (await registry()).streamSimple(model, context, resolved);
};

const registryModel: ModelResolver = async (id, agent) => {
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
	return {
		stream: options.stream ?? registryStream,
		model: custom ? stubModel : registryModel,
		sessions: sessionsOf(options),
	};
}

/** The session store: memory, the named directory, or the default directory. */
function sessionsOf(options: PiExecutionOptions): PiSessions {
	if (options.sessions === 'memory') return memorySessions();
	return diskSessions(options.sessionDir ?? defaultSessionDir);
}
