/**
 * The default execution of an executor family yields to an explicit one.
 * A stub kind and a stub execution stand in for a family, because the
 * kernel imports no executor package.
 */
import { expect, it, vi } from 'vitest';
import type { Execution } from '../src/hosting.ts';
import { registerDefaultExecution } from '../src/hosting.ts';
import type { AgentExecutor } from '../src/index.ts';
import { createRuntime, defineAgent, startRoom } from '../src/index.ts';
import { andrei, roomName } from './support/room.ts';

/** A stub execution that counts its builds and the seats it connects. */
function stub() {
	const counts = { built: 0, connected: 0 };
	const execution: Execution = {
		connector() {
			counts.built += 1;
			return {
				connect() {
					counts.connected += 1;
					return {
						wake: async () => {},
						steer: async () => {},
						cut: async () => {},
					};
				},
			};
		},
	};
	return { counts, execution };
}

function seat(kind: string) {
	const executor: AgentExecutor = { kind, instructions: 'answer', tools: [] };
	return defineAgent({ name: 'worker', identity: 'Answers.', executor });
}

async function ask(options: Parameters<typeof startRoom>[0]) {
	const room = await startRoom(options);
	try {
		const visit = await room.visit(andrei);
		await visit.send({ text: 'Anybody there?' });
	} finally {
		await room.stop();
	}
}

it('runs the registered default when the host passes no execution', async () => {
	const defaults = stub();
	registerDefaultExecution('stub-default-only', () => defaults.execution);
	await ask({
		name: roomName('default-only'),
		agents: [seat('stub-default-only')],
		runtime: createRuntime(),
	});
	await vi.waitFor(() => expect(defaults.counts.connected).toBeGreaterThan(0));
});

it('runs the explicit execution of a room and not the registered default', async () => {
	const defaults = stub();
	const explicit = stub();
	registerDefaultExecution('stub-room-override', () => defaults.execution);
	await ask({
		name: roomName('room-override'),
		agents: [seat('stub-room-override')],
		runtime: createRuntime(),
		execution: explicit.execution,
	});
	await vi.waitFor(() => expect(explicit.counts.connected).toBeGreaterThan(0));
	expect(defaults.counts).toEqual({ built: 0, connected: 0 });
});

it('runs the execution of the runtime and not the registered default', async () => {
	const defaults = stub();
	const explicit = stub();
	registerDefaultExecution('stub-runtime-override', () => defaults.execution);
	await ask({
		name: roomName('runtime-override'),
		agents: [seat('stub-runtime-override')],
		runtime: createRuntime({ execution: explicit.execution }),
	});
	await vi.waitFor(() => expect(explicit.counts.connected).toBeGreaterThan(0));
	expect(defaults.counts).toEqual({ built: 0, connected: 0 });
});

it('builds the registered default once per runtime across rooms', async () => {
	const defaults = stub();
	registerDefaultExecution('stub-once', () => defaults.execution);
	const runtime = createRuntime();
	await ask({ name: roomName('once-a'), agents: [seat('stub-once')], runtime });
	await ask({ name: roomName('once-b'), agents: [seat('stub-once')], runtime });
	await vi.waitFor(() => expect(defaults.counts.connected).toBeGreaterThan(1));
	expect(defaults.counts.built).toBe(1);
});
