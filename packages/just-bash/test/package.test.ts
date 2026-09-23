/**
 * The package's one entry, and what it names: the two backends, their
 * option and handle types, and the package name.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import * as main from '../src/index.ts';

const manifest = async () =>
	JSON.parse(
		await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
	) as {
		name: string;
		exports: Record<string, unknown>;
	};

it('keeps the exported package name in step with the manifest', async () => {
	expect(main.PACKAGE_NAME).toBe((await manifest()).name);
});

it('holds one entry', async () => {
	expect(Object.keys((await manifest()).exports).sort()).toEqual(['.', './package.json']);
});

it('exports the two backends and the package name', () => {
	expect(Object.keys(main).sort()).toEqual(['PACKAGE_NAME', 'directoryBackend', 'memoryBackend']);
});
