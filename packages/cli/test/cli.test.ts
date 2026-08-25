import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cliVersion } from '../src/lib/version.ts';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('cliVersion', () => {
	it('reads the version off the CLI manifest', async () => {
		const manifest = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
			version: string;
		};
		expect(cliVersion()).toBe(manifest.version);
	});
});

describe('the bin guard', () => {
	it('enforces exactly the Node floor package.json declares', async () => {
		const bin = await readFile(join(PACKAGE_ROOT, 'bin', 'ambion.mjs'), 'utf8');
		const manifest = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
			engines: { node: string };
		};
		// bin/ambion.mjs cannot read package.json — it must parse on Node versions
		// that lack JSON import attributes — so the floor is written twice. This
		// asserts the two copies agree.
		const major = /MIN_NODE_MAJOR = (\d+)/.exec(bin)?.[1];
		const minor = /MIN_NODE_MINOR = (\d+)/.exec(bin)?.[1];
		expect(major).toBeDefined();
		expect(minor).toBeDefined();
		expect(manifest.engines.node).toBe(`>=${major}.${minor}.0`);
	});
});
