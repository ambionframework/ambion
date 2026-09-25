/**
 * A scheduled say on Durable Objects. The room object's alarm is the room's
 * clock: it takes the due time of the say beside every other time the room
 * waits on, and returns the say with no code of the adapter's own.
 */
import type { Message } from '@ambionframework/ambion';
import { expect, it } from 'vitest';
import { roomOf } from './objects.ts';
import { until } from './until.ts';

const NAME = 'room-scheduled';

it("returns a scheduled say through the room object's alarm, for the owner of its exchange", async () => {
	const stub = roomOf(NAME);
	await stub.start({ name: NAME, seats: { checker: 'broadcast' }, agents: ['checker'] });
	await stub.visit({ name: 'priya', identity: 'Project manager.' });
	const first = await stub.send({ from: 'priya', text: 'Is the pour logged?', key: 'q1' });
	await stub.waitForClose(first.from);
	const before = await stub.read({ messages: false });
	expect(before.scheduled).toMatchObject([{ seat: 'checker', owner: 'priya' }]);
	const find = (test: (message: Message) => boolean) => async () =>
		(await stub.read()).messages.find(test);
	const returned = await until(find((message) => message.kind === 'returned'));
	expect(returned).toMatchObject({ to: 'checker', owner: 'priya', text: 'Check the pour log.' });
	await until(
		find((message) => message.kind === 'said' && message.text === 'The check came back.'),
	);
	const second = await until(async () =>
		(await stub.read()).exchanges.find((exchange) => exchange.from === returned.seq),
	);
	expect(second).toMatchObject({ owner: 'priya' });
});

it('lists the says that wait, and dismisses one through the room object', async () => {
	const name = `${NAME}-dismissed`;
	const stub = roomOf(name);
	await stub.start({ name, seats: { checker: 'broadcast' }, agents: ['checker'] });
	await stub.visit({ name: 'priya', identity: 'Project manager.' });
	const first = await stub.send({ from: 'priya', text: 'Is the pour logged tomorrow?', key: 'q1' });
	await stub.waitForClose(first.from);
	const [say] = await stub.scheduledSays();
	expect(say).toMatchObject({ seat: 'checker', owner: 'priya', text: 'Check the pour log.' });
	expect(await stub.dismiss(say?.seq ?? 0)).toBe(true);
	expect(await stub.dismiss(say?.seq ?? 0)).toBe(false);
	expect(await stub.scheduledSays()).toEqual([]);
	expect((await stub.read()).messages.at(-1)).toMatchObject({
		kind: 'dismissed',
		message: say?.seq,
	});
});
