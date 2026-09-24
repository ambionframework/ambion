/**
 * The package's two entries, and what each one names. The root holds the
 * two backends, their option and handle types, and the package name.
 * `./git` holds the git backend and its storage. The root build loads no
 * `node:sqlite`: only the git build does.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import * as git from '../src/git/index.ts';
import * as main from '../src/index.ts';

const manifest = async () =>
	JSON.parse(
		await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
	) as {
		name: string;
		exports: Record<string, { import?: string } | string>;
	};

it('keeps the exported package name in step with the manifest', async () => {
	expect(main.PACKAGE_NAME).toBe((await manifest()).name);
});

it('holds two entries, and builds each under the name the manifest gives it', async () => {
	const { exports } = await manifest();
	expect(Object.keys(exports).sort()).toEqual(['.', './git', './package.json']);
	expect(exports['.']).toMatchObject({ import: './dist/index.mjs' });
	expect(exports['./git']).toMatchObject({ import: './dist/git/index.mjs' });
});

it.each([
	['.', main, ['PACKAGE_NAME', 'directoryBackend', 'memoryBackend']],
	['./git', git, ['justGitBackend', 'sqliteGitStorage']],
])('exports exactly its bindings from %s', (_path, entry, names) => {
	expect(Object.keys(entry).sort()).toEqual(names);
});

/** The specifiers one built file imports, whatever the quote or the form. */
const importsOf = (code: string): string[] =>
	[...code.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '');

/** `specifier`, resolved against the chunk that imports it, as a dist-relative path. */
function resolveChunk(from: string, specifier: string): string {
	const resolved: string[] = [];
	for (const part of from.split('/').slice(0, -1).concat(specifier.split('/'))) {
		if (part === '.' || part === '') continue;
		if (part === '..') resolved.pop();
		else resolved.push(part);
	}
	return resolved.join('/');
}

/** Every specifier that `entry` and the dist chunks it reaches import, following relative imports. */
async function importsFrom(entry: string): Promise<Set<string>> {
	const dist = new URL('../dist/', import.meta.url);
	const seen = new Set<string>();
	const found = new Set<string>();
	const queue = [entry];
	for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
		if (seen.has(file)) continue;
		seen.add(file);
		for (const specifier of importsOf(await readFile(new URL(file, dist), 'utf8'))) {
			found.add(specifier);
			if (specifier.startsWith('.')) queue.push(resolveChunk(file, specifier));
		}
	}
	return found;
}

it.each([
	['root', 'index.mjs', false],
	['git', 'git/index.mjs', true],
])('loads node:sqlite from the %s build: %s', async (_name, entry, loads) => {
	const imports = await importsFrom(entry);
	expect(imports.size).toBeGreaterThan(0);
	expect(imports.has('node:sqlite')).toBe(loads);
});
