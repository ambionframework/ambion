/**
 * No cycle of value imports in `packages/*\/src` and `examples/*\/src`.
 *
 * A cycle of value imports makes a module read another module before it
 * runs. A type import vanishes at build time, so a cycle of type imports is
 * allowed. The test reads the relative static imports and re-exports of each
 * source file, drops the type-only ones, and searches the graph for a cycle.
 */
import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const STATEMENT =
	/(?:^|[;\s])(import|export)(\s+type\b)?\s*([^'";]*?)\s*(?:\bfrom\s*)?(['"])(\.{1,2}\/[^'"]*)\4/g;

/** Whether a specifier list names only `type` specifiers. */
function onlyTypes(clause) {
	const list = /^\{([^}]*)\}$/.exec(clause);
	if (!list) return false;
	const items = list[1]
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);
	return items.length > 0 && items.every((item) => /^type\s/.test(item));
}

/** The relative specifiers that a source text loads as values. */
function valueImports(text) {
	const found = [];
	const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
	for (const [, kind, typeKeyword, clause, , specifier] of code.matchAll(STATEMENT)) {
		const bare = kind === 'import' && clause === '';
		if (typeKeyword || clause.startsWith('(')) continue;
		if (!bare && onlyTypes(clause)) continue;
		found.push(specifier);
	}
	return found;
}

/** The module that a specifier names, among the known module paths. */
function resolve(from, specifier, known) {
	const base = normalize(join(dirname(from), specifier));
	const candidates = [
		base,
		base.replace(/\.js$/, '.ts'),
		base.replace(/\.js$/, '.tsx'),
		`${base}.ts`,
		join(base, 'index.ts'),
	];
	return candidates.find((candidate) => known.has(candidate));
}

/** A map from each module path to the modules that it loads as values. */
function buildGraph(files) {
	const known = new Set(Object.keys(files));
	const graph = new Map();
	for (const [path, text] of Object.entries(files)) {
		const targets = valueImports(text).map((item) => resolve(path, item, known));
		graph.set(path, [...new Set(targets.filter(Boolean))]);
	}
	return graph;
}

/** Every cycle of the graph, as a list of paths that ends where it starts. */
function findCycles(graph) {
	const cycles = [];
	const state = new Map();
	const walk = (node, stack) => {
		state.set(node, 'open');
		stack.push(node);
		for (const next of graph.get(node) ?? []) {
			if (state.get(next) === 'open') cycles.push([...stack.slice(stack.indexOf(next)), next]);
			else if (!state.has(next)) walk(next, stack);
		}
		stack.pop();
		state.set(node, 'done');
	};
	for (const node of graph.keys()) if (!state.has(node)) walk(node, []);
	return cycles;
}

function sourcePaths(dir) {
	const found = [];
	for (const name of readdirSync(dir)) {
		if (name === 'node_modules' || name === 'dist') continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) found.push(...sourcePaths(path));
		else if (SOURCE.test(name)) found.push(path);
	}
	return found;
}

function repositoryFiles() {
	const files = {};
	for (const group of ['packages', 'examples']) {
		for (const name of readdirSync(join(root, group))) {
			const src = join(root, group, name, 'src');
			if (!existsSync(src)) continue;
			for (const path of sourcePaths(src)) files[path] = readFileSync(path, 'utf8');
		}
	}
	return files;
}

test('no cycle of value imports in the source of the repository', () => {
	const cycles = findCycles(buildGraph(repositoryFiles()));
	const lines = cycles.map((cycle) => cycle.map((path) => relative(root, path)).join('\n  -> '));
	assert.deepEqual(lines, [], `cycles of value imports:\n${lines.join('\n\n')}`);
});

const probe = (files) => findCycles(buildGraph(files));

test('probe: two modules that import each other as values form a cycle', () => {
	const cycles = probe({
		'/s/a.ts': "import { b } from './b.ts';\nexport const a = b;",
		'/s/b.ts': "export { a } from './a.ts';",
	});
	assert.equal(cycles.length, 1);
	assert.deepEqual(cycles[0], ['/s/a.ts', '/s/b.ts', '/s/a.ts']);
});

test('probe: a multi-line import and a side-effect import count', () => {
	assert.equal(
		probe({
			'/s/a.ts': "import {\n\tx,\n\ty,\n} from './b.ts';",
			'/s/b.ts': "import './a.ts';",
		}).length,
		1,
	);
});

test('probe: modules that import each other as types form no cycle', () => {
	assert.deepEqual(
		probe({
			'/s/a.ts': "import type { B } from './b.ts';\nexport type A = B;",
			'/s/b.ts': "export type { A } from './a.ts';\nexport type B = string;",
		}),
		[],
	);
});

test('probe: a list of type specifiers forms no cycle, a default or mixed list does', () => {
	const typeOnly = probe({
		'/s/a.ts': "import { type B, type C } from './b.ts';",
		'/s/b.ts': "import { type A } from './a.ts';",
	});
	assert.deepEqual(typeOnly, []);
	const withDefault = probe({
		'/s/a.ts': "import b, { type B } from './b.ts';",
		'/s/b.ts': "import a from './a.ts';",
	});
	assert.equal(withDefault.length, 1);
	const mixed = probe({
		'/s/a.ts': "import { type B, c } from './b.ts';",
		'/s/b.ts': "import { type A, d } from './a.ts';",
	});
	assert.equal(mixed.length, 1);
});
