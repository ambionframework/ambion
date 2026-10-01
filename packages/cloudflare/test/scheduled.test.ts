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

it("returns a scheduled say through the room object's alarm, into an exchange with no person", async () => {
	const stub = roomOf(NAME);
	await stub.start({ seats: { checker: 'broadcast' }, definitions: ['checker'] });
	await stub.visit({ name: 'priya', identity: 'Project manager.' });
	const first = await stub.send({ from: 'priya', text: 'Is the pour logged?', key: 'q1' });
	await stub.waitForClose(first.from);
	const before = await stub.read({ messages: false });
	expect(before.scheduled).toMatchObject([{ seat: 'checker' }]);
	const find = (test: (message: Message) => boolean) => async () =>
		(await stub.read()).messages.find(test);
	const returned = await until(find((message) => message.kind === 'posted'));
	expect(returned).toMatchObject({ to: 'checker', returns: expect.any(Number) });
	expect(returned).toMatchObject({ text: 'Check the pour log.' });
	await until(
		find((message) => message.kind === 'said' && message.text === 'The check came back.'),
	);
	const second = await until(async () =>
		(await stub.read()).exchanges.find((exchange) => exchange.from === returned.seq),
	);
	expect(second).toMatchObject({ from: returned.seq });
	expect(second).not.toHaveProperty('person');
});

it('lists the says that wait, and dismisses one through the room object', async () => {
	const name = `${NAME}-dismissed`;
	const stub = roomOf(name);
	await stub.start({ seats: { checker: 'broadcast' }, definitions: ['checker'] });
	await stub.visit({ name: 'priya', identity: 'Project manager.' });
	const first = await stub.send({ from: 'priya', text: 'Is the pour logged tomorrow?', key: 'q1' });
	await stub.waitForClose(first.from);
	const [say] = (await stub.read({ messages: false })).scheduled;
	expect(say).toMatchObject({ seat: 'checker', text: 'Check the pour log.' });
	expect(await stub.dismiss(say?.seq ?? 0)).toBe(true);
	expect(await stub.dismiss(say?.seq ?? 0)).toBe(false);
	expect((await stub.read({ messages: false })).scheduled).toEqual([]);
	expect((await stub.read()).messages.at(-1)).toMatchObject({
		kind: 'dismissed',
		message: say?.seq,
	});
});

it('posts through the room object into an exchange with no person, once for each key', async () => {
	const name = `${NAME}-posted`;
	const stub = roomOf(name);
	await stub.start({ seats: { product: 'broadcast' }, definitions: ['product'] });
	const post = { to: 'product', text: 'lab: pour 7 is set.', key: 'pour-7' };
	const posted = await stub.post(post);
	expect(posted).not.toHaveProperty('person');
	expect(await stub.post(post)).toEqual(posted);
	const conversation = await stub.waitForClose(posted.from);
	expect(conversation).toMatchObject([
		{ kind: 'posted', to: 'product', text: 'lab: pour 7 is set.' },
		{ kind: 'said', from: 'product' },
	]);
});
