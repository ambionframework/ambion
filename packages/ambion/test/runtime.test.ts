import type { Api, Context, Model, Models, SimpleStreamOptions } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import {
	createRuntime,
	defineAgent,
	defineWorkspace,
	destroyWorkspace,
	isSpoken,
	type Runtime,
	readSession,
	startSession,
	stopSession,
} from '../src/index.ts';
import { andrei, assistant, enter } from './support/room.ts';
import { byAgent, quiet, scripted, speak } from './support/scripted.ts';

const echo = defineAgent({
	name: 'echo',
	identity: 'Repeats what it hears.',
	instructions: 'echo',
	model: 'scripted/echo',
});

const room = (runtime: Runtime, name = 'shared') =>
	startSession({
		name,
		agents: [echo],
		assistant,
		runtime,
		streamFn: scripted(
			byAgent({ echo: (_context, _agent, call) => (call === 1 ? speak('heard') : quiet()) }),
		),
	});

describe('createRuntime', () => {
	it('runs two rooms with one name in two runtimes, and neither sees the other', async () => {
		const a = createRuntime();
		const b = createRuntime();
		const inA = room(a);
		const inB = room(b);
		expect(() => room(a)).toThrow(/already running/);
		const visit = await enter(inA);
		await visit.deliver({ text: 'hello' });
		await inA.settled();
		expect((await inA.messages()).filter(isSpoken).map((m) => m.text)).toEqual(['hello', 'heard']);
		expect(await inB.messages()).toEqual([]);
		expect(readSession('shared', { runtime: a })).toBe(inA);
		expect(readSession('shared', { runtime: b })).toBe(inB);
		await stopSession(inA);
		await stopSession(inB);
	});

	it('reads a stopped room through its own runtime, and nothing through another', async () => {
		const a = createRuntime();
		const b = createRuntime();
		const inA = room(a);
		const visit = await enter(inA);
		await visit.deliver({ text: 'kept' });
		await inA.settled();
		await stopSession(inA);
		const throughA = await readSession('shared', { runtime: a }).messages();
		expect(throughA.filter(isSpoken).map((m) => m.text)).toEqual(['kept', 'heard']);
		expect(await readSession('shared', { runtime: b }).messages()).toEqual([]);
		// The name is free in `a` again, and `b` never held it.
		await stopSession(room(a));
	});

	it('holds workspace names per runtime', async () => {
		const a = createRuntime();
		const b = createRuntime();
		const inA = defineWorkspace({ name: 'drive', runtime: a });
		const inB = defineWorkspace({ name: 'drive', runtime: b });
		expect(() => defineWorkspace({ name: 'drive', runtime: a })).toThrow(/already defined/);
		await destroyWorkspace(inA);
		const again = defineWorkspace({ name: 'drive', runtime: a });
		expect(again.name).toBe('drive');
		await destroyWorkspace(again);
		await destroyWorkspace(inB);
	});

	it('resolves models in the runtime registry, keyed from the runtime environment', async () => {
		const seen: { model: string; apiKey: string | undefined }[] = [];
		const stub = (provider: string, id: string): Model<Api> =>
			({ id: `${provider}/${id}`, name: id, api: 'scripted', provider }) as unknown as Model<Api>;
		const answer = scripted(
			byAgent({ echo: (_context, _agent, call) => (call === 1 ? speak('resolved') : quiet()) }),
		);
		const registry = {
			getModel: (provider: string, id: string) => stub(provider, id),
			streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
				seen.push({ model: model.id, apiKey: options?.apiKey });
				return answer(model, context, options);
			},
		} as unknown as Models;
		const runtime = createRuntime({
			registry: () => registry,
			env: (name) => (name === 'SCRIPTED_API_KEY' ? 'key-from-runtime' : undefined),
		});
		const session = startSession({ name: 'keyed', agents: [echo], assistant, runtime });
		const visit = await enter(session, andrei);
		await visit.deliver({ text: 'hello' });
		await session.settled();
		expect((await session.messages()).filter(isSpoken).map((m) => m.text)).toEqual([
			'hello',
			'resolved',
		]);
		expect(seen).toContainEqual({ model: 'scripted/echo', apiKey: 'key-from-runtime' });
		await stopSession(session);
	});

	it('reads the default environment from the process', () => {
		process.env.AMBION_RUNTIME_TEST = 'set';
		expect(createRuntime().env('AMBION_RUNTIME_TEST')).toBe('set');
		delete process.env.AMBION_RUNTIME_TEST;
	});

	it('refuses a runtime that did not come from createRuntime', () => {
		const forged = { repo: {}, env: () => undefined, registry: () => ({}) } as unknown as Runtime;
		expect(() => startSession({ name: 'forged', assistant, runtime: forged })).toThrow(
			/createRuntime/,
		);
		expect(() => defineWorkspace({ name: 'forged', runtime: forged })).toThrow(/createRuntime/);
	});
});
