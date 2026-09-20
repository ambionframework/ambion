import { describe, expect, it } from 'vitest';
import { hostingOf } from '../src/hosting.ts';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	pi,
	type RoomNotification,
	startRoom,
} from '../src/index.ts';
import { scripted, settled } from '../src/testing.ts';
import { collect, roomName } from './support/room.ts';
import { storages } from './support/storage.ts';

const worker = defineAgent({
	name: 'worker',
	identity: 'Answers the question.',
	executor: pi({ instructions: 'answer the question', model: 'scripted/worker' }),
});
const person = defineHuman({ name: 'priya', identity: 'Project manager.' });

const errors = (events: readonly RoomNotification[]) =>
	events.filter((event) => event.type === 'error');
const abandonments = (events: readonly RoomNotification[]) =>
	events.filter((event) => event.type === 'abandoned');

describe.each(storages)('provider failure classification on $name storage', (storage) => {
	it('abandons a permanent failure in one attempt', async () => {
		const opened = await storage.open();
		let calls = 0;
		const runtime = createRuntime({
			storage: opened.storage,
			limits: { activation: { backoff: () => 0 } },
		});
		const room = await startRoom({
			name: roomName(`perm-${storage.name}`),
			agents: [worker],
			seats: { [worker.name]: 'named' },
			runtime,
			stream: scripted(() => {
				calls += 1;
				throw new Error('400 Your credit balance is too low to make this request');
			}),
		});
		const events = collect(room);
		try {
			const visit = await room.visit(person);
			await visit.send({ to: worker.name, text: 'answer me' });
			await settled(room);
			// A permanent failure does not pass on a retry, so the room runs the
			// seat once and abandons the rest.
			expect(calls).toBe(1);
			expect(abandonments(events)).toEqual([
				expect.objectContaining({ agent: worker.name, cause: 'permanent' }),
			]);
			expect(errors(events).some((event) => event.cause === 'permanent')).toBe(true);
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('does not read a rate-limit token count as a permanent status', async () => {
		const opened = await storage.open();
		let calls = 0;
		const runtime = createRuntime({
			storage: opened.storage,
			limits: { activation: { backoff: () => 0 } },
		});
		const room = await startRoom({
			name: roomName(`ratelimit-${storage.name}`),
			agents: [worker],
			seats: { [worker.name]: 'named' },
			runtime,
			stream: scripted(() => {
				calls += 1;
				// The token count reads like a 400 status, but a rate limit is transient.
				throw new Error('429 rate limit of 400,000 input tokens per minute exceeded');
			}),
		});
		const events = collect(room);
		try {
			const visit = await room.visit(person);
			await visit.send({ to: worker.name, text: 'answer me' });
			await settled(room);
			expect(calls).toBe(hostingOf(runtime).limits.activation.attempts);
			expect(abandonments(events)).toEqual([
				expect.objectContaining({ agent: worker.name, cause: 'transient' }),
			]);
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('retries a transient failure to the cap', async () => {
		const opened = await storage.open();
		let calls = 0;
		const runtime = createRuntime({
			storage: opened.storage,
			limits: { activation: { backoff: () => 0 } },
		});
		const room = await startRoom({
			name: roomName(`transient-${storage.name}`),
			agents: [worker],
			seats: { [worker.name]: 'named' },
			runtime,
			stream: scripted(() => {
				calls += 1;
				throw new Error('503 the provider is overloaded');
			}),
		});
		const events = collect(room);
		try {
			const visit = await room.visit(person);
			await visit.send({ to: worker.name, text: 'answer me' });
			await settled(room);
			// A transient failure may pass, so the room retries to the cap before it
			// gives up.
			expect(calls).toBe(hostingOf(runtime).limits.activation.attempts);
			expect(abandonments(events)).toEqual([
				expect.objectContaining({ agent: worker.name, cause: 'transient' }),
			]);
			expect(errors(events).every((event) => event.cause === 'transient')).toBe(true);
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});
});
