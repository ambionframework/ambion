/**
 * The just-bash backends for an Ambion workspace: a virtual Unix filesystem
 * and shell in the process, in memory or over a real directory.
 *
 * ```ts
 * import { memoryBackend } from '@ambionframework/just-bash';
 * import { openWorkspace } from '@ambionframework/workspace';
 *
 * const drive = openWorkspace({ name: 'team-site', backend: { bash: memoryBackend() } });
 * ```
 *
 * The design contract is `docs/workspace.md`.
 */

export type {
	MemoryBackendFile,
	MemoryBackendOptions,
	MemoryBashBackend,
	SeedWriter,
} from './just-bash.ts';
export { directoryBackend, memoryBackend } from './just-bash.ts';

/** Kept in step with package.json by a test. */
export const PACKAGE_NAME = '@ambionframework/just-bash';
