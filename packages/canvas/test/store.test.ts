import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sqliteJournals } from '@ambionframework/journal';
import { describe, expect, it } from 'vitest';
import { type CanvasStoreFixture, canvasStoreConformance } from '../src/conformance.ts';
import { memoryCanvas, sqliteCanvas } from '../src/index.ts';
import { sqlOver } from './support/sql.ts';

const fixtures: readonly CanvasStoreFixture[] = [
	{ name: 'memory', open: () => ({ store: memoryCanvas() }) },
	{
		name: 'native SQLite',
		open: () => {
			const database = new DatabaseSync(':memory:');
			return { store: sqliteCanvas(sqlOver(database)), dispose: () => database.close() };
		},
	},
];

describe.each(fixtures)('$name CanvasStore', (fixture) => {
	for (const c of canvasStoreConformance(fixture)) it(c.name, c.run);
});

describe('sqliteCanvas', () => {
	it('keeps its rows across a reopen of the database file, beside the journals', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'canvas-'));
		try {
			const file = join(dir, 'canvas.db');
			const first = new DatabaseSync(file);
			const row = {
				name: 'site',
				goal: 'Plan.',
				depth: 0,
				state: 'running',
				start: { kind: 'root', agents: ['ada'] },
			} as const;
			const store = sqliteCanvas(sqlOver(first));
			sqliteJournals(sqlOver(first));
			await store.insert(row);
			await store.archive('site', { result: 'done' });
			first.close();
			const second = new DatabaseSync(file);
			const reopened = sqliteCanvas(sqlOver(second));
			expect(await reopened.list()).toEqual([
				{ ...row, state: 'archived', close: { result: 'done' } },
			]);
			second.close();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
