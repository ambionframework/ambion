/**
 * The default Pi execution. A room of Pi agents with no `execution` runs on
 * `piExecution()`. The model catalog is a scripted stream here, so the test
 * needs no key and the room reaches the model as it would in production.
 */
import { defineAgent, isSpoken, startRoom } from '@ambionframework/ambion';
import type { Api, Model } from '@earendil-works/pi-ai';
import { expect, it, vi } from 'vitest';
import { andrei, roomName } from '../../ambion/test/support/room.ts';
import { quiet, scripted, speak } from '../../ambion/test/support/scripted.ts';
import { pi } from '../src/index.ts';

const catalog = vi.hoisted(() => ({ stream: undefined as unknown }));

vi.mock('@earendil-works/pi-ai/providers/all', () => ({
	builtinModels: () => ({
		getModel: (_provider: string, id: string) =>
			({ id, name: id, api: 'scripted', provider: 'scripted' }) as unknown as Model<Api>,
		streamSimple: (...args: unknown[]) =>
			(catalog.stream as (...call: unknown[]) => unknown)(...args),
	}),
}));

const worker = defineAgent({
	name: 'worker',
	identity: 'Answers what is asked.',
	executor: pi({ instructions: 'answer once', model: 'scripted/worker' }),
});

it('runs a room of Pi agents with no execution option', async () => {
	catalog.stream = scripted((_context, _agent, call) => (call === 1 ? speak('42') : quiet()));
	const room = await startRoom({ name: roomName('pi-default'), agents: [worker] });
	try {
		const visit = await room.visit(andrei);
		const exchange = await visit.send({ text: 'What is the answer?' });
		const messages = await exchange.waitForClose();
		expect(messages.filter(isSpoken).map((message) => [message.from, message.text])).toEqual([
			['andrei', 'What is the answer?'],
			['worker', '42'],
		]);
	} finally {
		await room.stop();
	}
});
