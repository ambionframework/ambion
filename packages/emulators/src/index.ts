/**
 * just-bash as an Ambion workspace backend: a virtual Unix filesystem and shell.
 *
 * This package owns two backends over just-bash, plus the `sql` tool the just-bash
 * backends supply through `WorkspaceBackend.tools`. `memoryBackend` and
 * `directoryBackend` each satisfy `@ambionframework/workspace`'s `WorkspaceBackend`
 * contract; `openWorkspace` from that package creates the owner over one.
 *
 * ```ts
 * import { defineAgent } from '@ambionframework/ambion';
 * import { openWorkspace } from '@ambionframework/workspace';
 * import { memoryBackend } from '@ambionframework/emulators';
 *
 * const drive = openWorkspace({ name: 'team-site', backend: memoryBackend() });
 * const agent = defineAgent({ ..., bundles: [drive.tools()] });
 * ```
 *
 * The design contract is `docs/emulators.md`.
 */

export type {
	MemoryBackendFile,
	MemoryBackendOptions,
	MemoryWorkspaceBackend,
	SeedWriter,
} from './just-bash.ts';
export {
	directoryBackend,
	justBashChangedPaths,
	MEMORY_LIMIT_BYTES,
	memoryBackend,
} from './just-bash.ts';
export { createSqlTool, SHARED_DATABASE } from './sql.ts';

/** Kept in step with package.json by a test. */
export const PACKAGE_NAME = '@ambionframework/emulators';
