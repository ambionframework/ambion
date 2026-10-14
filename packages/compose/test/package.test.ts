import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import * as conformance from '../src/conformance.ts';
import * as main from '../src/index.ts';
import * as entry from '../src/runtime.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

/** The module specifiers that a file imports. */
const importsOf = (text: string) =>
	[...text.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]/gm)].map(
		(match) => match[1],
	);

it('exports the runtime, and holds the Node floor', () => {
	expect(Object.keys(entry).sort()).toEqual(['quickjsRuntime']);
	const manifest = JSON.parse(read('../package.json'));
	expect(manifest.engines.node).toBe('>=22.19.0');
});

it('exports the tool and the conformance suite', () => {
	expect(Object.keys(main).sort()).toEqual([
		'COMPOSE_GUIDANCE',
		'composeExtension',
		'composeMacro',
	]);
	expect(Object.keys(conformance)).toEqual(['composeRuntimeConformance']);
});

it('keeps the core external and QuickJS out of the main entry', () => {
	const imports = importsOf(read('../dist/index.mjs'));
	expect(imports).toContain('@ambionframework/ambion');
	expect(imports).not.toContain('quickjs-emscripten');
});

it('builds the runtime entry with QuickJS as its one import', () => {
	expect(importsOf(read('../dist/runtime.mjs'))).toEqual(['quickjs-emscripten']);
});
