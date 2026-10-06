import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import * as entry from '../src/index.ts';

it('exports the lifecycle, the two stores, and the name limit, and names the package as package.json does', () => {
	expect(Object.keys(entry).sort()).toEqual([
		'NAME_LIMIT',
		'PACKAGE_NAME',
		'memoryCanvas',
		'openCanvas',
		'sqliteCanvas',
	]);
	const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
	expect(entry.PACKAGE_NAME).toBe(manifest.name);
});
