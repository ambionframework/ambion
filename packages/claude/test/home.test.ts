/** The directories of a seat: each name gives one safe path segment, and a home stays under its root. */
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { seatHome, segment } from '../src/home.ts';

const names = [
	'sonnet',
	'..',
	'.',
	'',
	'a/b',
	'a\\b',
	'../../etc',
	'/abs',
	'a\0b',
	'a%2Fb',
	'.hidden',
	'C:',
	'CON',
	'\uD800',
	'élan',
];

it.each(names)('gives %j a segment that stays under its parent', (name) => {
	const one = segment(name);
	expect(one).not.toMatch(/[/\\\0]/);
	expect(one).not.toBe('.');
	expect(one).not.toBe('..');
	expect(one).not.toBe('');
	const root = join(tmpdir(), 'root');
	const path = relative(root, join(root, one));
	expect(path).toBe(one);
	expect(isAbsolute(path)).toBe(false);
});

it('gives two names two segments', () => {
	const segments = names.map(segment);
	expect(new Set(segments).size).toBe(names.length);
});

it('makes the directories of a seat once, under the root, and keeps them for every call', () => {
	const root = mkdtempSync(join(tmpdir(), 'ambion-home-'));
	const home = seatHome(root, '../lab', 'a/b');
	expect(existsSync(join(root, segment('../lab')))).toBe(false);
	const dirs = home();
	expect(home()).toBe(dirs);
	expect(dirs.config).toBe(join(root, segment('../lab'), segment('a/b'), 'config'));
	expect(dirs.work).toBe(join(root, segment('../lab'), segment('a/b'), 'work'));
	expect(dirs.home).toBe(join(root, segment('../lab'), segment('a/b'), 'home'));
	for (const directory of [dirs.config, dirs.work, dirs.home]) {
		expect(existsSync(directory)).toBe(true);
		expect(statSync(directory).mode & 0o077).toBe(0);
	}
});

it('makes a different private directory for each seat when no root is named', () => {
	const [one, two] = [seatHome(undefined, 'lab', 'a')(), seatHome(undefined, 'lab', 'a')()];
	expect(one.config).not.toBe(two.config);
	expect(one.config.startsWith(tmpdir())).toBe(true);
});

it('resolves a relative root once, so the executable reads the same directory from any cwd', () => {
	const parent = mkdtempSync(join(tmpdir(), 'ambion-rel-'));
	const before = process.cwd();
	process.chdir(parent);
	try {
		const dirs = seatHome('state', 'lab', 'a')();
		expect(isAbsolute(dirs.config)).toBe(true);
		expect(dirs.config).toBe(
			resolve(process.cwd(), 'state', segment('lab'), segment('a'), 'config'),
		);
		expect(existsSync(dirs.config)).toBe(true);
	} finally {
		process.chdir(before);
	}
});
