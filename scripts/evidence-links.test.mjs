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

test('a plan step names only open steps and items that the plan holds', () => {
	const text = readFileSync(join(root, 'planning/next.md'), 'utf8');
	const [scope, items] = text.split('## The items');
	const phases = new Map();
	const parts = scope.split(/^### Phase (\d+)\./m).slice(1);
	for (let i = 0; i < parts.length; i += 2) {
		phases.set(parts[i], stepsOf(parts[i + 1]));
	}
	const itemIds = new Set([...items.matchAll(/^\*\*([A-Z]\d+)\./gm)].map((m) => m[1]));
	for (const [phase, steps] of phases) {
		for (const [n, body] of steps) {
			for (const [, id] of body.matchAll(/\b([A-Z]\d+)\b(?=[,)])/g)) {
				assert.ok(itemIds.has(id), `phase ${phase} step ${n}: item ${id} is not in the items`);
			}
			for (const [, list] of body.matchAll(/Needs (\d+(?: and \d+)?)\./g)) {
				for (const ref of list.split(' and ')) {
					assert.ok(steps.has(ref) && ref !== n, `phase ${phase} step ${n}: bad Needs ${ref}`);
				}
			}
			for (const [, p, s] of body.matchAll(/phase (\d+) step (\d+)/g)) {
				assert.ok(phases.get(p)?.has(s), `phase ${phase} step ${n}: phase ${p} has no step ${s}`);
			}
		}
	}
});

test('room.md documents the room-level context cap', () => {
	const text = readFileSync(join(root, 'docs/room.md'), 'utf8');
	assert.ok(text.includes('`limits.context.messages`'));
	assert.ok(text.includes('earlier messages not shown'));
});
