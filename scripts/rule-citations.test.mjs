import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..', 'packages');
const skipped = new Set(['node_modules', 'dist', '.wrangler']);
const citation = /\brules? [0-9]|\brule[0-9]/i;

const sources = (dir) =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return skipped.has(entry.name) ? [] : sources(path);
		return entry.name.endsWith('.ts') && !entry.name.endsWith('.verified.ts') ? [path] : [];
	});

test('no source file cites a numbered rule', () => {
	const found = [];
	for (const file of sources(root)) {
		readFileSync(file, 'utf8')
			.split('\n')
			.forEach((line, index) => {
				if (citation.test(line)) found.push(`${file}:${index + 1}: ${line.trim()}`);
			});
	}
	assert.deepEqual(found, []);
});

test('planning/formal.md cites only items that planning/next.md holds', () => {
	const planning = join(import.meta.dirname, '..', 'planning');
	const formal = readFileSync(join(planning, 'formal.md'), 'utf8');
	const next = readFileSync(join(planning, 'next.md'), 'utf8');
	const defined = (text) => new Set([...text.matchAll(/\*\*([A-Z][0-9]+)\./g)].map((m) => m[1]));
	const own = defined(formal);
	const held = defined(next);
	const dangling = [...formal.matchAll(/\b([C-F][0-9]+)\b/g)]
		.map((m) => m[1])
		.filter((id) => !own.has(id) && !held.has(id));
	assert.deepEqual([...new Set(dangling)], []);
});
