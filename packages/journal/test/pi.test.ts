/** Pi sessions preserve their full public record over named Ambion journals. */
import { DatabaseSync } from 'node:sqlite';
import { InMemorySessionRepo } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { memoryJournals } from '../src/memory.ts';
import { piSessions } from '../src/pi.ts';
import { type Sql, type SqlValue, sqliteJournals } from '../src/sqlite.ts';
import type { JournalOpener, JournalStorage } from '../src/storage.ts';

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

const custom = (id: string, data: unknown) => ({
	id,
	type: 'custom' as const,
	customType: 'audit',
	data,
});

describe.each(backends)('Pi sessions over $name journals', ({ open }) => {
	it('preserves the public session record across newly opened facades', async () => {
		const backend = open();
		try {
			const first = await piSessions(backend.journals).open('child', 'parent');
			const root = await first.appendEntry(custom('root', { message: 'root' }), 'main');
			await first.createLane('review', root.id);
			const branch = await first.appendEntry(custom('branch', { message: 'branch' }), 'review');
			await first.moveLane('main', root.id);
			await first.appendRecord({
				id: 'operation',
				type: 'operation_started',
				lane: 'review',
				sourceLeafId: root.id,
				intent: { kind: 'run', originalPrompt: [], initialMessages: [] },
			});
			await first.setName('Review transcript');
			await first.setLabel(branch.id, 'keep');

			const second = await piSessions(backend.journals).open('child');
			expect(await second.getMetadata()).toMatchObject({ id: 'child', parentSessionId: 'parent' });
			expect(await second.getLanes()).toEqual([
				{ lane: 'main', leafId: root.id },
				{ lane: 'review', leafId: branch.id },
			]);
			expect(await second.findEntries({ customType: 'audit', order: 'oldestFirst' })).toMatchObject(
				[
					{ id: root.id, parentId: null, seq: 1, data: { message: 'root' } },
					{ id: branch.id, parentId: root.id, seq: 3, data: { message: 'branch' } },
				],
			);
			expect(
				await second.findEntriesOnBranch({ start: branch.id, order: 'oldestFirst' }),
			).toMatchObject([{ id: root.id }, { id: branch.id }]);
			expect(await second.findRecords({ type: 'operation_started', lane: 'review' })).toMatchObject(
				[{ id: 'operation', seq: 5, sourceLeafId: root.id }],
			);
			expect(await second.findOpenOperations('review')).toMatchObject([{ id: 'operation' }]);
			expect(await second.getName()).toBe('Review transcript');
			expect(await second.getLabel(branch.id)).toBe('keep');
			expect(await second.getStats()).toMatchObject({ messageCount: 0 });
			expect((await second.getLog()).map((item) => item.kind)).toEqual([
				'entry',
				'lane',
				'entry',
				'lane',
				'record',
				'fact',
				'fact',
			]);
		} finally {
			backend.dispose();
		}
	});

	it('replays message usage and finished operation records', async () => {
		const backend = open();
		try {
			const first = await piSessions(backend.journals).open('usage');
			const message = await first.appendEntry(
				{
					id: 'message',
					type: 'message',
					message: {
						role: 'custom',
						customType: 'test',
						content: 'hello',
						display: true,
						timestamp: 1,
					},
				},
				'main',
			);
			await first.appendRecord({
				id: 'run',
				type: 'operation_started',
				lane: 'main',
				sourceLeafId: message.id,
				intent: { kind: 'run', originalPrompt: [], initialMessages: [] },
			});
			await first.appendRecord({
				id: 'usage',
				type: 'usage',
				lane: 'main',
				cause: 'assistant',
				runId: 'run',
				entryId: message.id,
				attempt: 1,
				stopReason: 'stop',
				usage: {
					input: 3,
					output: 5,
					cacheRead: 2,
					cacheWrite: 1,
					totalTokens: 11,
					cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
				},
			});
			await first.appendRecord({
				id: 'finished',
				type: 'operation_finished',
				lane: 'main',
				runId: 'run',
				outcome: 'completed',
			});

			const second = await piSessions(backend.journals).open('usage');
			expect(await second.findOpenOperations('main')).toEqual([]);
			expect(await second.getStats()).toMatchObject({
				messageCount: 1,
				cachedTokens: 2,
				uncachedTokens: 4,
				totalTokens: 11,
				costTotal: 10,
			});
			expect(await second.findRecords({ type: 'usage', afterSeq: 2 })).toMatchObject([
				{ id: 'usage', runId: 'run' },
			]);
			expect((await second.getLog({ afterSeq: 1 })).map((item) => item.seq)).toEqual([2, 3, 4]);
		} finally {
			backend.dispose();
		}
	});

	it('retries concurrent compare-and-append writes without corrupting lane parents', async () => {
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

	it('rejects an entry id that already belongs to a record before it writes', async () => {
		const backend = open();
		try {
			const sessions = piSessions(backend.journals);
			const session = await sessions.open('id-collision');
			await session.appendRecord({
				id: 'shared-id',
				type: 'operation_started',
				lane: 'main',
				sourceLeafId: null,
				intent: { kind: 'run', originalPrompt: [], initialMessages: [] },
			});
			const storage = await backend.journals.open(
				JSON.stringify(['ambion/pi-session', 'id-collision']),
			);
			const before = await storage.read(0);
			await expect(
				session.appendEntry(custom('shared-id', { poisoned: true }), 'main'),
			).rejects.toThrow(/duplicate id/);
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

	it('persists clearing names and labels across facades', async () => {
		const backend = open();
		try {
			const session = await piSessions(backend.journals).open('cleared');
			const entry = await session.appendEntry(custom('labelled', { value: true }), 'main');
			await session.setName('temporary');
			await session.setLabel(entry.id, 'temporary');
			await session.setName(undefined);
			await session.setLabel(entry.id, undefined);
			const reread = await piSessions(backend.journals).open('cleared');
			expect(await reread.getName()).toBeUndefined();
			expect(await reread.getLabel(entry.id)).toBeUndefined();
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

it('matches Pi memory session query and branch semantics', async () => {
	const reference = await new InMemorySessionRepo().create({ id: 'reference' });
	const actual = await piSessions(memoryJournals()).open('actual');
	for (const session of [reference, actual]) {
		await session.appendEntry(custom('root', { value: 0 }), 'main');
		await session.appendEntry({ ...custom('middle', { value: 1 }), customType: 'keep' }, 'main');
		await session.appendEntry({ ...custom('leaf', { value: 2 }), customType: 'skip' }, 'main');
	}
	const entryIds = (entries: readonly { id: string }[]) => entries.map((entry) => entry.id);
	const options = { customType: 'keep', order: 'oldestFirst' as const };
	expect(entryIds(await actual.findEntries(options))).toEqual(
		entryIds(await reference.findEntries(options)),
	);
	const branch = { start: 'leaf', stopAtId: 'middle', order: 'oldestFirst' as const };
	expect(entryIds(await actual.findEntriesOnBranch(branch))).toEqual(
		entryIds(await reference.findEntriesOnBranch(branch)),
	);
});
