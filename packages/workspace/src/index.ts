/**
 * A workspace backend for Ambion: a virtual Unix filesystem and a shell.
 *
 * The core names the identity and data boundary an agent's tools reach into
 * (`defineWorkspace`), and it holds no filesystem. This package holds one:
 * `memoryBackend` keeps the files in memory for as long as the handle lives,
 * and `directoryBackend` writes them through to a real directory. Both
 * implement `WorkspaceBackend`, which is the port the core names, so a host
 * passes either one to `defineWorkspace`.
 *
 * ```ts
 * import { defineWorkspace } from '@ambionframework/ambion';
 * import { memoryBackend } from '@ambionframework/workspace';
 *
 * const drive = defineWorkspace({ name: 'team-site', backend: memoryBackend() });
 * ```
 *
 * The design contract is `docs/workspace.md`.
 */

export type {
	MemoryBackendFile,
	MemoryBackendOptions,
	MemoryWorkspaceBackend,
	SeedWriter,
} from './just-bash.ts';
export { directoryBackend, memoryBackend } from './just-bash.ts';

/** Kept in step with package.json by a test. */
export const PACKAGE_NAME = '@ambionframework/workspace';
