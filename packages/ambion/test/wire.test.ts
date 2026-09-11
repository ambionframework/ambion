/**
 * Everything that crosses between a seat and its room, and every row on the
 * log, is plain JSON: it survives the wire unchanged.
 */
import { describe, expect, it } from 'vitest';
import {
	type ActivationView,
	assertWire,
	type Close,
	type Commit,
	type CommitResponse,
	type Composition,
	createRuntime,
	type Lease,
	type LeaseChange,
	type LeaseResponse,
	roundTrip,
	type ViewResponse,
	type Wake,
} from '../src/index.ts';
import { fakeClock } from './support/clock.ts';
import { roomName, rowsOf } from './support/room.ts';
import { oneExchange } from './support/scenarios.ts';
import { jsonl } from './support/storage.ts';

const at = '2026-01-01T09:00:00.000Z';

const rows: Record<string, LeaseChange | Close | Composition> = {
	claim: { id: '2:product', after: 2, phase: 'running', expiry: 60_000, at },
	end: { id: '2:product', after: 4, phase: 'ended', reason: 'released', at },
	close: { owner: 'priya', from: 2, through: 4, after: 4, at, wakes: ['assistant'] },
	composition: {
		assistant: { name: 'assistant', identity: 'Writes the one message.', attention: 'none' },
		goal: 'Decide the pour date.',
		agents: [{ name: 'product', identity: 'The product.', attention: 'broadcast' }],
		available: [{ name: 'surveyor', identity: 'Holds the tonnage.', attention: 'named' }],
		after: 0,
		at,
	},
};

const wake: Wake = {
	room: 'site',
	seat: 'product',
	activation: '3:product',
	steer: { seq: 3, line: '[priya] And the pump?' },
};
const view: ActivationView = {
	activation: 'close:4:1',
	seat: 'assistant',
	model: 'scripted/assistant',
	lastSeq: 4,
	systemPrompt: 'You are the assistant.',
	context: 'The record so far.',
	hand: 'summarise',
	closing: { person: 'priya', from: 2, through: 4 },
};
const requests: Record<string, Commit | Lease | string> = {
	say: {
		activation: '2:product',
		key: 'call-1',
		readThrough: 2,
		intent: { kind: 'said', text: 'No.' },
	},
	directed: {
		activation: '2:product',
		key: 'call-2',
		readThrough: 2,
		intent: { kind: 'said', to: 'priya', text: 'No.' },
	},
	summary: {
		activation: 'close:4:1',
		key: 'call-3',
		readThrough: 4,
		intent: {
			kind: 'summary',
			to: 'priya',
			text: 'Thursday is out.',
			covers: { from: 2, through: 4 },
		},
	},
	seating: {
		activation: '2:assistant',
		key: 'call-4',
		intent: { kind: 'seated', name: 'surveyor' },
	},
	claim: { activation: '2:product', phase: 'running' },
	release: { activation: '2:product', phase: 'ended', reason: 'released' },
	viewOf: '2:product',
};
const responses: Record<string, ViewResponse | CommitResponse | LeaseResponse> = {
	view: { view },
	stale: { stale: 'the lease ended' },
	committed: {
		committed: { kind: 'said', seq: 3, key: 'call-1', at, from: 'product', text: 'No.' },
	},
	missed: {
		missed: [{ kind: 'said', seq: 3, key: 'k', at, from: 'priya', text: 'And the pump?' }],
	},
	refused: { refused: "'nobody' is not in the reserve." },
	ok: { ok: { expiry: 1767258060000, lastSeq: 3 } },
};

describe('the wire', () => {
	it.each(Object.entries({ ...rows, wake, ...requests, ...responses }))(
		'carries %s unchanged',
		(_name, value) => {
			expect(() => assertWire(value)).not.toThrow();
			expect(roundTrip(value)).toStrictEqual(value);
		},
	);

	it('refuses what would not survive', () => {
		expect(() => assertWire({ to: undefined })).toThrow(/to is undefined/);
		expect(() => assertWire({ at: new Date() })).toThrow(/is a Date/);
		expect(() => assertWire({ seats: new Map() })).toThrow(/is a Map/);
		expect(() => assertWire({ expiry: Number.NaN })).toThrow(/finite/);
		expect(() => assertWire({ fire: () => {} })).toThrow(/is a function/);
		expect(() => assertWire({ error: new Error('boom') })).toThrow(/is a Error/);
	});

	it('replays a JSONL log whose every row is plain JSON', async () => {
		const opened = await jsonl.open();
		try {
			const runtime = createRuntime({ sessions: opened.sessions, clock: fakeClock() });
			const name = roomName('wire-jsonl');
			await oneExchange.run({ runtime, name });
			const written = await rowsOf(opened.sessions, name);
			expect(written.map((row) => row.type)).toContain('ambion/close');
			expect(written.map((row) => row.type)).toContain('ambion/composition');
			expect(written.map((row) => row.type)).toContain('ambion/lease');
			for (const row of written) {
				expect(() => assertWire(row.data)).not.toThrow();
				expect(roundTrip(row.data)).toStrictEqual(row.data);
			}
		} finally {
			await opened.dispose();
		}
	});
});
