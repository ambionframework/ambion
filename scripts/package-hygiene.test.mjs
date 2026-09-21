import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
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
