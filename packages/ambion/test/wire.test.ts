/**
 * Everything that crosses between a seat and its room, and every entry on the
 * journal, is plain JSON: it survives the wire unchanged.
 */
import { describe, expect, it } from 'vitest';
import {
	type ActivationView,
	assertWire,
	type CommitRequest,
	type CommitResult,
	type LeaseRequest,
	type LeaseResponse,
	roundTrip,
	type Steer,
	type ViewResponse,
	type Wake,
} from '../src/hosting.ts';
import { createRuntime } from '../src/index.ts';
import type { Close, Composition, LeaseChange } from '../src/journal/events.ts';
import { fakeClock } from './support/clock.ts';
import { roomName, storedOf } from './support/room.ts';
import { oneExchange } from './support/scenarios.ts';
import { sqlite } from './support/storage.ts';

const at = '2026-01-01T09:00:00.000Z';

const stored: Record<string, LeaseChange | Close | Composition> = {
	claim: {
		id: 'message:2:product:1',
		seq: 2,
		phase: 'running',
		expiresAt: 60_000,
		at,
		readThrough: 0,
	},
	end: {
		id: 'message:2:product:1',
		seq: 4,
		phase: 'ended',
		reason: 'released',
		at,
		readThrough: 0,
	},
	endWithUsage: {
		id: 'message:2:product:1',
		seq: 4,
		phase: 'ended',
		reason: 'released',
		at,
		readThrough: 0,
		usage: { input: 5, output: 3, cacheRead: 2, cacheWrite: 1 },
	},
	close: { owner: 'priya', from: 2, through: 4, seq: 4, at, summary: 'assistant' },
	composition: {
		version: 2,
		goal: 'Decide the pour date.',
		summary: 'assistant',
		agents: [
			{ name: 'product', identity: 'The product.', attention: 'broadcast' },
			{
				name: 'assistant',
				identity: 'Writes the one message.',
				attention: 'none',
			},
		],
		available: [{ name: 'surveyor', identity: 'Holds the tonnage.', attention: 'named' }],
		seq: 0,
		at,
	},
};

const wake: Wake = {
	room: 'site',
	seat: 'product',
	activation: 'message:3:product:1',
};
const steer: Steer = {
	room: 'site',
	seat: 'product',
	activation: 'message:3:product:1',
	after: 3,
	message: { kind: 'said', seq: 5, at, from: 'priya', text: 'And the pump?' },
};
const view: ActivationView = {
	spec: {
		id: 'closed:4:assistant:1',
		seat: 'assistant',
		attempt: 1,
		purpose: { kind: 'summarize', exchange: 2, person: 'priya', people: ['priya'], through: 4 },
	},
	through: 4,
	context: { name: 'site', now: Date.parse(at), participants: [], messages: [], reserve: [] },
};
const departed: ActivationView = {
	...view,
	context: {
		...view.context,
		participants: [
			{
				kind: 'human',
				name: 'priya',
				identity: 'Reads the room.',
				presence: 'absent',
				changedAt: at,
				lastDeparture: 3,
				messagesSinceDeparture: 2,
			},
		],
	},
};
const requests: Record<string, CommitRequest | LeaseRequest | string> = {
	say: {
		activation: 'message:2:product:1',
		key: 'call-1',
		readThrough: 2,
		intent: { kind: 'said', text: 'No.' },
	},
	directed: {
		activation: 'message:2:product:1',
		key: 'call-2',
		readThrough: 2,
		intent: { kind: 'said', to: 'priya', text: 'No.' },
	},
	summary: {
		activation: 'closed:4:assistant:1',
		key: 'call-3',
		readThrough: 4,
		intent: {
			kind: 'said',
			text: 'Thursday is out.',
		},
	},
	seating: {
		activation: 'message:2:assistant:1',
		key: 'call-4',
		intent: { kind: 'seated', name: 'surveyor' },
	},
	claim: { activation: 'message:2:product:1', operation: 'claim' },
	release: {
		activation: 'message:2:product:1',
		operation: 'release',
		reason: 'released',
		readThrough: 0,
	},
	releaseWithUsage: {
		activation: 'message:2:product:1',
		operation: 'release',
		reason: 'released',
		readThrough: 0,
		usage: { input: 5, output: 3, cacheRead: 2, cacheWrite: 1, cost: 0.01 },
	},
	viewOf: 'message:2:product:1',
};
const responses: Record<string, ViewResponse | CommitResult | LeaseResponse> = {
	view: { view },
	respondView: {
		view: {
			...view,
			spec: { ...view.spec, purpose: { kind: 'respond', message: 4 } },
			through: 4,
		},
	},
	stale: { stale: 'the lease ended' },
	committed: {
		committed: { kind: 'said', seq: 3, key: 'call-1', at, from: 'product', text: 'No.' },
	},
	missed: {
		missed: [{ kind: 'said', seq: 3, key: 'k', at, from: 'priya', text: 'And the pump?' }],
	},
	committedWithRefs: {
		committed: {
			kind: 'said',
			seq: 3,
			key: 'call-2',
			at,
			from: 'product',
			text: 'Done.',
			refs: ['https://x/a'],
		},
	},
	refused: { refused: "'nobody' is not in the reserve." },
	ok: { ok: { expiresAt: 1767258060000, lastSeq: 3 } },
};

describe('the wire', () => {
	it.each(Object.entries({ ...stored, departed, wake, steer, ...requests, ...responses }))(
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

	it('replays a SQLite journal whose every entry is plain JSON', async () => {
		const opened = await sqlite.open();
		try {
			const runtime = createRuntime({ storage: opened.storage, clock: fakeClock() });
			const name = roomName('wire-sqlite');
			await oneExchange.run({ runtime, name });
			const written = await storedOf(opened.journals, name);
			expect(written.map((entry) => entry.kind)).toContain('close');
			expect(written.map((entry) => entry.kind)).toContain('composition');
			expect(written.map((entry) => entry.kind)).toContain('lease');
			for (const entry of written) {
				expect(() => assertWire(entry.body)).not.toThrow();
				expect(roundTrip(entry.body)).toStrictEqual(entry.body);
			}
		} finally {
			await opened.dispose();
		}
	});
});
