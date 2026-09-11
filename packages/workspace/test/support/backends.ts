/**
 * The two backends every scenario in this package runs on. `memory` holds
 * the files for as long as the handle lives; `directory` writes them through
 * to a temporary directory, and disposes of it after.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceBackend } from '@ambionframework/ambion';
import { directoryBackend, memoryBackend } from '../../src/index.ts';

export interface Backend {
	readonly name: 'memory' | 'directory';
	open(): Promise<{ backend: WorkspaceBackend; dispose(): Promise<void> }>;
}

export const backends: readonly Backend[] = [
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
