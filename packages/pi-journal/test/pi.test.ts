/** Pi transcript audits preserve their ordered record over named Ambion journals. */
import { DatabaseSync } from 'node:sqlite';
import {
	type JournalOpener,
	type JournalStorage,
	memoryJournals,
	type Sql,
	type SqlValue,
	sqliteJournals,
} from '@ambionframework/journal';
import type { JsonValue } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { piSessions } from '../src/index.ts';

const sqlOver = (database: DatabaseSync): Sql => ({
	run: (query, ...params) => {
		database.prepare(query).run(...params);
	},
	all: (query, ...params) => database.prepare(query).all(...params) as Record<string, SqlValue>[],
});

interface Backend {
	readonly journals: JournalOpener;
	dispose(): void;
}

const backends: readonly { name: string; open(): Backend }[] = [
	{ name: 'memory', open: () => ({ journals: memoryJournals(), dispose: () => {} }) },
	{
		name: 'SQLite',
		open: () => {
			const database = new DatabaseSync(':memory:');
			return { journals: sqliteJournals(sqlOver(database)), dispose: () => database.close() };
		},
	},
];

const custom = (id: string, data: JsonValue) => ({
	id,
	type: 'custom' as const,
	customType: 'audit',
	data,
});

describe.each(backends)('Pi transcript audits over $name journals', ({ open }) => {
	it('preserves the ordered record across newly opened facades', async () => {
		const backend = open();
		try {
			const first = await piSessions(backend.journals).open('child', 'parent');
			const root = await first.appendEntry(custom('root', { message: 'root' }), 'main');
			const branch = await first.appendEntry(custom('branch', { message: 'branch' }), 'main');

			const second = await piSessions(backend.journals).open('child');
			expect(await second.getMetadata()).toMatchObject({ id: 'child', parentSessionId: 'parent' });
			expect(await second.findEntries({ customType: 'audit', order: 'oldestFirst' })).toMatchObject(
				[
					{ id: root.id, parentId: null, seq: 1, data: { message: 'root' } },
					{ id: branch.id, parentId: root.id, seq: 2, data: { message: 'branch' } },
				],
			);
			expect(await second.findEntries({ order: 'newestFirst', limit: 1 })).toMatchObject([
				{ id: branch.id, seq: 2 },
			]);
			expect(await second.getEntry(root.id)).toMatchObject({ id: root.id, seq: 1 });
		} finally {
			backend.dispose();
		}
	});

	it('appends messages and custom entries through the transcript verbs', async () => {
		const backend = open();
		try {
			const session = await piSessions(backend.journals).open('verbs');
			await session.appendCustomEntry('audit/activation', { seat: 'product' });
			await session.appendMessage({ role: 'user', content: 'a turn', timestamp: 1 });
			const again = await piSessions(backend.journals).open('verbs');
			const entries = await again.findEntries({ order: 'oldestFirst' });
			expect(entries.map((entry) => entry.type)).toEqual(['custom', 'message']);
			expect(entries.map((entry) => entry.seq)).toEqual([1, 2]);
			expect(entries[1]?.parentId).toBe(entries[0]?.id);
		} finally {
			backend.dispose();
		}
	});

	it('retries concurrent compare-and-append writes without corrupting parents', async () => {
		const backend = open();
		try {
			const sessions = piSessions(backend.journals);
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
		} finally {
			backend.dispose();
		}
	});

	it('recovers a lost append confirmation with one stable entry id', async () => {
		const backend = open();
		try {
			let loseConfirmation = true;
			const uncertain: JournalOpener = {
				async open(name): Promise<JournalStorage> {
					const storage = await backend.journals.open(name);
					return {
						read: storage.read.bind(storage),
						async append(entry, expected) {
							const landed = await storage.append(entry, expected);
							if (
								loseConfirmation &&
								landed !== undefined &&
								typeof entry === 'object' &&
								entry !== null &&
								'kind' in entry &&
								entry.kind === 'entry'
							) {
								loseConfirmation = false;
								throw new Error('confirmation lost');
							}
							return landed;
						},
					};
				},
			};
			const session = await piSessions(uncertain).open('lost');
			const entry = await session.appendEntry(custom('stable-id', { value: 'once' }), 'main');
			expect(entry.id).toBe('stable-id');
			const reread = await piSessions(backend.journals).open('lost');
			expect(await reread.findEntries({ order: 'oldestFirst' })).toMatchObject([
				{ id: 'stable-id', seq: 1, parentId: null, data: { value: 'once' } },
			]);
		} finally {
			backend.dispose();
		}
	});

	it('rejects a duplicate entry id before it writes', async () => {
		const backend = open();
		try {
			const session = await piSessions(backend.journals).open('id-collision');
			await session.appendEntry(custom('shared-id', { first: true }), 'main');
			const storage = await backend.journals.open(
				JSON.stringify(['ambion/pi-session', 'id-collision']),
			);
			const before = await storage.read(0);
			await expect(
				session.appendEntry(custom('shared-id', { poisoned: true }), 'main'),
			).rejects.toThrow(/already exists/);
			expect(await storage.read(0)).toEqual(before);
		} finally {
			backend.dispose();
		}
	});

	it('stores an entry snapshot from the append call', async () => {
		const backend = open();
		try {
			let releaseRead: (() => void) | undefined;
			const held = new Promise<void>((resolve) => {
				releaseRead = resolve;
			});
			let holdNextRead = false;
			const delayed: JournalOpener = {
				async open(name) {
					const storage = await backend.journals.open(name);
					return {
						async read(after) {
							if (holdNextRead) await held;
							return storage.read(after);
						},
						append: storage.append.bind(storage),
					};
				},
			};
			const session = await piSessions(delayed).open('snapshot');
			holdNextRead = true;
			const payload = { value: 'at call' };
			const writing = session.appendEntry(custom('snapshot-entry', payload), 'main');
			payload.value = 'after call';
			releaseRead?.();
			await writing;
			const reread = await piSessions(backend.journals).open('snapshot');
			expect(await reread.getEntry('snapshot-entry')).toMatchObject({ data: { value: 'at call' } });
		} finally {
			backend.dispose();
		}
	});

	it('does not cache a phantom entry after append and recovery both fail', async () => {
		const backend = open();
		try {
			let failRecoveryRead = false;
			let failAppend = true;
			const failing: JournalOpener = {
				async open(name) {
					const storage = await backend.journals.open(name);
					return {
						async read(after) {
							if (failRecoveryRead) {
								failRecoveryRead = false;
								throw new Error('recovery read failed');
							}
							return storage.read(after);
						},
						async append(entry, expected) {
							if (
								failAppend &&
								typeof entry === 'object' &&
								entry !== null &&
								'kind' in entry &&
								entry.kind === 'entry'
							) {
								failAppend = false;
								failRecoveryRead = true;
								throw new Error('append failed');
							}
							return storage.append(entry, expected);
						},
					};
				},
			};
			const session = await piSessions(failing).open('failed-write');
			await expect(
				session.appendEntry(custom('phantom', { value: 'never' }), 'main'),
			).rejects.toThrow(/append failed/);
			const landed = await session.appendEntry(custom('real', { value: 'once' }), 'main');
			expect(landed).toMatchObject({ id: 'real', seq: 1, parentId: null });
			expect(await session.findEntries({ order: 'oldestFirst' })).toMatchObject([{ id: 'real' }]);
		} finally {
			backend.dispose();
		}
	});

	it('keeps one projection when a reader races an append confirmation', async () => {
		const backend = open();
		try {
			let releaseAppend: (() => void) | undefined;
			const heldAppend = new Promise<void>((resolve) => {
				releaseAppend = resolve;
			});
			let landedEntry: (() => void) | undefined;
			const landed = new Promise<void>((resolve) => {
				landedEntry = resolve;
			});
			const delayed: JournalOpener = {
				async open(name) {
					const storage = await backend.journals.open(name);
					return {
						read: storage.read.bind(storage),
						async append(entry, expected) {
							const stored = await storage.append(entry, expected);
							if (
								stored !== undefined &&
								typeof entry === 'object' &&
								entry !== null &&
								'kind' in entry &&
								entry.kind === 'entry'
							) {
								landedEntry?.();
								await heldAppend;
							}
							return stored;
						},
					};
				},
			};
			const session = await piSessions(delayed).open('read-race');
			const writing = session.appendEntry(custom('only', { value: 1 }), 'main');
			await landed;
			const reading = session.findEntries({ order: 'oldestFirst' });
			releaseAppend?.();
			expect(await writing).toMatchObject({ id: 'only', seq: 1 });
			expect(await reading).toMatchObject([{ id: 'only', seq: 1 }]);
			expect(await session.findEntries({ order: 'oldestFirst' })).toMatchObject([
				{ id: 'only', seq: 1 },
			]);
		} finally {
			backend.dispose();
		}
	});
});

it('opens Pi transcripts under a collision-safe namespace', async () => {
	const names: string[] = [];
	const backing = memoryJournals();
	const journals: JournalOpener = {
		async open(name) {
			names.push(name);
			return backing.open(name);
		},
	};
	await piSessions(journals).open('room/a');
	expect(names).toEqual([JSON.stringify(['ambion/pi-session', 'room/a'])]);
});
