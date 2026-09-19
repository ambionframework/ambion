import { describe, expect, it } from 'vitest';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	type RoomNotification,
	startRoom,
} from '../src/index.ts';
import { inProcessTransport, type SeatRoom, type Transport } from '../src/transport.ts';
import { messagesOf, roomName, waitForRoom } from './support/room.ts';
import { quiet, type Script, scripted, speak, toolResultTexts } from './support/scripted.ts';
import { storages } from './support/storage.ts';

const worker = defineAgent({
	name: 'worker',
	identity: 'Answers the question.',
	instructions: 'answer the question',
	model: 'scripted/worker',
});
const person = defineHuman({ name: 'priya', identity: 'Project manager.' });

/**
 * A seat that says one text until a room call confirms it. It reads the tool
 * results to decide whether to speak, so a lost reply makes it speak again.
 * This is the seat that turns a lost reply into a duplicate under the old
 * runner.
 */
const saysUntilDelivered =
	(text: string): Script =>
	(context) =>
		toolResultTexts(context).includes('delivered') ? quiet() : speak(text);

/** A transport that loses the reply to the seat's first `lose` commits. */
function losingCommit(lose: number | 'all'): {
	transport: Transport;
	commits: () => number;
} {
	const base = inProcessTransport();
	let commits = 0;
	return {
		commits: () => commits,
		transport: {
			connect(room, context) {
				const wrapped: SeatRoom = {
					view: (id) => room.view(id),
					lease: (request) => room.lease(request),
					commit: async (request) => {
						commits += 1;
						// The room accepts the commit; the key makes a retry idempotent.
						const result = await room.commit(request);
						if (lose === 'all' || commits <= lose) throw new Error('commit reply lost');
						return result;
					},
				};
				return base.connect(wrapped, context);
			},
		},
	};
}

const commitErrors = (events: readonly RoomNotification[]): RoomNotification[] =>
	events.filter((event) => event.type === 'delivery_error' && event.operation === 'commit');

describe.each(storages)('commit retry on $name storage', (storage) => {
	it('retries a lost commit under its key and speaks once', async () => {
		const opened = await storage.open();
		const losing = losingCommit(1);
		const runtime = createRuntime({ storage: opened.storage, transport: losing.transport });
		const room = await startRoom({
			name: roomName(`commit-retry-${storage.name}`),
			agents: [worker],
			seats: { [worker.name]: 'named' },
			runtime,
			streamFn: scripted(saysUntilDelivered('answer')),
		});
		try {
			const visit = await room.visit(person);
			await visit.send({ to: worker.name, text: 'please answer' });
			await waitForRoom(room, 'quiet');
			const answers = (await messagesOf(room)).filter(
				(message) => message.kind === 'said' && message.from === worker.name,
			);
			// The lost reply retried under the same key, so exactly one answer landed.
			expect(answers).toHaveLength(1);
			expect(answers[0]?.text).toBe('answer');
			expect(losing.commits()).toBeGreaterThan(1);
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('ends the turn on an unknown commit outcome and never speaks twice', async () => {
		const opened = await storage.open();
		const losing = losingCommit('all');
		const events: RoomNotification[] = [];
		const runtime = createRuntime({ storage: opened.storage, transport: losing.transport });
		const room = await startRoom({
			name: roomName(`commit-unknown-${storage.name}`),
			agents: [worker],
			seats: { [worker.name]: 'named' },
			runtime,
			streamFn: scripted(saysUntilDelivered('answer')),
		});
		const off = room.subscribe((event) => events.push(event));
		try {
			const visit = await room.visit(person);
			await visit.send({ to: worker.name, text: 'please answer' });
			await waitForRoom(room, 'quiet');
			const answers = (await messagesOf(room)).filter(
				(message) => message.kind === 'said' && message.from === worker.name,
			);
			// The commit landed once; no reply confirmed it, so the turn ended and
			// the seat never said it again under a new key.
			expect(answers).toHaveLength(1);
			expect(commitErrors(events).length).toBeGreaterThan(0);
		} finally {
			off();
			await room.stop();
			await opened.dispose();
		}
	});
});
