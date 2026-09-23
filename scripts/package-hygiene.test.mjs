import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	checkDist,
	checkEngines,
	checkEsm,
	checkExports,
	checkLockstep,
	checkPack,
	checkTypebox,
} from './package-hygiene.mjs';

const good = {
	name: '@x/a',
	version: '1.0.0',
	type: 'module',
	main: './dist/index.mjs',
	types: './dist/index.d.mts',
	engines: { node: '>=26.4.0' },
	exports: {
		'.': { types: './dist/index.d.mts', import: './dist/index.mjs' },
		'./package.json': './package.json',
	},
};
const all = () => true;
const rules = (found) => found.map((entry) => entry.rule);

describe('typebox', () => {
	it('accepts one version', () => {
		assert.deepEqual(checkTypebox('packages:\n\n  typebox@1.3.18:\n    x\n'), []);
	});
	it('names a second version', () => {
		const found = checkTypebox('  typebox@1.3.18:\n    a\n  typebox@1.3.7:\n    b\n');
		assert.deepEqual(rules(found), ['typebox']);
		assert.match(found[0].message, /1\.3\.18, 1\.3\.7/);
	});
});

describe('esm', () => {
	it('accepts an ESM package', () => assert.deepEqual(checkEsm(good), []));
	it('finds a package that is not type module', () => {
		assert.deepEqual(rules(checkEsm({ ...good, type: undefined })), ['esm']);
	});
	it('finds a require condition', () => {
		const exports = { '.': { types: './a.d.mts', require: './a.mjs', import: './a.mjs' } };
		assert.deepEqual(rules(checkEsm({ ...good, exports })), ['esm']);
	});
	it('finds a CommonJS main', () => {
		assert.deepEqual(rules(checkEsm({ ...good, main: './dist/index.cjs' })), ['esm']);
	});
});

describe('exports', () => {
	it('accepts a complete map', () => assert.deepEqual(checkExports(good, all), []));
	it('finds a target that does not exist', () => {
		const found = checkExports(good, (path) => path !== './dist/index.mjs');
		assert.ok(found.length > 0);
		assert.ok(found.every((entry) => entry.rule === 'exports'));
		assert.ok(found.some((entry) => entry.message.includes('./dist/index.mjs')));
	});
	it('finds an entry without a types condition', () => {
		const exports = { '.': { import: './dist/index.mjs' } };
		assert.deepEqual(rules(checkExports({ ...good, exports }, all)), ['types']);
	});
});

describe('pack', () => {
	const files = ['dist/index.mjs', 'README.md', 'LICENSE', 'package.json'];
	it('accepts a clean list', () => assert.deepEqual(checkPack('@x/a', files), []));
	it('finds a missing license', () => {
		const found = checkPack(
			'@x/a',
			files.filter((file) => file !== 'LICENSE'),
		);
		assert.deepEqual(rules(found), ['pack']);
	});
	it('finds a missing dist and README', () => {
		assert.equal(checkPack('@x/a', ['LICENSE']).length, 2);
	});
	it('finds source, test and config files', () => {
		const extra = ['src/a.ts', 'test/a.ts', 'tsdown.config.ts', 'a.test.mjs'];
		assert.equal(checkPack('@x/a', [...files, ...extra]).length, 4);
	});
});

describe('lockstep', () => {
	const b = { ...good, name: '@x/b', dependencies: { '@x/a': 'workspace:*' } };
	it('accepts matching versions', () => assert.deepEqual(checkLockstep([good, b]), []));
	it('finds a version mismatch', () => {
		assert.deepEqual(rules(checkLockstep([good, { ...b, version: '1.0.1' }])), ['version']);
	});
	it('finds a range that is neither workspace:* nor the version', () => {
		const bad = { ...b, dependencies: { '@x/a': '^1.0.0' } };
		assert.deepEqual(rules(checkLockstep([good, bad])), ['range']);
	});
	it('accepts the same version as a range', () => {
		const same = { ...b, dependencies: { '@x/a': '1.0.0' } };
		assert.deepEqual(checkLockstep([good, same]), []);
	});
});

describe('engines', () => {
	it('accepts one value', () => assert.deepEqual(checkEngines([good, good]), []));
	it('finds a difference', () => {
		const other = { ...good, engines: { node: '>=24' } };
		assert.deepEqual(rules(checkEngines([good, other])), ['engines']);
	});
});

describe('dist', () => {
	const manifest = {
		...good,
		dependencies: { b: '1' },
		peerDependencies: { '@x/c': '1' },
		devDependencies: { d: '1', '@x/e': 'workspace:*' },
	};
	const file = (text) => [{ path: 'dist/index.mjs', text }];
	const accepted = [
		['the package itself', 'import { a } from "@x/a/testing";'],
		['a multi-line import', 'import {\n\tb1,\n\tb2\n} from "b/sub";'],
		['a side-effect import of a peer', 'import "@x/c";'],
		['a relative export', 'export * from "./chunk.mjs";'],
		['a node: scheme', 'const e = await import("node:fs");'],
		['a cloudflare: scheme', 'import { f } from "cloudflare:workers";'],
		['a # import', 'import "#internal/x";'],
		['a string that holds from', "type P = Pick<Ref, 'owner' | 'from'>;"],
		['a comment that holds from', "export function read() {\n\t// reads from 'disk'\n}"],
		['a template that holds from', `export const a = 1;\nconst m = \`read from "\${f}"\`;`],
		['a commented import', '/** see import("e") */\n// import { d } from "d";'],
		['a region of its own source', '//#region src/index.ts\n'],
	];
	for (const [label, text] of accepted) {
		it(`accepts ${label}`, () => assert.deepEqual(checkDist(manifest, file(text)), []));
	}
	it('finds a devDependency and an undeclared package, once each', () => {
		const text = 'import { d } from "d";\nimport("e/x");\nimport { d2 } from "d";';
		const found = checkDist(manifest, file(text));
		assert.deepEqual(rules(found), ['dist', 'dist']);
		assert.match(found[0].message, /imports d,/);
		assert.match(found[1].message, /imports e,/);
	});
	const inlined = [
		[
			'a node_modules package',
			'//#region ../../node_modules/.pnpm/d@1.3.18/node_modules/d/build/a.mjs',
			/inlines d from node_modules\.$/,
		],
		[
			'a workspace package',
			'//#region ../e/dist/index.mjs',
			/inlines \.\.\/e\/dist\/index\.mjs\.$/,
		],
	];
	for (const [label, text, message] of inlined) {
		it(`finds code inlined from ${label}`, () => {
			const found = checkDist(manifest, file(`${text}\n`));
			assert.deepEqual(rules(found), ['dist']);
			assert.match(found[0].message, message);
		});
	}
});
