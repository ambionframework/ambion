import { env, runInDurableObject } from 'cloudflare:test';
import type { Message } from '@ambionframework/ambion';
import type { JournalOpener } from '@ambionframework/journal';
import { expect, it } from 'vitest';
import { configure, type SeatEvent } from '../src/configure.ts';
import { scripted } from './scripted.ts';
import { until } from './until.ts';
import { assistant, product, slow } from './worker.ts';

it('reports audit failure while a remote seat completes its contribution', async () => {
	const name = 'audit-outage';
	const room = env.ROOM.get(env.ROOM.idFromName(name));
	const seat = env.SEAT.get(
		env.SEAT.idFromName(JSON.stringify(['ambion/seat-object', name, 'product'])),
	);
	const events: SeatEvent[] = [];
	const defaults = { agents: [assistant, product, slow], stream: scripted, wake: { resend: 50 } };
	configure({ ...defaults, onSeatEvent: (event) => events.push(event) });
	try {
		await seat.hold(true);
		await runInDurableObject(seat, async (instance) => {
			const internal = instance as unknown as { storage: JournalOpener };
			const storage = internal.storage;
			internal.storage = {
				async open(id) {
					const journal = await storage.open(id);
					if (!id.startsWith('["ambion/pi-session",')) return journal;
					return {
						read: journal.read.bind(journal),
						append: async () => {
							throw new Error('Remote audit unavailable.');
						},
					};
				},
			};
		});
		await room.start({ name, agents: ['product'] });
		await room.visit({ name: 'priya', identity: 'Project manager.' });
		const exchange = await room.send({ from: 'priya', text: 'When is the pour?', key: 'audit-q' });
		await seat.hold(false);
		const audit = await until(async () => events.find((event) => event.event === 'audit_error'));
		expect(audit).toMatchObject({
			room: name,
			seat: 'product',
			activation: expect.stringContaining(':product:1'),
			error: 'Remote audit unavailable.',
		});
		const messages: Message[] = await room.waitForClose(exchange.from);
		expect(messages.filter((message) => message.from === 'product')).toHaveLength(1);
		expect(events.filter((event) => event.event === 'error')).toEqual([]);
		expect(
			(await room.participants()).find((participant) => participant.name === 'product'),
		).toMatchObject({ status: 'idle' });
	} finally {
		await room.abort();
		configure(defaults);
	}
});
