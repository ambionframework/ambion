/** Every committed event has the same meaning during live operation and replay. */
import { expect, it } from 'vitest';
import type { Entry } from '../src/journal/journal.ts';
import { foldRoom } from '../src/room/fold.ts';
import { evolve } from '../src/room/transition.ts';
import type { Close, Composition } from '../src/wire.ts';

const at = '2026-01-01T09:00:00.000Z';
const now = Date.parse(at);
const retry = { backoff: (attempt: number) => attempt * 30_000 };
const composition: Composition = {
	seq: 2,
	at,
	agents: [{ name: 'product', identity: 'Product.', attention: 'broadcast' }],
	available: [{ name: 'surveyor', identity: 'Surveyor.', attention: 'named' }],
};
const close: Close = { owner: 'priya', from: 4, through: 7, at };
const id = 'message:4:product:1';
const entries: Entry[] = [
	{ kind: 'run', seq: 1, body: { at } },
	{ kind: 'composition', seq: 2, body: composition },
	{
		kind: 'message',
		seq: 3,
		key: 'arrival',
		body: { kind: 'arrived', at, from: 'priya', subject: 'priya', identity: 'Priya.' },
	},
	{
		kind: 'message',
		seq: 4,
		key: 'question',
		body: { kind: 'said', at, from: 'priya', text: 'Hello.', wakes: ['product'] },
	},
	{ kind: 'lease', seq: 5, body: { id, phase: 'running', expiry: now + 60_000, at } },
	{
		kind: 'lease',
		seq: 6,
		body: { id, phase: 'running', expiry: now + 90_000, at: new Date(now + 30_000).toISOString() },
	},
	{
		kind: 'message',
		seq: 7,
		key: 'answer',
		body: { kind: 'said', at, from: 'product', text: 'Ready.', activationId: id },
	},
	{ kind: 'lease', seq: 8, body: { id, phase: 'ended', reason: 'released', at } },
	{ kind: 'close', seq: 9, body: close },
	{
		kind: 'checkpoint',
		seq: 10,
		body: { v: 1, at, composition, floor: 8, closes: [close], leases: [] },
	},
	{
		kind: 'message',
		seq: 11,
		key: 'seating',
		body: { kind: 'seated', at, subject: 'surveyor', identity: 'Surveyor.', attention: 'named' },
	},
	{
		kind: 'message',
		seq: 12,
		key: 'departure',
		body: { kind: 'unseated', at, subject: 'product' },
	},
	{ kind: 'composition', seq: 13, body: { ...composition, goal: 'A new goal.' } },
];

/** Freeze input values so accidental mutation fails where it happens. */
function freeze(value: unknown): void {
	if (value === null || typeof value !== 'object') return;
	if (value instanceof Map) {
		for (const entry of value.values()) freeze(entry);
	} else {
		for (const entry of Object.values(value)) freeze(entry);
	}
	Object.freeze(value);
}

it('evolves every event without changing any earlier projection or committed input', () => {
	let state = foldRoom([], retry);
	const retained: { state: typeof state; snapshot: typeof state }[] = [];
	const history: Entry[] = [];
	for (const event of entries) {
		retained.push({ state, snapshot: structuredClone(state) });
		freeze(state);
		freeze(event);
		history.push(event);
		state = evolve(state, event, retry);
		expect(state).toEqual(foldRoom(history, retry));
		expect(state.messages).toHaveLength(history.filter((entry) => entry.kind === 'message').length);
	}
	for (const previous of retained) expect(previous.state).toEqual(previous.snapshot);
	expect(state.composition?.goal).toBe('A new goal.');
	expect(state.roster.map((seat) => seat.name)).toEqual(['product']);
	expect(state.leases.size).toBe(0);
});
