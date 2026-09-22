import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { PACKAGE_NAME } from '../src/index.ts';

it('keeps the exported package name in step with the manifest', async () => {
	const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url));
	const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { name: string };
	expect(PACKAGE_NAME).toBe(manifest.name);
});
