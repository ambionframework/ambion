import { systemClock } from '@ambionframework/ambion';
import { memoryJournals } from '@ambionframework/journal';
import type { Api, Context, Model } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import type { createExecutionServices, ExecutionServices } from '../src/services.ts';

const catalog = vi.hoisted(() => ({
	builtinModels: vi.fn(),
	getModel: vi.fn(),
	streamSimple: vi.fn(),
}));

vi.mock('@earendil-works/pi-ai/providers/all', () => ({
	builtinModels: (...args: unknown[]) => catalog.builtinModels(...args),
}));

const model = {
	id: 'fake/fast',
	name: 'Fast',
	api: 'fake',
	provider: 'fake',
} as unknown as Model<Api>;

/** Services over an in-memory record: the default stream and model resolver. */
function servicesOf(create: typeof createExecutionServices): ExecutionServices {
	return create({ storage: memoryJournals(), clock: systemClock() });
}

describe('default provider runtime boundary', () => {
	it('initializes one catalog for concurrent first model uses and streams through it', async () => {
		// Each test's catalog is module-scoped and cached for the module's life
		// (`builtinRegistry` in services.ts): a fresh module keeps this test's
		// mocks from a neighbour's, whichever test runs first. The mock call
		// counts are their own hoisted values, shared by both tests, so they
		// are cleared here too.
		vi.resetModules();
		catalog.builtinModels.mockClear();
		catalog.getModel.mockClear();
		catalog.streamSimple.mockClear();
		catalog.builtinModels.mockReturnValue({
			getModel: catalog.getModel,
			streamSimple: catalog.streamSimple,
		});
		catalog.getModel.mockReturnValue(model);
		const expectedStreams = [
			createAssistantMessageEventStream(),
			createAssistantMessageEventStream(),
			createAssistantMessageEventStream(),
		];
		let streamIndex = 0;
		catalog.streamSimple.mockImplementation(() => expectedStreams[streamIndex++]);
		const { createExecutionServices } = await import('../src/services.ts');
		const services = [servicesOf(createExecutionServices), servicesOf(createExecutionServices)];
		services.push(servicesOf(createExecutionServices));

		const context: Context = { systemPrompt: '', messages: [] };
		const streams = await Promise.all(
			services.map(async (one) => {
				const resolved = await one.model('fake/fast', 'worker');
				expect(resolved).toEqual(model);
				return one.stream(resolved, context, {});
			}),
		);

		expect(streams).toEqual(expectedStreams);
		expect(catalog.builtinModels).toHaveBeenCalledTimes(1);
		expect(catalog.getModel).toHaveBeenCalledTimes(3);
		expect(catalog.streamSimple).toHaveBeenCalledTimes(3);
	});

	it('propagates catalog initialization failure to the model caller', async () => {
		vi.resetModules();
		catalog.builtinModels.mockClear();
		catalog.getModel.mockClear();
		catalog.streamSimple.mockClear();
		catalog.builtinModels.mockImplementationOnce(() => {
			throw new Error('catalog failed');
		});
		const { createExecutionServices } = await import('../src/services.ts');
		const services = [servicesOf(createExecutionServices), servicesOf(createExecutionServices)];
		services.push(servicesOf(createExecutionServices));

		const results = await Promise.allSettled(
			services.map((one) => one.model('fake/fast', 'worker')),
		);
		expect(results).toEqual([
			{ status: 'rejected', reason: expect.any(Error) },
			{ status: 'rejected', reason: expect.any(Error) },
			{ status: 'rejected', reason: expect.any(Error) },
		]);
		for (const result of results) {
			if (result.status === 'rejected')
				expect(result.reason).toHaveProperty('message', 'catalog failed');
		}
	});
});
