import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..');
const pages = ['planning/evidence/README.md', 'planning/evidence/reports/README.md', 'CLAUDE.md'];

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

test('prose lines the evidence move rewrote stay within 78 columns', () => {
	const lines = [
		['docs/assistant.md', 'acceptance review'],
		['planning/next.md', 'planning/evidence/reports/README.md'],
	];
	for (const [page, needle] of lines) {
		const text = readFileSync(join(root, page), 'utf8').split('\n');
		for (const line of text.filter((l) => l.includes(needle) && !l.startsWith('|'))) {
			assert.ok(line.length <= 78, `${page}: ${line.length} columns: ${line}`);
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

const phasesOf = (scope) => {
	const phases = new Map();
	const parts = scope.split(/^### Phase (\d+)\./m).slice(1);
	for (let i = 0; i < parts.length; i += 2) {
		phases.set(parts[i], stepsOf(parts[i + 1]));
	}
	return phases;
};

const unknownItems = (body, itemIds) =>
	[...body.matchAll(/\b([A-Z]\d+)\b(?=[,)])/g)]
		.filter(([, id]) => !itemIds.has(id))
		.map(([, id]) => `item ${id} is not in the items`);

const badNeeds = (body, steps, n) =>
	[...body.matchAll(/Needs (\d+(?: and \d+)?)\./g)]
		.flatMap(([, list]) => list.split(' and '))
		.filter((ref) => !steps.has(ref) || ref === n)
		.map((ref) => `bad Needs ${ref}`);

const badStepRefs = (body, phases) =>
	[...body.matchAll(/phase (\d+) step (\d+)/g)]
		.filter(([, p, s]) => !phases.get(p)?.has(s))
		.map(([, p, s]) => `phase ${p} has no step ${s}`);

const problemsOfStep = (phases, phase, n, itemIds) => {
	const steps = phases.get(phase);
	const body = steps.get(n);
	return [
		...unknownItems(body, itemIds),
		...badNeeds(body, steps, n),
		...badStepRefs(body, phases),
	].map((problem) => `phase ${phase} step ${n}: ${problem}`);
};

test('a plan step names only open steps and items that the plan holds', () => {
	const text = readFileSync(join(root, 'planning/next.md'), 'utf8');
	const [scope, items] = text.split('## The items');
	const phases = phasesOf(scope);
	const itemIds = new Set([...items.matchAll(/^\*\*([A-Z]\d+)\./gm)].map((m) => m[1]));
	const problems = [...phases].flatMap(([phase, steps]) =>
		[...steps.keys()].flatMap((n) => problemsOfStep(phases, phase, n, itemIds)),
	);
	assert.deepEqual(problems, []);
});

test('the plan checks report a bad item, a bad Needs, and a bad step reference', () => {
	const steps = new Map([
		['1', 'Done (C1). Needs 1.'],
		['2', 'See phase 9 step 9 and Z9, more.'],
	]);
	const phases = new Map([['1', steps]]);
	const found = problemsOfStep(phases, '1', '2', new Set(['C1']));
	assert.deepEqual(found, [
		'phase 1 step 2: item Z9 is not in the items',
		'phase 1 step 2: phase 9 has no step 9',
	]);
	assert.deepEqual(problemsOfStep(phases, '1', '1', new Set(['C1'])), [
		'phase 1 step 1: bad Needs 1',
	]);
});

test('room.md documents the room-level context cap', () => {
	const text = readFileSync(join(root, 'docs/room.md'), 'utf8');
	assert.ok(text.includes('`limits.context.messages`'));
	assert.ok(text.includes('earlier messages not shown'));
});

test('a page that cites an item "in `next.md`" cites an item that the plan holds', () => {
	const plan = readFileSync(join(root, 'planning/next.md'), 'utf8');
	const itemIds = new Set([...plan.matchAll(/^\*\*([A-Z]\d+)\./gm)].map((m) => m[1]));
	for (const dir of ['docs', 'planning']) {
		for (const name of readdirSync(join(root, dir)).filter((n) => n.endsWith('.md'))) {
			const text = readFileSync(join(root, dir, name), 'utf8').replace(/\s+/g, ' ');
			for (const [, id] of text.matchAll(/\b([A-Z]\d+) in `next\.md`/g)) {
				assert.ok(itemIds.has(id), `${dir}/${name}: item ${id} is not in next.md`);
			}
		}
	}
});
