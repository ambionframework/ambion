import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..');
// The Node 22 CI job deletes the examples, so a link into them resolves only when they exist.
const examples = existsSync(join(root, 'examples/workbench'));
const releases = readdirSync(join(root, 'planning'))
	.filter((name) => /^\d+\.\d+\.\d+\.md$/.test(name))
	.map((name) => `planning/${name}`);
assert.ok(releases.length > 0, 'planning/ holds no release file');
const pages = [
	...readdirSync(join(root, 'docs'))
		.filter((name) => name.endsWith('.md'))
		.map((name) => `docs/${name}`),
	'CLAUDE.md',
	'README.md',
	...(examples
		? ['examples/workbench/docs/actuators.md', 'examples/workbench/docs/sensors.md']
		: []),
	...releases,
	'planning/backlog.md',
];

const slug = (heading) =>
	heading
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N} _-]/gu, '')
		.replace(/ /g, '-');

const anchorsOf = (text) =>
	new Set(
		text
			.split('\n')
			.filter((line) => /^#{1,6} /.test(line))
			.map((line) => slug(line.replace(/^#+ /, ''))),
	);

test('every relative Markdown link with a fragment resolves to a heading', () => {
	for (const page of pages) {
		const text = readFileSync(join(root, page), 'utf8');
		for (const [, target, fragment] of text.matchAll(/\]\(([^)#:\s]+\.md)#([^)\s]+)\)/g)) {
			const file = join(root, dirname(page), target);
			if (!examples && file.startsWith(join(root, 'examples'))) continue;
			assert.ok(existsSync(file), `${page}: ${target} does not exist`);
			assert.ok(
				anchorsOf(readFileSync(file, 'utf8')).has(fragment),
				`${page}: ${target}#${fragment} matches no heading`,
			);
		}
	}
});

test('a quoted section of a docs page names a heading that the page holds', () => {
	for (const dir of ['docs', 'planning']) {
		for (const name of readdirSync(join(root, dir)).filter((n) => n.endsWith('.md'))) {
			const text = readFileSync(join(root, dir, name), 'utf8').replace(/\s+/g, ' ');
			for (const [, page, heading] of text.matchAll(/`docs\/([\w-]+\.md)` "([^"]+)"/g)) {
				const file = join(root, 'docs', page);
				assert.ok(existsSync(file), `${dir}/${name}: docs/${page} does not exist`);
				const headings = readFileSync(file, 'utf8')
					.split('\n')
					.filter((line) => /^#{1,6} /.test(line))
					.map((line) => line.replace(/^#+ /, '').trim());
				assert.ok(headings.includes(heading), `${dir}/${name}: docs/${page} has no "${heading}"`);
			}
		}
	}
});

test('a docs page that cites a section "under" a heading holds that heading', () => {
	const names = readdirSync(join(root, 'docs')).filter((n) => n.endsWith('.md'));
	for (const name of names) {
		const raw = readFileSync(join(root, 'docs', name), 'utf8');
		const own = anchorsOf(raw);
		const prose = raw.replace(/\s+/g, ' ');
		for (const [, heading] of prose.matchAll(/ under ([A-Z][a-z]+(?: and [a-z]+)?)\./g)) {
			assert.ok(own.has(slug(heading)), `docs/${name}: "under ${heading}" matches no heading`);
		}
	}
});

const stepsOf = (body) =>
	new Map(
		[
			...body.matchAll(
				/^(?:- \[[ x]\] \*\*|)(\d+)\.(?:\*\*| \[[ x]\]) ([\s\S]*?)(?=^\d+\. \[|^- \[[ x]\] \*\*|^\*\*Evidence|^### |(?![\s\S]))/gm,
			),
		].map((s) => [s[1], s[2].replace(/\s+/g, ' ')]),
	);

const unknownItems = (body, itemIds) =>
	[...body.matchAll(/\b([A-Z]+\d+)\b(?=[,)])/g)]
		.filter(([, id]) => !itemIds.has(id))
		.map(([, id]) => `item ${id} is not in the items`);

const badNeeds = (body, steps, n) =>
	[...body.matchAll(/Needs (\d+(?: and \d+)?)\./g)]
		.flatMap(([, list]) => list.split(' and '))
		.filter((ref) => !steps.has(ref) || ref === n)
		.map((ref) => `bad Needs ${ref}`);

const problemsOfStep = (steps, n, itemIds) =>
	[...unknownItems(steps.get(n), itemIds), ...badNeeds(steps.get(n), steps, n)].map(
		(problem) => `step ${n}: ${problem}`,
	);

const itemsOf = (text) => new Set([...text.matchAll(/^\*\*([A-Z]+\d+)\./gm)].map((m) => m[1]));

test('a release step names only open steps and items that the release holds', () => {
	for (const release of releases) {
		const text = readFileSync(join(root, release), 'utf8');
		const [head, items = ''] = text.split('## The items');
		const work = head.split('## The work')[1] ?? '';
		const steps = stepsOf(work);
		const problems = [...steps.keys()].flatMap((n) => problemsOfStep(steps, n, itemsOf(items)));
		assert.deepEqual(problems, [], release);
	}
});

test('the release checks report a bad item and a bad Needs', () => {
	const steps = new Map([
		['1', 'Done (C1). Needs 1.'],
		['2', 'See SN99, more.'],
	]);
	assert.deepEqual(problemsOfStep(steps, '2', new Set(['C1'])), [
		'step 2: item SN99 is not in the items',
	]);
	assert.deepEqual(problemsOfStep(steps, '1', new Set(['C1'])), ['step 1: bad Needs 1']);
});

test('room.md documents the room-level context cap', () => {
	const text = readFileSync(join(root, 'docs/room.md'), 'utf8');
	assert.ok(text.includes('`limits.context.messages`'));
	assert.ok(text.includes('earlier messages not shown'));
});

const badReleaseCites = (text, itemsOfRelease) =>
	[...text.replace(/\s+/g, ' ').matchAll(/\b([A-Z]+\d+)(?:'s)? in `(\d+\.\d+\.\d+)\.md`/g)]
		.filter(([, id, version]) => !itemsOfRelease(version).has(id))
		.map(([, id, version]) => `${id} in ${version}`);

test('the release citation check finds a pruned item, also in the possessive', () => {
	const of = (version) => new Set(version === '0.8.0' ? ['C1'] : []);
	assert.deepEqual(badReleaseCites('C1 in `0.8.0.md` and D3 in\n`0.8.0.md`.', of), ['D3 in 0.8.0']);
	assert.deepEqual(badReleaseCites("C1's in `0.9.0.md` cite.", of), ['C1 in 0.9.0']);
});

test('a page that cites an item "in `<release>.md`" cites an item that the release holds', () => {
	const itemsOfRelease = (version) => {
		const file = join(root, 'planning', `${version}.md`);
		return existsSync(file) ? itemsOf(readFileSync(file, 'utf8')) : new Set();
	};
	for (const dir of ['docs', 'planning']) {
		for (const name of readdirSync(join(root, dir)).filter((n) => n.endsWith('.md'))) {
			const text = readFileSync(join(root, dir, name), 'utf8');
			for (const cite of badReleaseCites(text, itemsOfRelease)) {
				assert.fail(`${dir}/${name}: item ${cite} is not in that release`);
			}
		}
	}
});
