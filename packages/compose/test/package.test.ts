import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import * as entry from '../src/runtime.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

/** The module specifiers that a file imports. */
const importsOf = (text: string) =>
	[...text.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]/gm)].map(
		(match) => match[1],
	);

it('exports the runtime, and holds the Node floor', () => {
	expect(Object.keys(entry).sort()).toEqual(['PACKAGE_NAME', 'quickjsRuntime']);
	const manifest = JSON.parse(read('../package.json'));
	expect(manifest.engines.node).toBe('>=22.19.0');
});

it('builds the library with one entry that imports QuickJS and nothing else', () => {
	expect(importsOf(read('../dist/runtime.mjs'))).toEqual(['quickjs-emscripten']);
});
