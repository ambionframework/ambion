/** A temporary directory that the test that makes it removes when it ends. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished } from 'vitest';

/** Make a directory under the OS temporary directory, and remove it when the test ends. */
export async function tempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	onTestFinished(() => rm(dir, { recursive: true, force: true }));
	return dir;
}
