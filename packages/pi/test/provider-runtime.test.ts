/**
 * The default provider runtime. A room of Pi agents with no `execution` runs
 * on `piExecution()`, which resolves each model id and streams through the
 * built-in catalog. The mock wraps the real catalog: it counts the builds, can
 * fail one, and answers every stream and the `scripted` provider with a
 * scripted stream. A real stream needs a key and a network.
 */
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isSpoken, startRoom, systemClock } from '@ambionframework/ambion';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import {
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
} from '@earendil-works/pi-ai';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { andrei, roomName, scriptedAgent } from '../../ambion/test/support/room.ts';
import { quiet, scripted, speak } from '../../ambion/test/support/scripted.ts';
import { stopAtEnd } from '../../ambion/test/support/stop.ts';
import { stubModel } from '../src/services.ts';
import { defaultSessionDir } from '../src/sessions.ts';

const catalog = vi.hoisted(() => ({
	builds: 0,
	fail: false,
	stream: undefined as StreamFn | undefined,
}));

vi.mock('@earendil-works/pi-ai/providers/all', async (importOriginal) => {
	const real = await importOriginal<typeof import('@earendil-works/pi-ai/providers/all')>();
	return {
		builtinModels: () => {
			catalog.builds += 1;
			if (catalog.fail) throw new Error('catalog failed');
			const models = real.builtinModels();
			return {
				getModel: (provider: string, id: string) =>
					provider === 'scripted' ? stubModel(id, id) : models.getModel(provider, id),
				streamSimple: (...args: Parameters<StreamFn>) => catalog.stream?.(...args),
			};
		},
	};
});

/** Services from a fresh copy of the module, so the catalog it caches is new. */
async function freshServices(count: number) {
	vi.resetModules();
	catalog.builds = 0;
	const { createExecutionServices } = await import('../src/services.ts');
	return Array.from({ length: count }, () => createExecutionServices({ clock: systemClock() }));
}

describe('default provider runtime', () => {
	it('runs a room of Pi agents with no execution option, and keeps its sessions in the OS temporary directory of the user', async () => {
		catalog.stream = scripted((_context, _agent, call) => (call === 1 ? speak('42') : quiet()));
		const name = roomName('pi-default');
		const room = stopAtEnd(await startRoom({ name, agents: [scriptedAgent('worker')] }));
		const visit = await room.visit(andrei);
		const exchange = await visit.send({ text: 'What is the answer?' });
		const messages = await exchange.waitForClose();
		expect(messages.filter(isSpoken).map((message) => [message.from, message.text])).toEqual([
			['andrei', 'What is the answer?'],
			['worker', '42'],
		]);
		const dir = await defaultSessionDir();
		const folders = (await readdir(dir)).filter((folder) => folder.includes(name));
		onTestFinished(async () => {
			for (const folder of folders) await rm(join(dir, folder), { recursive: true, force: true });
		});
		expect(folders.some((folder) => folder.includes('worker'))).toBe(true);
	});

	it('builds one catalog for concurrent first model uses, resolves real ids, and streams through it', async () => {
		const made: AssistantMessageEventStream[] = [];
		catalog.stream = () => {
			const stream = createAssistantMessageEventStream();
			made.push(stream);
			return stream;
		};
		const services = await freshServices(3);
		const context: Context = { systemPrompt: '', messages: [] };
		const streams = await Promise.all(
			services.map(async (one) => {
				const model = await one.model('anthropic/claude-sonnet-4-5', 'worker');
				expect(model).toMatchObject({ id: 'claude-sonnet-4-5', provider: 'anthropic' });
				return one.stream(model, context, {});
			}),
		);
		expect(streams).toEqual(made);
		expect(made).toHaveLength(3);
		expect(catalog.builds).toBe(1);
		await expect(services[0]?.model('anthropic/no-such-model', 'worker')).rejects.toThrow(
			"Unknown model 'anthropic/no-such-model' for agent 'worker'",
		);
	});

	it('propagates catalog initialization failure to every model caller', async () => {
		catalog.fail = true;
		onTestFinished(() => {
			catalog.fail = false;
		});
		const services = await freshServices(3);
		const results = await Promise.allSettled(
			services.map((one) => one.model('anthropic/claude-sonnet-4-5', 'worker')),
		);
		expect(results).toEqual(
			Array.from({ length: 3 }, () => ({
				status: 'rejected',
				reason: expect.objectContaining({ message: 'catalog failed' }),
			})),
		);
	});
});
