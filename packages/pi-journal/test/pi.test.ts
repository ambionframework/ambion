/** Pi transcript audits preserve their ordered record over named Ambion journals. */
import { DatabaseSync } from 'node:sqlite';
import { memoryJournals, type SqlValue, sqliteJournals } from '@ambionframework/journal';
import type { JsonValue } from '@earendil-works/pi-agent-core';
import { describe, expect, it, onTestFinished } from 'vitest';
import { piSessions } from '../src/index.ts';
import { isEntryWrite, wrapped } from './support/journals.ts';

const backends = [
	{ name: 'memory', open: memoryJournals },
	{
		name: 'SQLite',
		open: () => {
			const database = new DatabaseSync(':memory:');
			onTestFinished(() => database.close());
			return sqliteJournals({
				run: (query, ...params) => {
					database.prepare(query).run(...params);
				},
				all: (query, ...params) =>
					database.prepare(query).all(...params) as Record<string, SqlValue>[],
			});
		},
	},
];

const custom = (id: string, data: JsonValue) => ({
	id,
	type: 'custom' as const,
	customType: 'audit',
	data,
});

function gate() {
	let open: () => void = () => {};
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

describe.each(backends)('Pi transcript audits over $name journals', ({ open }) => {
	it('preserves the ordered record across newly opened facades, under a collision-safe name', async () => {
		const names: string[] = [];
		const journals = wrapped(open(), (_storage, name) => {
			names.push(name);
			return {};
		});
		const first = await piSessions(journals).open('room/child', 'parent');
		const root = await first.appendEntry(custom('root', { message: 'root' }), 'main');
		const branch = await first.appendEntry(custom('branch', { message: 'branch' }), 'main');

		const second = await piSessions(journals).open('room/child');
		expect(await second.getMetadata()).toMatchObject({
			id: 'room/child',
			parentSessionId: 'parent',
		});
		expect(await second.findEntries({ customType: 'audit', order: 'oldestFirst' })).toMatchObject([
			{ id: root.id, parentId: null, seq: 1, data: { message: 'root' } },
			{ id: branch.id, parentId: root.id, seq: 2, data: { message: 'branch' } },
		]);
		expect(await second.findEntries({ order: 'newestFirst', limit: 1 })).toMatchObject([
			{ id: branch.id, seq: 2 },
		]);
		expect(await second.getEntry(root.id)).toMatchObject({ id: root.id, seq: 1 });
		expect(new Set(names)).toEqual(new Set([JSON.stringify(['ambion/pi-session', 'room/child'])]));
	});

	it('appends messages and custom entries through the transcript verbs', async () => {
		const journals = open();
		const session = await piSessions(journals).open('verbs');
		await session.appendCustomEntry('audit/activation', { seat: 'product' });
		await session.appendMessage({ role: 'user', content: 'a turn', timestamp: 1 });
		const reopened = await piSessions(journals).open('verbs');
		const entries = await reopened.findEntries({ order: 'oldestFirst' });
		expect(entries.map((entry) => entry.type)).toEqual(['custom', 'message']);
		expect(entries.map((entry) => entry.seq)).toEqual([1, 2]);
		expect(entries[1]?.parentId).toBe(entries[0]?.id);
	});

	it('retries concurrent compare-and-append writes without corrupting parents', async () => {
		const sessions = piSessions(open());
		const [left, right] = await Promise.all([sessions.open('race'), sessions.open('race')]);
		const [one, two] = await Promise.all([
			left.appendEntry(custom('left', { writer: 'left' }), 'main'),
			right.appendEntry(custom('right', { writer: 'right' }), 'main'),
		]);
		const entries = await (await sessions.open('race')).findEntries({ order: 'oldestFirst' });
		expect(entries.map((entry) => entry.id).sort()).toEqual(['left', 'right']);
		expect(entries.map((entry) => entry.seq)).toEqual([1, 2]);
		expect(entries[0]?.parentId).toBeNull();
		expect(entries[1]?.parentId).toBe(entries[0]?.id);
		expect([one.parentId, two.parentId].filter((parent) => parent === null)).toHaveLength(1);
	});

	it('recovers a lost append confirmation with one stable entry id', async () => {
		const journals = open();
		let loseConfirmation = true;
		const uncertain = wrapped(journals, (storage) => ({
			async append(entry, expected) {
				const landed = await storage.append(entry, expected);
				if (loseConfirmation && landed !== undefined && isEntryWrite(entry)) {
					loseConfirmation = false;
					throw new Error('confirmation lost');
				}
				return landed;
			},
		}));
		const session = await piSessions(uncertain).open('lost');
		const entry = await session.appendEntry(custom('stable-id', { value: 'once' }), 'main');
		expect(entry.id).toBe('stable-id');
		const reread = await piSessions(journals).open('lost');
		expect(await reread.findEntries({ order: 'oldestFirst' })).toMatchObject([
			{ id: 'stable-id', seq: 1, parentId: null, data: { value: 'once' } },
		]);
	});

	it('rejects a duplicate entry id before it writes', async () => {
		const journals = open();
		const session = await piSessions(journals).open('id-collision');
		await session.appendEntry(custom('shared-id', { first: true }), 'main');
		const storage = await journals.open(JSON.stringify(['ambion/pi-session', 'id-collision']));
		const before = await storage.read(0);
		await expect(
			session.appendEntry(custom('shared-id', { poisoned: true }), 'main'),
		).rejects.toThrow(/already exists/);
		expect(await storage.read(0)).toEqual(before);
	});

	it('stores an entry snapshot from the append call', async () => {
		const journals = open();
		const held = gate();
		let holdNextRead = false;
		const delayed = wrapped(journals, (storage) => ({
			async read(after) {
				if (holdNextRead) await held.opened;
				return storage.read(after);
			},
		}));
		const session = await piSessions(delayed).open('snapshot');
		holdNextRead = true;
		const payload = { value: 'at call' };
		const writing = session.appendEntry(custom('snapshot-entry', payload), 'main');
		payload.value = 'after call';
		held.open();
		await writing;
		const reread = await piSessions(journals).open('snapshot');
		expect(await reread.getEntry('snapshot-entry')).toMatchObject({ data: { value: 'at call' } });
	});

	it('does not cache a phantom entry after append and recovery both fail', async () => {
		let failRecoveryRead = false;
		let failAppend = true;
		const failing = wrapped(open(), (storage) => ({
			async read(after) {
				if (failRecoveryRead) {
					failRecoveryRead = false;
					throw new Error('recovery read failed');
				}
				return storage.read(after);
			},
			async append(entry, expected) {
				if (failAppend && isEntryWrite(entry)) {
					failAppend = false;
					failRecoveryRead = true;
					throw new Error('append failed');
				}
				return storage.append(entry, expected);
			},
		}));
		const session = await piSessions(failing).open('failed-write');
		await expect(
			session.appendEntry(custom('phantom', { value: 'never' }), 'main'),
		).rejects.toThrow(/append failed/);
		const landed = await session.appendEntry(custom('real', { value: 'once' }), 'main');
		expect(landed).toMatchObject({ id: 'real', seq: 1, parentId: null });
		expect(await session.findEntries({ order: 'oldestFirst' })).toMatchObject([{ id: 'real' }]);
	});

	it('keeps one projection when a reader races an append confirmation', async () => {
		const held = gate();
		const landed = gate();
		const delayed = wrapped(open(), (storage) => ({
			async append(entry, expected) {
				const stored = await storage.append(entry, expected);
				if (stored !== undefined && isEntryWrite(entry)) {
					landed.open();
					await held.opened;
				}
				return stored;
			},
		}));
		const session = await piSessions(delayed).open('read-race');
		const writing = session.appendEntry(custom('only', { value: 1 }), 'main');
		await landed.opened;
		const reading = session.findEntries({ order: 'oldestFirst' });
		held.open();
		expect(await writing).toMatchObject({ id: 'only', seq: 1 });
		expect(await reading).toMatchObject([{ id: 'only', seq: 1 }]);
		expect(await session.findEntries({ order: 'oldestFirst' })).toMatchObject([
			{ id: 'only', seq: 1 },
		]);
	});
});
