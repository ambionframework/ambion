/**
 * The model a seat runs on. Without a custom `streamFn`, an agent's `model`
 * names `provider/model-id` in Pi's builtin registry, and the default stream
 * calls it with the provider's API key from the environment. A host that
 * passes its own `streamFn` brings its own providers, and the registry is
 * never read.
 */
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import type { AgentDefinition } from './types.ts';

/** Pi's model registry, built once on first use. */
let builtinRegistry: ReturnType<typeof builtinModels> | undefined;
const registry = () => (builtinRegistry ??= builtinModels());

/** The default model call: Pi's builtin registry, keyed from the provider's env var. */
export const registryStream: StreamFn = (model, context, streamOptions) => {
	const envKey = process.env[`${model.provider.toUpperCase().replace(/-/g, '_')}_API_KEY`];
	const resolved =
		streamOptions?.apiKey || !envKey ? streamOptions : { ...streamOptions, apiKey: envKey };
	return registry().streamSimple(model, context, resolved);
};

/** The model a definition names, or a stub when a custom stream never reads one. */
export function resolveModel(def: AgentDefinition, customStream: boolean): Model<Api> {
	if (customStream) {
		// A custom streamFn never reads the model; a stub keeps Pi's loop satisfied.
		return {
			id: def.model,
			name: def.model,
			api: 'scripted',
			provider: 'scripted',
		} as unknown as Model<Api>;
	}
	const slash = def.model.indexOf('/');
	if (slash > 0) {
		const model = registry().getModel(def.model.slice(0, slash), def.model.slice(slash + 1));
		if (model) return model;
	}
	throw new Error(
		`Unknown model '${def.model}' for agent '${def.name}': expected 'provider/model-id'.`,
	);
}
