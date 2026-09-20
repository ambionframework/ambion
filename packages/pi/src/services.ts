/** Model, stream and transcript services that a Pi execution host composes. */

import { systemClock } from '@ambionframework/ambion';
import type { Clock, Limits } from '@ambionframework/ambion/hosting';
import { callLimits } from '@ambionframework/ambion/hosting';
import type { JournalOpener } from '@ambionframework/journal';
import { piSessions, type SessionOpener } from '@ambionframework/pi-journal';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { Api, Model, Models } from '@earendil-works/pi-ai';

/** Resolves an agent's `provider/model-id` to the model Pi's loop runs. */
export type ModelResolver = (id: string, agent: string) => Model<Api> | Promise<Model<Api>>;

/** A collision safe id for the Pi session that one agent owns in one room. */
export function seatSessionId(room: string, seat: string): string {
	return JSON.stringify(['ambion/seat-session', room, seat]);
}

export interface ExecutionServices {
	readonly clock: Clock;
	readonly call: Limits['call'];
	readonly transcripts: SessionOpener;
	readonly stream: StreamFn;
	readonly model: ModelResolver;
}

export interface ExecutionServicesOptions {
	readonly storage: JournalOpener;
	/** Absent, the system clock. */
	readonly clock?: Clock;
	readonly call?: Partial<Limits['call']>;
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
		call: callLimits(options.call),
		transcripts: piSessions(options.storage),
		stream: options.stream ?? registryStream,
		model: custom ? stubModel : registryModel,
	};
}
