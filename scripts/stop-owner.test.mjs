import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..');
const read = (page) => readFileSync(join(root, page), 'utf8');

test('durability.md owns the stop guarantee and deployment.md links to it', () => {
	const durability = read('docs/durability.md');
	const deployment = read('docs/deployment.md');
	assert.match(durability, /Stop preserves an open exchange/);
	assert.doesNotMatch(deployment, /Stop preserves an open exchange/);
	assert.doesNotMatch(deployment, /Shutdown settles every running lease/);
	assert.match(deployment, /\]\(durability\.md#stop\)/);
});
