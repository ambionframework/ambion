/**
 * A workspace backend for Ambion: a virtual Unix filesystem and a shell.
 *
 * This package owns the workspace resource, its built-in tools, and two
 * filesystem backends. `openWorkspace` creates one owner; `workspace.tools()`
 * returns the tools and guidance that owner exposes to an agent.
 *
 * ```ts
 * import { defineAgent } from '@ambionframework/ambion';
 * import { memoryBackend, openWorkspace } from '@ambionframework/workspace';
 *
 * const drive = openWorkspace({ name: 'team-site', backend: memoryBackend() });
 * const agent = defineAgent({ ..., tools: [drive.tools()] });
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
export type { Workspace, WorkspaceAgent, WorkspaceBackend } from './resource.ts';
export { openWorkspace } from './resource.ts';

/** Kept in step with package.json by a test. */
export const PACKAGE_NAME = '@ambionframework/workspace';
