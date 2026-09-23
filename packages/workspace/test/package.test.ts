/**
 * The package's six entries, and what each one names. `index.ts` opens a
 * resource and its logs, over no backend. `./resource`, `./sql`,
 * `./sqlite`, and `./just-bash` each hold one binding. `./conformance`
 * holds the cases every `BashBackend` and every `SqlBackend` must pass.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import * as conformance from '../src/conformance.ts';
import * as main from '../src/index.ts';
import { PACKAGE_NAME } from '../src/index.ts';
import * as justBash from '../src/just-bash-entry.ts';
import * as resource from '../src/resource-entry.ts';
import * as sql from '../src/sql-resource.ts';
import * as sqlite from '../src/sqlite-entry.ts';

const read = async (name: string) =>
	readFile(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');

const manifest = async () =>
	JSON.parse(await read('package.json')) as {
		name: string;
		exports: Record<string, { import?: string } | string>;
	};

/** The built file's stem for one exports subpath. */
const STEMS: Record<string, string> = {
	'.': 'index',
	'./resource': 'resource-entry',
	'./sql': 'sql-resource',
	'./sqlite': 'sqlite-entry',
	'./just-bash': 'just-bash-entry',
	'./conformance': 'conformance',
};

it('keeps the exported package name in step with the manifest', async () => {
	expect(PACKAGE_NAME).toBe((await manifest()).name);
});

it('builds every entry the manifest names', async () => {
	const { exports } = await manifest();
	const config = await read('tsdown.config.ts');
	const built = [...config.matchAll(/'(src\/[^']+)'/g)].map((m) => m[1]);
	expect(built).toEqual([
		'src/index.ts',
		'src/resource-entry.ts',
		'src/sql-resource.ts',
		'src/sqlite-entry.ts',
		'src/just-bash-entry.ts',
		'src/conformance.ts',
	]);
	// Each subpath names a file the build writes, under the name it builds it by.
	for (const [path, target] of Object.entries(exports)) {
		if (path === './package.json') continue;
		const file = typeof target === 'string' ? target : target.import;
		const stem = STEMS[path];
		expect(stem).toBeDefined();
		expect(file).toBe(`./dist/${stem}.mjs`);
		expect(built).toContain(`src/${stem}.ts`);
	}
});

it('holds exactly six entries: the root, one per binding, and the conformance suite', async () => {
	const { exports } = await manifest();
	expect(Object.keys(exports).sort()).toEqual([
		'.',
		'./conformance',
		'./just-bash',
		'./package.json',
		'./resource',
		'./sql',
		'./sqlite',
	]);
});

it('exports one resource, its two logs, the environment helpers, and sqlResult from the root, and no backend', () => {
	expect(Object.keys(main).sort()).toEqual([
		'BACKGROUND_CONTEXT',
		'DEFAULT_AUDIT_LOG',
		'Deadline',
		'PACKAGE_NAME',
		'TMP',
		'boundedView',
		'openAuditLog',
		'openLog',
		'openWorkspace',
		'randomName',
		'resolvePath',
		'spill',
		'spillPath',
		'sqlResult',
		'tempDirPath',
		'tempFilePath',
	]);
});

it('exports exactly the neutral resource contract from ./resource', () => {
	expect(Object.keys(resource).sort()).toEqual(['openResource']);
});

it('exports exactly the SQL resource from ./sql', () => {
	expect(Object.keys(sql).sort()).toEqual(['PROVENANCE_COLUMNS', 'openSqlResource']);
});

it('exports exactly the SQLite backend from ./sqlite', () => {
	expect(Object.keys(sqlite).sort()).toEqual(['sqliteBackend']);
});

it('exports exactly the just-bash backends from ./just-bash', () => {
	expect(Object.keys(justBash).sort()).toEqual(['directoryBackend', 'memoryBackend']);
});

it('exports exactly the two conformance suites from ./conformance', () => {
	expect(Object.keys(conformance).sort()).toEqual(['sqlConformance', 'workspaceConformance']);
});

it('loads no backend at the root: no export from the just-bash, resource, or SQL files', async () => {
	const index = await read('src/index.ts');
	expect(index).not.toMatch(/from '\.\/just-bash\.ts'/);
	expect(index).not.toMatch(/from '\.\/resource\.ts'/);
	expect(index).not.toMatch(/from '\.\/sql-resource\.ts'/);
	expect(index).not.toMatch(/from '\.\/sqlite(-entry)?\.ts'/);
	expect(index).not.toMatch(/ROOM_MIRROR_GUIDANCE|roomMirrorPath|DEFAULT_ROTATE_BYTES/);
});

/** The specifiers one built file imports, whatever the quote or the form. */
const importsOf = (code: string): string[] =>
	[...code.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '');

/** `specifier`, resolved against the chunk that imports it, as a dist-relative path. */
function resolveChunk(from: string, specifier: string): string {
	const parts = from.split('/').slice(0, -1).concat(specifier.split('/'));
	const resolved: string[] = [];
	for (const part of parts) {
		if (part === '.' || part === '') continue;
		if (part === '..') resolved.pop();
		else resolved.push(part);
	}
	return resolved.join('/');
}

/** Every dist chunk `entry` reaches, transitively, following relative imports alone. */
async function chunksOf(distDir: URL, entry: string): Promise<Map<string, string[]>> {
	const chunks = new Map<string, string[]>();
	const queue = [entry];
	while (queue.length > 0) {
		const file = queue.shift();
		if (file === undefined || chunks.has(file)) continue;
		const code = await readFile(new URL(file, distDir), 'utf8');
		const specifiers = importsOf(code);
		chunks.set(file, specifiers);
		for (const specifier of specifiers) {
			if (specifier.startsWith('.')) queue.push(resolveChunk(file, specifier));
		}
	}
	return chunks;
}

const isBanned = (specifier: string): boolean =>
	specifier === 'just-bash' || specifier === 'node:sqlite';

it('keeps just-bash and node:sqlite out of the root build, across every chunk it imports', async () => {
	const distDir = new URL('../dist/', import.meta.url);
	const chunks = await chunksOf(distDir, 'index.mjs');
	expect(chunks.size).toBeGreaterThan(0);
	for (const [file, specifiers] of chunks) {
		expect({ file, banned: specifiers.filter(isBanned) }).toEqual({ file, banned: [] });
	}
});

it('keeps just-bash and vitest out of the conformance build, across every chunk it imports', async () => {
	const distDir = new URL('../dist/', import.meta.url);
	const chunks = await chunksOf(distDir, 'conformance.mjs');
	expect(chunks.size).toBeGreaterThan(0);
	const bannedHere = (specifier: string) => isBanned(specifier) || specifier === 'vitest';
	for (const [file, specifiers] of chunks) {
		expect({ file, banned: specifiers.filter(bannedHere) }).toEqual({ file, banned: [] });
	}
});
