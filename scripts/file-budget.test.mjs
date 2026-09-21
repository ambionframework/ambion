import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;

/** The most lines one hand-written source file holds. */
const BUDGET = 600;

/** Files over the budget today. Each entry names why. A new entry needs a reason. */
const GRANDFATHERED = {
	// The pure decision table for the room. One switch per command.
	'packages/ambion/src/room/transition.ts': 720,
	// The seat runner. One activation from claim to end.
	'packages/ambion/src/execution/runner.ts': 680,
};

/** Generated files carry no budget. */
const EXEMPT = [/\.verified\.ts$/, /\.verified\.dfy/, /\.gen(\.|$)/, /\.d\.ts$/];

/** The mechanisms of the room host. */
const ROOM_HOST = ['room.ts', 'people.ts', 'dispatch.ts', 'waits.ts', 'control.ts'];

function sources(dir) {
	const found = [];
	for (const name of readdirSync(dir)) {
		if (name === 'node_modules' || name === 'dist') continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) found.push(...sources(path));
		else if (name.endsWith('.ts') && !EXEMPT.some((pattern) => pattern.test(name)))
			found.push(path);
	}
	return found;
}

function roots() {
	const found = [];
	for (const group of ['packages', 'examples']) {
		for (const name of readdirSync(join(root, group))) {
			const src = join(root, group, name, 'src');
			try {
				if (statSync(src).isDirectory()) found.push(src);
			} catch {
				// A package without a src directory has nothing to count.
			}
		}
	}
	return found;
}

const lines = (path) => readFileSync(path, 'utf8').split('\n').length - 1;
const nameOf = (path) => relative(root, path).split(sep).join('/');

test('no hand-written source file exceeds its line budget', () => {
	const over = [];
	for (const dir of roots())
		for (const path of sources(dir)) {
			const name = nameOf(path);
			const limit = GRANDFATHERED[name] ?? BUDGET;
			const count = lines(path);
			if (count > limit) over.push(`${name}: ${count} lines, budget ${limit}`);
		}
	assert.deepEqual(over, []);
});

test('a grandfathered file is still over the default budget', () => {
	for (const name of Object.keys(GRANDFATHERED))
		assert.ok(lines(join(root, name)) > BUDGET, `${name} fits the default budget: remove it`);
});

test('the room host is split by mechanism and each file fits the budget', () => {
	for (const file of ROOM_HOST) {
		const count = lines(join(root, 'packages/ambion/src/room-host', file));
		assert.ok(count <= BUDGET, `room-host/${file} has ${count} lines, budget ${BUDGET}`);
	}
});
