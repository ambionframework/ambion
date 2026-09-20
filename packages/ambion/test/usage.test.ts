/**
 * The usage of an activation reaches the release entry, the `activation_end`
 * event, and the closed exchange. A resumed room folds the same total.
 */
import { describe, expect, it } from 'vitest';
import type { RoomNotification, Usage } from '../src/index.ts';
import { createRuntime, defineAgent, pi, readExchange, startRoom } from '../src/index.ts';
import { quiet, scripted, settled } from '../src/testing.ts';
import { andrei, collect, roomName, storedOf } from './support/room.ts';
import { storages } from './support/storage.ts';
import { traceOf } from './support/trace.ts';

const product = defineAgent({
	name: 'product',
	identity: 'Answers questions.',
	executor: pi({ instructions: 'Answer.', model: 'scripted/product' }),
});

const spent = {
	input: 7,
	output: 3,
	cacheRead: 2,
	cacheWrite: 1,
	totalTokens: 13,
	cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.5 },
};

const sum = (steps: readonly Usage[]): Usage =>
	steps.reduce<Usage>(
		(total, step) => ({
			input: total.input + step.input,
			output: total.output + step.output,
			cacheRead: total.cacheRead + step.cacheRead,
			cacheWrite: total.cacheWrite + step.cacheWrite,
			cost: (total.cost ?? 0) + (step.cost ?? 0),
		}),
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	);

const isEnd = (
	event: RoomNotification,
): event is Extract<RoomNotification, { type: 'activation_end' }> =>
	event.type === 'activation_end';

describe.each(storages)('usage on $name storage', (storage) => {
	it('carries the activation total to the event, the release entry, and the closed exchange', async () => {
		const opened = await storage.open();
		const runtime = createRuntime({ storage: opened.storage });
		const name = roomName(`usage-${storage.name}`);
		try {
			const room = await startRoom({
				name,
				agents: [product],
				runtime,
				stream: scripted(() => ({ ...quiet('done'), usage: spent })),
			});
			const events = collect(room);
			const visit = await room.visit(andrei);
			const handle = await visit.send({ text: 'Ready?' });
			await settled(room, { timeout: 2_000 });

			const ends = events.filter(isEnd);
			const worked = ends.find((event) => event.agent === 'product');
			if (worked?.usage === undefined) throw new Error('Expected usage on activation_end.');
			const steps = (await traceOf(runtime, name, worked.activation)).flatMap((step) =>
				step.type === 'usage' ? [step] : [],
			);
			expect(steps.length).toBeGreaterThan(0);
			expect(worked.usage).toEqual(sum(steps));
			expect(worked.usage).toEqual({ input: 7, output: 3, cacheRead: 2, cacheWrite: 1, cost: 0.5 });

			const stored = await storedOf(opened.journals, name);
			const release = stored.find(
				(entry) =>
					entry.kind === 'lease' &&
					JSON.stringify(entry.body).includes(`"id":"${worked.activation}","phase":"ended"`),
			);
			expect(release?.body).toMatchObject({ usage: worked.usage });

			// The closed exchange sums every ended activation that recorded usage.
			const wanted = sum(ends.flatMap((event) => (event.usage === undefined ? [] : [event.usage])));
			const read = await readExchange(name, handle.from, { runtime });
			expect(read?.exchange).toMatchObject({ status: 'closed', usage: wanted });
			await room.stop();

			// A runtime that replays the journal folds the same total.
			const again = await readExchange(name, handle.from, {
				runtime: createRuntime({ storage: opened.storage }),
			});
			expect(again?.exchange).toMatchObject({ status: 'closed', usage: wanted });
		} finally {
			await opened.dispose();
		}
	});
});
