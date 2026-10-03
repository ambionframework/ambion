import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import * as entry from '../src/runtime.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

/** The module specifiers that a file imports. */
const importsOf = (text: string) =>
	[...text.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]/gm)].map(
		(match) => match[1],
	);

it('exports the two evaluators, and names the package as package.json does', () => {
	expect(Object.keys(entry).sort()).toEqual([
		'PACKAGE_NAME',
		'processEvaluator',
		'quickjsEvaluator',
	]);
	const manifest = JSON.parse(read('../package.json'));
	expect(entry.PACKAGE_NAME).toBe(manifest.name);
	expect(manifest.engines.node).toBe('>=22.19.0');
});

it('keeps the child entry free of any import but node: built-ins, built and in source', () => {
	// The child runs under --permission with no allow flag: Node loads its entry file and no other.
	expect(importsOf(read('../dist/child.mjs'))).toEqual(['node:readline', 'node:vm']);
	expect(importsOf(read('../src/child.ts')).filter((name) => !name?.startsWith('node:'))).toEqual([
		'./guest.ts',
	]);
});

it('builds the library with one entry that imports the child by path only', () => {
	expect(importsOf(read('../dist/runtime.mjs')).sort()).toEqual([
		'node:child_process',
		'node:readline',
		'node:url',
		'quickjs-emscripten',
	]);
});
