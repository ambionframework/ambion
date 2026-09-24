/**
 * The package's one entry, and what it names: the backend, its storage, the
 * template source, their types, and the package name.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import * as main from '../src/index.ts';

const manifest = async () =>
	JSON.parse(
		await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
	) as { name: string; exports: Record<string, unknown> };

it('keeps the exported package name in step with the manifest, and holds one entry', async () => {
	const { name, exports } = await manifest();
	expect(main.PACKAGE_NAME).toBe(name);
	expect(Object.keys(exports).sort()).toEqual(['.', './package.json']);
});

it('exports the backend, its storage, the template source, and the package name', () => {
	expect(Object.keys(main).sort()).toEqual([
		'PACKAGE_NAME',
		'fromDirectory',
		'gitBackend',
		'sqliteGitStorage',
	]);
});
