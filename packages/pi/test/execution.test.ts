/**
 * The composition path: a room takes `piExecution({ stream })` as its
 * execution, or a runtime takes it as the default for every room.
 */
import {
	createRuntime,
	defineAgent,
	isSpoken,
	resumeRoom,
	startRoom,
} from '@ambionframework/ambion';
import { describe, expect, it } from 'vitest';
import { andrei, roomName, waitForRoom } from '../../ambion/test/support/room.ts';
import { quiet, scripted, speak } from '../../ambion/test/support/scripted.ts';
import { memory } from '../../ambion/test/support/storage.ts';
import { pi, piExecution } from '../src/index.ts';

const worker = defineAgent({
	name: 'worker',
	identity: 'Answers what is asked.',
	executor: pi({ instructions: 'answer once', model: 'scripted/worker' }),
});

const answering = () => scripted((_context, _agent, call) => (call === 1 ? speak('42') : quiet()));

describe('piExecution', () => {
	it('answers a question end to end and closes the exchange', async () => {
		const room = await startRoom({
			name: roomName('pi-execution'),
			agents: [worker],
			execution: piExecution({ stream: answering() }),
		});
		try {
			const visit = await room.visit(andrei);
			const exchange = await visit.send({ text: 'What is the answer?' });
			const messages = await exchange.waitForClose();
			expect(messages.filter(isSpoken).map((message) => [message.from, message.text])).toEqual([
				['andrei', 'What is the answer?'],
				['worker', '42'],
			]);
			expect((await room.read()).exchanges[0]?.status).toBe('closed');
		} finally {
			await room.stop();
		}
	});

	it('serves every room of a runtime that takes it as its default', async () => {
		const opened = await memory.open();
		const runtime = createRuntime({
			storage: opened.storage,
			execution: piExecution({ stream: answering() }),
		});
		const name = roomName('pi-runtime');
		try {
			const first = await startRoom({ name, agents: [worker], runtime });
			const visit = await first.visit(andrei);
			await visit.send({ text: 'What is the answer?' });
			await waitForRoom(first);
			await first.stop();
			// The runtime's default serves a resumed room too.
			const again = await resumeRoom(name, { agents: [worker], runtime });
			await waitForRoom(again);
			const spoken = (await again.read()).messages.filter(isSpoken);
			expect(spoken.map((message) => message.text)).toContain('42');
			await again.stop();
		} finally {
			await opened.dispose();
		}
	});

	it('lets a room name its own execution over the runtime default', async () => {
		const runtime = createRuntime({ execution: piExecution({ stream: scripted(() => quiet()) }) });
		const room = await startRoom({
			name: roomName('pi-override'),
			agents: [worker],
			runtime,
			execution: piExecution({ stream: answering() }),
		});
		try {
			const visit = await room.visit(andrei);
			const exchange = await visit.send({ text: 'What is the answer?' });
			const messages = await exchange.waitForClose();
			expect(messages.filter(isSpoken).map((message) => message.text)).toContain('42');
		} finally {
			await room.stop();
		}
	});
});
