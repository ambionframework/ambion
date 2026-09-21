/** The catalog of the installed binary: a hung or a broken binary fails, and never opens a seat. */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { installedCatalog } from '../src/catalog.ts';

const directory = mkdtempSync(join(tmpdir(), 'ambion-codex-catalog-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

/** An executable shell script that stands for the `codex` binary. */
function binary(name: string, body: string): string {
	const path = join(directory, name);
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
	return path;
}

describe('installedCatalog', () => {
	it('reads the entry of a model from the binary', async () => {
		const path = binary('ok', `echo '{"models":[{"slug":"m1"},{"slug":"m2"}]}'`);
		const source = installedCatalog(path, undefined);
		expect(await source('m2')).toMatchObject({ slug: 'm2' });
		expect(await source('absent')).toBeUndefined();
	});

	it('fails with a message that names the binary when it prints no JSON', async () => {
		const path = binary('text', 'echo not json');
		await expect(installedCatalog(path, undefined)('m1')).rejects.toThrow(/not JSON/);
	});

	it('gives up on a binary that does not answer in time', async () => {
		const path = binary('hang', 'sleep 30');
		const started = Date.now();
		await expect(installedCatalog(path, undefined, 200)('m1')).rejects.toThrow();
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	it('tries again after a failure, and does not keep the failed run', async () => {
		const path = binary('flaky', 'echo not json');
		await expect(installedCatalog(path, undefined)('m1')).rejects.toThrow(/not JSON/);
		writeFileSync(path, `#!/bin/sh\necho '{"models":[{"slug":"m1"}]}'\n`);
		expect(await installedCatalog(path, undefined)('m1')).toMatchObject({ slug: 'm1' });
	});
});
