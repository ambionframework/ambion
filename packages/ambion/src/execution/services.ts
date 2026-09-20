/** Model, stream and transcript services that an execution host composes. */

import type { JournalOpener } from '@ambionframework/journal';
import { piSessions, type SessionOpener } from '@ambionframework/pi-journal';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { Api, Model, Models } from '@earendil-works/pi-ai';
import { systemClock } from '../host/clock.ts';
import type { Clock, ModelResolver } from '../types.ts';

interface ExecutionCall {
	readonly attempts: number;
	readonly timeout: number;
}

/** A collision safe id for the Pi session that one agent owns in one room. */
export function seatSessionId(room: string, seat: string): string {
	return JSON.stringify(['ambion/seat-session', room, seat]);
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

/** A custom stream never reads a model, so Pi receives a stub. It names the seat, and a scripted stream routes on that name. */
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

export function createExecutionServices(options: ExecutionServicesOptions): ExecutionServices {
	const custom = options.stream !== undefined;
	const attempts = options.call?.attempts ?? 2;
	const timeout = options.call?.timeout ?? 10_000;
	if (!Number.isSafeInteger(attempts) || attempts < 1)
		throw new Error('Room call attempts must be a positive safe integer.');
	if (!Number.isFinite(timeout) || timeout <= 0)
		throw new Error('Room call timeout must be a finite positive number.');
	return {
		clock: options.clock ?? systemClock(),
		call: { attempts, timeout },
		transcripts: piSessions(options.storage),
		stream: options.stream ?? registryStream,
		model: custom ? stubModel : registryModel,
	};
}
