/** Model, stream and transcript services that an execution host composes. */

import type { JournalOpener } from '@ambionframework/journal';
import { piSessions, type SessionOpener } from '@ambionframework/pi-journal';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { Api, Model, Models } from '@earendil-works/pi-ai';
import { systemClock } from '../host/clock.ts';
import type { Clock, ModelResolver } from '../types.ts';

interface ExecutionCall {
	readonly attempts: number;
}

export interface ExecutionServices {
	readonly clock: Clock;
	readonly call: ExecutionCall;
	readonly transcripts: SessionOpener;
	readonly stream: StreamFn;
	readonly model: ModelResolver;
}

export interface ExecutionServicesOptions {
	readonly storage: JournalOpener;
	readonly clock?: Clock;
	readonly call?: Partial<ExecutionCall>;
	readonly stream?: StreamFn;
}

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
	throw new Error(`Unknown model '${id}' for agent '${agent}': expected 'provider/model-id'.`);
};

/** A custom stream does not read a model, so Pi receives a stable stub. */
export const stubModel: ModelResolver = (id) =>
	({ id, name: id, api: 'scripted', provider: 'scripted' }) as unknown as Model<Api>;

export function createExecutionServices(options: ExecutionServicesOptions): ExecutionServices {
	const custom = options.stream !== undefined;
	return {
		clock: options.clock ?? systemClock(),
		call: { attempts: 2, ...options.call },
		transcripts: piSessions(options.storage),
		stream: options.stream ?? registryStream,
		model: custom ? stubModel : registryModel,
	};
}
