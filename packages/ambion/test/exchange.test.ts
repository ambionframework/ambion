/**
 * The exchange lifecycle on its own: no room, no seats, no model. `Exchanges`
 * holds the open exchange and the two ends the room reports, and every
 * transition is synchronous, so each claim in docs/exchange.md §3 and §6 is
 * one call and one assertion. The assistant's scheduler is proved beside it,
 * because the one fact it reads at a settle is the one `Exchanges` reports.
 */
import { describe, expect, it } from 'vitest';
import { Assistant } from '../src/assistant.ts';
import { defineAgent } from '../src/define.ts';
import { Exchanges } from '../src/exchange.ts';
import type { Message } from '../src/types.ts';

const at = new Date().toISOString();
const said = (seq: number, from: string, text = 'Thursday.'): Message => ({
	kind: 'said',
	seq,
	at,
	from,
	text,
});
const question = (seq: number, from = 'priya'): Message => said(seq, from, 'Thursday?');
const arrival = (seq: number, from = 'priya'): Message => ({
	kind: 'arrived',
	seq,
	at,
	from,
	identity: 'Site manager.',
});

/** Whether a promise has resolved by the next microtask. */
async function resolved(promise: Promise<void>): Promise<boolean> {
	let done = false;
	void promise.then(() => {
		done = true;
	});
	await Promise.resolve();
	return done;
}

describe('an exchange', () => {
	it('opens on a question from a person, and closes with the range it reached', () => {
		const exchanges = new Exchanges();
		expect(exchanges.note(question(3), true)).toMatchObject({ owner: 'priya', from: 3 });
		expect(exchanges.current()?.owner).toBe('priya');

		// the seats work, so nothing settles
		exchanges.stir();
		expect(exchanges.settle(true, 5)).toBeUndefined();
		expect(exchanges.current()?.owner).toBe('priya');

		// the seats stop, and the range is the record as it stands
		expect(exchanges.settle(false, 7)).toEqual({
			closed: { owner: 'priya', from: 3, at, through: 7 },
			worked: true,
		});
		expect(exchanges.current()).toBeUndefined();
	});

	it('opens for nobody but a person, and never twice at once', () => {
		const exchanges = new Exchanges();
		expect(exchanges.note(arrival(1), true)).toBeUndefined();
		expect(exchanges.note(question(2, 'product'), false)).toBeUndefined();
		expect(exchanges.current()).toBeUndefined();

		const opened = exchanges.note(question(3), true);
		// a second question steers the open one and changes nothing
		expect(exchanges.note(question(4, 'sam'), true)).toBeUndefined();
		expect(exchanges.current()).toBe(opened);
	});

	it('settles with nothing to close when the room worked on its own account', () => {
		const exchanges = new Exchanges();
		exchanges.stir();
		expect(exchanges.settle(false, 2)).toEqual({ closed: undefined, worked: true });
	});

	it('reports work once per settle, and a second settle at one quiescence reports none', () => {
		const exchanges = new Exchanges();
		exchanges.stir();
		expect(exchanges.settle(false, 1)?.worked).toBe(true);
		// a question that woke nobody, an aborted activation ending late
		expect(exchanges.settle(false, 2)?.worked).toBe(false);
		// the assistant drafting stirs nothing, so its end reports none either
		expect(exchanges.settle(false, 3)?.worked).toBe(false);
		exchanges.stir();
		expect(exchanges.settle(false, 4)?.worked).toBe(true);
	});
});

describe('the two ends', () => {
	it('settles whoever waited before it closes, and at once when nothing works', async () => {
		const exchanges = new Exchanges();
		expect(await resolved(exchanges.settled(false))).toBe(true);

		exchanges.note(question(1), true);
		const waited = exchanges.settled(true);
		expect(await resolved(waited)).toBe(false);
		exchanges.settle(false, 2);
		expect(await resolved(waited)).toBe(true);
	});

	it('is quiet only when nothing at all is active, and says so once per quiescence', async () => {
		const exchanges = new Exchanges();
		expect(await resolved(exchanges.quiet(true))).toBe(true);

		const waited = exchanges.quiet(false);
		expect(exchanges.quiesce(false)).toBe(false);
		expect(await resolved(waited)).toBe(false);
		expect(exchanges.quiesce(true)).toBe(true);
		expect(await resolved(waited)).toBe(true);
	});

	it('drains whoever waited on quiet when the room stops', async () => {
		const exchanges = new Exchanges();
		const waited = exchanges.quiet(false);
		exchanges.drain();
		expect(await resolved(waited)).toBe(true);
	});
});

describe('what the assistant makes of a settle', () => {
	const def = defineAgent({
		name: 'assistant',
		identity: 'Writes the one message a person reads.',
		instructions: 'stay quiet',
		model: 'scripted/assistant',
	});
	/** Two answers from a seat: enough that one message would serve. */
	const record: Message[] = [question(1), said(2, 'product'), said(3, 'planner')];
	const fromSeat = (name: string) => name !== 'priya' && name !== 'assistant';

	it('drafts for the owner at the settle that closed the exchange', () => {
		const assistant = new Assistant({ def, attention: 'none' });
		assistant.owe('priya', 1);
		expect(assistant.dueAtQuiescence(record, 3, fromSeat)).toMatchObject({
			person: 'priya',
			from: 1,
			through: 3,
		});
	});

	/** A failed draft waits for the next settle where a seat worked, and for nothing less. */
	it('holds a failed draft until the seats stop again', () => {
		const assistant = new Assistant({ def, attention: 'none' });
		assistant.owe('priya', 1);
		assistant.dueAtQuiescence(record, 3, fromSeat);
		assistant.activationEnded({ wrote: false, failed: true });

		// the draft's own end, and a settle no seat worked before: not yet
		expect(assistant.dueAfterDraft(record, 3, fromSeat)).toBeUndefined();
		// the seats worked and stopped: now
		expect(assistant.dueAtQuiescence(record, 3, fromSeat)).toMatchObject({ person: 'priya' });
	});

	it('owes nothing for a draft that stood down, and nothing for one that wrote', () => {
		const assistant = new Assistant({ def, attention: 'none' });
		assistant.owe('priya', 1);
		assistant.dueAtQuiescence(record, 3, fromSeat);
		assistant.activationEnded({ wrote: false, failed: false });
		expect(assistant.dueAtQuiescence(record, 3, fromSeat)).toBeUndefined();

		assistant.owe('priya', 1);
		assistant.dueAtQuiescence(record, 3, fromSeat);
		assistant.activationEnded({ wrote: true, failed: false });
		expect(assistant.dueAtQuiescence(record, 3, fromSeat)).toBeUndefined();
	});
});
