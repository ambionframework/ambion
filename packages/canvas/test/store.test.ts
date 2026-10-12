import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'vitest';
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
