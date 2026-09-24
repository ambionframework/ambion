/**
 * The composition path: a room takes `piExecution({ stream })` as its
 * execution, or a runtime takes it as the default for every room.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createRuntime, isSpoken, type Room, resumeRoom, startRoom } from '@ambionframework/ambion';
import { describe, expect, it, onTestFinished } from 'vitest';
import { andrei, roomName, scriptedAgent, waitForRoom } from '../../ambion/test/support/room.ts';
import { quiet, scripted, speak } from '../../ambion/test/support/scripted.ts';
import { stopAtEnd } from '../../ambion/test/support/stop.ts';
import { memory } from '../../ambion/test/support/storage.ts';
import { piExecution } from '../src/index.ts';
import { tempDir } from './support/temp.ts';

const worker = scriptedAgent('worker');

const answering = () => scripted((_context, _agent, call) => (call === 1 ? speak('42') : quiet()));

/** Ask the one question and return what was said, once the exchange closes. */
async function ask(room: Room) {
	const visit = await room.visit(andrei);
	const exchange = await visit.send({ text: 'What is the answer?' });
	return (await exchange.waitForClose()).filter(isSpoken);
}

describe('piExecution', () => {
	it('answers a question end to end and closes the exchange', async () => {
		const room = stopAtEnd(
			await startRoom({
				name: roomName('pi-execution'),
				agents: [worker],
				execution: piExecution({ stream: answering() }),
			}),
		);
		expect((await ask(room)).map((message) => [message.from, message.text])).toEqual([
			['andrei', 'What is the answer?'],
			['worker', '42'],
		]);
		expect((await room.read()).exchanges[0]?.status).toBe('closed');
	});

	it('serves every room of a runtime that takes it as its default', async () => {
		const opened = await memory.open();
		onTestFinished(() => opened.dispose());
		const runtime = createRuntime({
			storage: opened.storage,
			execution: piExecution({ stream: answering() }),
		});
		const name = roomName('pi-runtime');
		const first = await startRoom({ name, agents: [worker], runtime });
		const visit = await first.visit(andrei);
		await visit.send({ text: 'What is the answer?' });
		await waitForRoom(first);
		await first.stop();
		// The runtime's default serves a resumed room too.
		const again = await resumeRoom(name, { agents: [worker], runtime });
		await waitForRoom(again);
		const spoken = (await again.read()).messages.filter(isSpoken);
		await again.stop();
		expect(spoken.map((message) => message.text)).toContain('42');
	});

	it('lets a room name its own execution over the runtime default', async () => {
		const runtime = createRuntime({ execution: piExecution({ stream: scripted(() => quiet()) }) });
		const room = stopAtEnd(
			await startRoom({
				name: roomName('pi-override'),
				agents: [worker],
				runtime,
				execution: piExecution({ stream: answering() }),
			}),
		);
		expect((await ask(room)).map((message) => message.text)).toContain('42');
	});

	it('keeps the sessions of its seats on the local disk under the directory it names', async () => {
		const sessionDir = await tempDir('ambion-execution-');
		const name = roomName('pi-disk');
		const room = stopAtEnd(
			await startRoom({
				name,
				agents: [worker],
				execution: piExecution({ stream: answering(), sessionDir }),
			}),
		);
		expect((await ask(room)).map((message) => message.text)).toContain('42');
		const [folder] = await readdir(sessionDir);
		expect(folder).toContain(name);
		expect(await readdir(join(sessionDir, folder as string))).toHaveLength(1);
	});
});
