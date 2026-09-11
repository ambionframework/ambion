import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('publishes explicit application, host, and protocol entry points', async () => {
	const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url));
	const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
		name: string;
		exports: Record<string, unknown>;
	};
	expect(manifest.name).toBe('@ambionframework/ambion');
	expect(Object.keys(manifest.exports)).toEqual(['.', './host', './protocol', './package.json']);
});
