import { memoryJournals } from '@ambionframework/journal';
import { describe, expect, it } from 'vitest';
import {
	createRuntime,
	defineAgent,
	pi,
	readActivation,
	readRoom,
	startRoom,
} from '../src/index.ts';
import { andrei, collect, roomName, waitForRoom } from './support/room.ts';
import { quiet, scripted } from './support/scripted.ts';
import { traceOf } from './support/trace.ts';

const product = defineAgent({
	name: 'product',
	identity: 'Answers questions.',
	executor: pi({ instructions: 'Answer.', model: 'scripted/product' }),
});

describe('readActivation', () => {
	it('returns the steps of a finished activation grouped by pass, and lists it on the exchange', async () => {
		const storage = memoryJournals();
		const runtime = createRuntime({ storage });
		const name = roomName('read-activation');
		const room = await startRoom({
			name,
			agents: [product],
			runtime,
			stream: scripted(() => quiet('done')),
		});
		const events = collect(room);
		const visit = await room.visit(andrei);
		await visit.send({ text: 'Ready?' });
		await waitForRoom(room, 'quiet', 2_000);
		const started = events.find((event) => event.type === 'activation_start');
		if (started?.type !== 'activation_start') throw new Error('No activation started.');
		const steps = await traceOf(runtime, name, started.activation);
		await room.stop();

		// A second runtime over the same storage reads the stopped room.
		const later = createRuntime({ storage });
		const read = await readActivation(name, started.activation, { runtime: later });
		expect(read?.activation).toBe(started.activation);
		expect(read?.passes).toHaveLength(1);
		expect(read?.passes[0]).toMatchObject({ pass: 1, input: 'view' });
		expect(read?.passes.flatMap((pass) => pass.steps)).toEqual(steps);
		expect(read?.passes[0]?.steps[0]?.type).toBe('pass');

		const snapshot = await readRoom(name, { runtime: later });
		const listed = snapshot.exchanges.flatMap((exchange) => exchange.activations);
		expect(listed).toContainEqual(
			expect.objectContaining({
				id: started.activation,
				seat: 'product',
				attempt: 1,
				purpose: 'respond',
				outcome: { status: 'released' },
			}),
		);
	});

	it('returns undefined for a malformed id and no passes for an unknown activation', async () => {
		const runtime = createRuntime();
		const name = roomName('read-activation-unknown');
		expect(await readActivation(name, 'nonsense', { runtime })).toBeUndefined();
		expect(await readActivation(name, 'message:4:product:1', { runtime })).toEqual({
			activation: 'message:4:product:1',
			passes: [],
		});
	});
});
