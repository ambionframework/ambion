/**
 * An ambient room: a seat that schedules its own next check. No person speaks
 * after the first message, so no exchange closes with a summary, and the
 * record grows with every cycle. The default context cap keeps the view of
 * each activation bounded.
 */
import { memoryJournals } from '@ambionframework/journal';
import { describe, expect, it } from 'vitest';
import { createRuntime, defineAgent, startRoom } from '../src/index.ts';
import { fakeClock, quiet, schedule, scripted, settled } from '../src/testing.ts';
import { andrei, roomName } from './support/room.ts';
import { stopAtEnd } from './support/stop.ts';

const CYCLE_SECONDS = 60;

const watcher = defineAgent({
	name: 'watcher',
	identity: 'Checks the build again and again.',
	executor: { kind: 'scripted', instructions: 'schedule the next check', tools: [] },
});

/** Run `cycles` self-scheduled checks, and give the size of the view each activation read. */
async function views(cycles: number, limits?: { context: { messages: number } }) {
	const clock = fakeClock();
	const sizes: number[] = [];
	const room = stopAtEnd(
		await startRoom({
			name: roomName('ambient-window'),
			agents: [watcher],
			runtime: createRuntime({ clock, storage: memoryJournals(), ...(limits ? { limits } : {}) }),
			execution: scripted((step) => {
				if (step.results.length > 0) return quiet();
				sizes.push(step.view.context.messages.length);
				return schedule('Check the build again.', CYCLE_SECONDS);
			}),
		}),
	);
	await (await room.visit(andrei)).send({ text: 'Watch the build.' });
	await settled(room);
	for (let cycle = 0; cycle < cycles; cycle += 1) {
		await clock.advance(CYCLE_SECONDS * 1000);
		await settled(room);
	}
	return { sizes, total: (await room.read({ messages: {} })).messages.length };
}

describe('an ambient room', () => {
	it('windows the view of each activation at the default cap while the record grows', async () => {
		const { sizes, total } = await views(110);
		expect(sizes.length).toBeGreaterThan(100);
		expect(total).toBeGreaterThan(200);
		expect(Math.max(...sizes)).toBe(200);
	});

	it('keeps 30 cycles inside a cap of 20 messages', async () => {
		const { sizes, total } = await views(30, { context: { messages: 20 } });
		expect(total).toBeGreaterThan(40);
		expect(Math.max(...sizes)).toBe(20);
	});
});
