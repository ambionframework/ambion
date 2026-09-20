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
