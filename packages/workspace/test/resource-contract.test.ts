import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	openResource,
	type ResourceBackend,
	type ResourceEnv,
	type WorkspaceAgent,
} from '../src/resource.ts';
import * as entry from '../src/resource-entry.ts';

interface FakeEnv extends ResourceEnv {
	readonly note: string;
}

const agent: WorkspaceAgent = { name: 'alpha', identity: 'alpha' };

function fakeBackend(events: string[]): ResourceBackend<FakeEnv> {
	return {
		connect: async (who) => ({
			note: `hello ${who.name}`,
			cleanup: async () => {
				events.push('cleanup');
			},
		}),
		destroy: async () => {
			events.push('destroy');
		},
		dispose: async () => {
			events.push('dispose');
		},
	};
}

describe('the neutral resource contract', () => {
	it('drives an owner over a backend that has no Pi types', async () => {
		const events: string[] = [];
		const resource = openResource({ name: 'fake', backend: fakeBackend(events) });
		await expect(resource.use(agent, (env) => env.note)).resolves.toBe('hello alpha');
		expect(events).toEqual(['cleanup']);
		await resource.dispose();
		await expect(resource.use(agent, () => 'late')).rejects.toThrow(/no longer available/);
		expect(events).toEqual(['cleanup', 'dispose']);
	});

	it('cleans up after a failed operation and destroys once', async () => {
		const events: string[] = [];
		const resource = openResource({ name: 'fake', backend: fakeBackend(events) });
		await expect(
			resource.use(agent, () => {
				throw new Error('boom');
			}),
		).rejects.toThrow('boom');
		await resource.destroy();
		expect(events).toEqual(['cleanup', 'destroy']);
	});

	it('imports no module in the contract source', async () => {
		const path = fileURLToPath(new URL('../src/resource.ts', import.meta.url));
		const source = await readFile(path, 'utf8');
		expect(source).not.toMatch(/@earendil-works\/pi/);
		expect(source).not.toMatch(/^import /m);
	});

	it('exports only the owner from the resource entry', () => {
		expect(Object.keys(entry)).toEqual(['openResource']);
	});
});
