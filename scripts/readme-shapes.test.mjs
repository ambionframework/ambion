import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..');
const fence = /^```ts\n([\s\S]*?)^```$/gm;

const pages = ['README.md']
	.concat(readdirSync(join(root, 'packages')).map((name) => `packages/${name}/README.md`))
	.filter((page) => existsSync(join(root, page)));

function blocksOf(page) {
	const text = readFileSync(join(root, page), 'utf8');
	return [...text.matchAll(fence)].map((match) => match[1]);
}

test('every defineAgent example passes an executor and no model fields', () => {
	for (const page of pages) {
		for (const block of blocksOf(page)) {
			for (const call of block.split('defineAgent({').slice(1)) {
				const body = call.split(/^\}\);/m)[0];
				assert.match(body, /^ {2}executor:/m, `${page}: defineAgent has no executor`);
				assert.doesNotMatch(body, /^ {2}(instructions|model|bundles):/m, `${page}: stale field`);
			}
		}
	}
});

test('no README example calls env.writeFile or env.readTextFile', () => {
	// Those calls need a harness Context, which a README reader cannot build.
	for (const page of pages) {
		for (const block of blocksOf(page)) {
			assert.doesNotMatch(block, /env\.(writeFile|readTextFile)\(/, `${page}: needs a Context`);
		}
	}
});
