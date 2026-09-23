/**
 * The room reads a provider error as permanent or transient. A permanent
 * failure does not pass on a retry, so the room runs the seat once and
 * abandons the rest. A transient failure may pass, so the room retries to
 * the cap before it gives up.
 */
import { describe, expect, it } from 'vitest';
import { piExecution } from '../../pi/src/index.ts';
import { hostingOf } from '../src/hosting.ts';
import { createRuntime, defineHuman, startRoom } from '../src/index.ts';
import { openFor } from './support/core-failure.ts';
import { collect, roomName, scriptedAgent, waitForRoom } from './support/room.ts';
import { scripted } from './support/scripted.ts';
import { stopAtEnd } from './support/stop.ts';
import { storages } from './support/storage.ts';

const worker = scriptedAgent('worker');
const person = defineHuman({ name: 'priya', identity: 'Project manager.' });

describe.each(storages)('provider failure classification on $name storage', (storage) => {
	it.each([
		[
			'abandons a permanent failure in one attempt',
			'400 Your credit balance is too low to make this request',
			'permanent',
		],
		// The token count reads like a 400 status, but a rate limit is transient.
		[
			'does not read a rate-limit token count as a permanent status',
			'429 rate limit of 400,000 input tokens per minute exceeded',
			'transient',
		],
		['retries a transient failure to the cap', '503 the provider is overloaded', 'transient'],
	] as const)('%s', async (_case, message, cause) => {
		const opened = await openFor(storage);
		let calls = 0;
		const runtime = createRuntime({
			storage: opened.storage,
			limits: { activation: { backoff: () => 0 } },
		});
		const room = stopAtEnd(
			await startRoom({
				name: roomName(`${cause}-${storage.name}`),
				agents: [worker],
				seats: { [worker.name]: 'named' },
				runtime,
				execution: piExecution({
					stream: scripted(() => {
						calls += 1;
						throw new Error(message);
					}),
				}),
			}),
		);
		const events = collect(room);
		await (await room.visit(person)).send({ to: worker.name, text: 'answer me' });
		await waitForRoom(room);
		expect(calls).toBe(cause === 'permanent' ? 1 : hostingOf(runtime).limits.activation.attempts);
		expect(events.filter((event) => event.type === 'abandoned')).toEqual([
			expect.objectContaining({ agent: worker.name, cause }),
		]);
		const errors = events.filter((event) => event.type === 'error');
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.every((event) => event.cause === cause)).toBe(true);
	});
});
