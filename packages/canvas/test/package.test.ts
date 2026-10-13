import { expect, it } from 'vitest';
import * as entry from '../src/index.ts';

it('exports the lifecycle, the two stores, and the name limit', () => {
	expect(Object.keys(entry).sort()).toEqual([
		'NAME_LIMIT',
		'memoryCanvas',
		'openCanvas',
		'sqliteCanvas',
	]);
});
