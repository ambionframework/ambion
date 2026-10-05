import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import * as entry from '../src/index.ts';

it('exports the two stores, and names the package as package.json does', () => {
	expect(Object.keys(entry).sort()).toEqual(['PACKAGE_NAME', 'memoryCanvas', 'sqliteCanvas']);
	const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
	expect(entry.PACKAGE_NAME).toBe(manifest.name);
});
