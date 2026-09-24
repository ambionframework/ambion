/**
 * The package's five entries, and what each one names. `index.ts` opens a
 * resource and its logs, over no backend. `./resource`, `./sql`, and
 * `./sqlite` each hold one binding. `./conformance` holds the cases every
 * `BashBackend` and every `SqlBackend` must pass. No entry loads just-bash:
 * the just-bash backends are the package `@ambionframework/just-bash`.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import * as conformance from '../src/conformance.ts';
import * as main from '../src/index.ts';
import { PACKAGE_NAME } from '../src/index.ts';
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
	'./conformance': 'conformance',
};

it('holds exactly five entries, builds each under the name the manifest gives it, and keeps the package name in step', async () => {
	const { name, exports } = await manifest();
	expect(PACKAGE_NAME).toBe(name);
	expect(Object.keys(exports).sort()).toEqual([
		'.',
		'./conformance',
		'./package.json',
		'./resource',
		'./sql',
		'./sqlite',
	]);
	const config = await read('tsdown.config.ts');
	const built = [...config.matchAll(/'(src\/[^']+)'/g)].map((m) => m[1]);
	expect(built).toEqual([
		'src/index.ts',
		'src/resource-entry.ts',
		'src/sql-resource.ts',
		'src/sqlite-entry.ts',
		'src/conformance.ts',
	]);
	for (const [path, target] of Object.entries(exports)) {
		if (path === './package.json') continue;
		const stem = STEMS[path];
		expect(stem).toBeDefined();
		expect(typeof target === 'string' ? target : target.import).toBe(`./dist/${stem}.mjs`);
		expect(built).toContain(`src/${stem}.ts`);
	}
});

it('exports one resource, its two logs, the environment helpers, and sqlResult from the root, and no backend', () => {
	expect(Object.keys(main).sort()).toEqual([
		'BACKGROUND_CONTEXT',
		'DEFAULT_AUDIT_LOG',
		'DEFAULT_TIMEOUT_SECONDS',
		'Deadline',
		'HomeEnv',
		'PACKAGE_NAME',
		'TMP',
		'boundedView',
		'deliverView',
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
		'withDeadline',
	]);
});

it.each([
	['./resource', resource, ['openResource']],
	['./sql', sql, ['PROVENANCE_COLUMNS', 'openSqlResource']],
	['./sqlite', sqlite, ['sqliteBackend']],
	['./conformance', conformance, ['gitConformance', 'sqlConformance', 'workspaceConformance']],
])('exports exactly its one binding from %s', (_path, entry, names) => {
	expect(Object.keys(entry).sort()).toEqual(names);
});

it('loads no backend at the root: no export from the resource or SQL files', async () => {
	const index = await read('src/index.ts');
	expect(index).not.toMatch(/from '\.\/resource\.ts'/);
	expect(index).not.toMatch(/from '\.\/sql-resource\.ts'/);
	expect(index).not.toMatch(/from '\.\/sqlite(-entry)?\.ts'/);
	expect(index).not.toMatch(/ROOM_MIRROR_GUIDANCE|roomMirrorPath|DEFAULT_ROTATE_BYTES/);
});

it('keeps the neutral resource contract free of imports, Pi among them', async () => {
	const contract = await read('src/resource.ts');
	expect(contract).not.toMatch(/@earendil-works\/pi/);
	expect(contract).not.toMatch(/^import /m);
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

it.each([
	['root', 'index.mjs', ['just-bash', 'node:sqlite']],
	['resource', 'resource-entry.mjs', ['just-bash']],
	['sql', 'sql-resource.mjs', ['just-bash']],
	['sqlite', 'sqlite-entry.mjs', ['just-bash']],
	['conformance', 'conformance.mjs', ['just-bash', 'node:sqlite', 'vitest']],
])('keeps the %s build, and every chunk it imports, free of %j', async (_name, entry, banned) => {
	const chunks = await chunksOf(new URL('../dist/', import.meta.url), entry);
	expect(chunks.size).toBeGreaterThan(0);
	for (const [file, specifiers] of chunks) {
		expect({ file, banned: specifiers.filter((s) => banned.includes(s)) }).toEqual({
			file,
			banned: [],
		});
	}
});
