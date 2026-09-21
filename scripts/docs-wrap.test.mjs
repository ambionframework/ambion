import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const MAX = 90;

// Prose lines wrap at about 78 columns. Tables, code, headings, and links are exempt.
function longProse(text) {
	const found = [];
	let fenced = false;
	text.split('\n').forEach((line, index) => {
		if (line.startsWith('```')) fenced = !fenced;
		const exempt = fenced || /^(\s*[|#>[<])/.test(line) || /https?:\/\//.test(line);
		if (!exempt && line.length > MAX) found.push(`${index + 1}: ${line.length} columns`);
	});
	return found;
}

test('docs/agent.md prose wraps at about 78 columns', () => {
	const text = readFileSync(new URL('../docs/agent.md', import.meta.url), 'utf8');
	assert.deepEqual(longProse(text), []);
});

test('docs/resources.md prose wraps at about 78 columns', () => {
	const text = readFileSync(new URL('../docs/resources.md', import.meta.url), 'utf8');
	assert.deepEqual(longProse(text), []);
});

test('docs/envelope.md prose wraps at about 78 columns', () => {
	const text = readFileSync(new URL('../docs/envelope.md', import.meta.url), 'utf8');
	assert.deepEqual(longProse(text), []);
});
