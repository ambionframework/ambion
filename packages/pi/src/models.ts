/**
 * The model collection the Pi harness asks: one provider that answers
 * through the room's stream function.
 *
 * The harness finds a model by provider and id, then streams through the
 * provider that owns it. The stream function is the registry stream, keyed
 * from the environment, or a scripted stream, so the provider resolves no
 * credential itself.
 */
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	Models,
	SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import {
	createAssistantMessageEventStream,
	createModels,
	createProvider,
} from '@earendil-works/pi-ai';

/** The assistant message that ends a stream that could not start. */
function failed(model: Model<Api>, error: unknown): AssistantMessage {
	return {
		role: 'assistant',
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: 'error',
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

/** A stream the provider returns at once, fed by the stream function when it answers. */
function forward(
	stream: StreamFn,
): (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream {
	return (model, context, options) => {
		const out = createAssistantMessageEventStream();
		void (async () => {
			try {
				const inner = await stream(model, context, options);
				for await (const event of inner) out.push(event);
				out.end(await inner.result());
			} catch (error) {
				const message = failed(model, error);
				out.push({ type: 'error', reason: 'error', error: message });
				out.end(message);
			}
		})();
		return out;
	};
}

/** A collection that holds `model` alone, under its provider and id, and streams through `stream`. */
export function streamModels(model: Model<Api>, stream: StreamFn): Models {
	const streamed = forward(stream);
	const models = createModels();
	models.setProvider(
		createProvider({
			id: model.provider,
			auth: { apiKey: { name: 'Ambion stream', resolve: async () => ({ auth: {} }) } },
			models: [model],
			api: { stream: streamed, streamSimple: streamed },
		}),
	);
	return models;
}
