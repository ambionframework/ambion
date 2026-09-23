/**
 * The two backends every scenario in this package runs on. `memory` holds
 * the files for as long as the handle lives; `directory` writes them through
 * to a temporary directory, and disposes of it after. Each one is a
 * `ConformanceBackend`, the harness type the conformance suite takes.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConformanceBackend } from '../../src/conformance.ts';
import { directoryBackend, memoryBackend } from '../../src/just-bash.ts';

export const backends: readonly ConformanceBackend[] = [
	{
		name: 'memory',
		async open() {
			return { backend: memoryBackend(), dispose: async () => {} };
		},
	},
	{
		name: 'directory',
		async open() {
			const dir = await mkdtemp(join(tmpdir(), 'ambion-drive-'));
			return {
				backend: directoryBackend(dir),
				dispose: () => rm(dir, { recursive: true, force: true }),
			};
		},
	},
];
