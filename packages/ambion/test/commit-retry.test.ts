/**
 * A seat's commit lands, and the reply to the seat is lost. The seat retries
 * under the same key and the record holds one say. When no reply ever
 * comes, the activation ends and the seat does not say it again under a
 * new key.
 */
import { describe, expect, it } from 'vitest';
import { piExecution } from '../../pi/src/index.ts';
import { createRuntime, defineHuman, startRoom } from '../src/index.ts';
import { tapped } from './support/core-failure.ts';
import { collect, messagesOf, roomName, scriptedAgent, waitForRoom } from './support/room.ts';
import { quiet, scripted, speak, toolResultTexts } from './support/scripted.ts';
import { openFor, stopAtEnd } from './support/stop.ts';
import { storages } from './support/storage.ts';

const worker = scriptedAgent('worker');
const person = defineHuman({ name: 'priya', identity: 'Project manager.' });

describe.each(storages)('commit retry on $name storage', (storage) => {
	it.each([
		['retries a lost commit under its key and speaks once', 1],
		['ends the activation on an unknown commit outcome and never speaks twice', 'all'],
	] as const)('%s', async (_case, lose) => {
		const opened = await openFor(storage);
		let commits = 0;
		// The room accepts every commit, and the reply to the first `lose` is lost.
		const transport = tapped({
			room: (room) => ({
				commit: async (request) => {
					commits += 1;
					const result = await room.commit(request);
					if (lose === 'all' || commits <= lose) throw new Error('commit reply lost');
					return result;
				},
			}),
		});
		const room = stopAtEnd(
			await startRoom({
				name: roomName(`commit-retry-${storage.name}`),
				agents: [worker],
				seats: { [worker.name]: 'named' },
				runtime: createRuntime({ storage: opened.storage, transport }),
				// The seat reads the tool results, so a lost reply makes it speak again.
				execution: piExecution({
					sessions: 'memory',
					stream: scripted((context) =>
						toolResultTexts(context).includes('delivered') ? quiet() : speak('answer'),
					),
				}),
			}),
		);
		const events = collect(room);
		await (await room.visit(person)).send({ to: worker.name, text: 'please answer' });
		await waitForRoom(room, 'quiet');
		const answers = (await messagesOf(room)).filter(
			(message) => message.kind === 'said' && message.from === worker.name,
		);
		expect(answers.map((message) => message.kind === 'said' && message.text)).toEqual(['answer']);
		expect(commits).toBeGreaterThan(1);
		const commitErrors = events.filter(
			(event) => event.type === 'delivery_error' && event.operation === 'commit',
		);
		expect(commitErrors.length > 0).toBe(lose === 'all');
	});
});
