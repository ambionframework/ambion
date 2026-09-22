/**
 * A workspace backend for Ambion: a virtual Unix filesystem and a shell.
 *
 * This package owns the workspace resource, its built-in tools, and two
 * filesystem backends. `openWorkspace` creates one owner; `workspace.tools()`
 * returns the tools and guidance that owner exposes to an agent. The root
 * entry loads no backend: `./just-bash` holds the just-bash backends,
 * `./resource` holds the neutral resource contract, and `./sql` holds the
 * SQL resource. The root entry exports the environment helpers from
 * `./execution-env.ts`, so a new `ExecutionEnv` backend can build on them
 * without a dependency on `just-bash`.
 *
 * ```ts
 * import { defineAgent } from '@ambionframework/ambion';
 * import { openWorkspace } from '@ambionframework/workspace';
 * import { memoryBackend } from '@ambionframework/workspace/just-bash';
 *
 * const drive = openWorkspace({ name: 'team-site', backend: memoryBackend() });
 * const agent = defineAgent({ ..., bundles: [drive.tools()] });
 * ```
 *
 * The design contract is `docs/workspace.md`.
 */

/**
 * A caller of `workspace.use` reaches Pi's `ExecutionEnv`, whose members take
 * a context. Use this context when the call has no other one.
 */
export { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
export type { AuditEntry, AuditLog, AuditLogOptions } from './audit.ts';
export { DEFAULT_AUDIT_LOG, openAuditLog } from './audit.ts';
export type { WorkspaceBackend, WorkspaceEnv } from './backend.ts';
export type { MinimalWriter } from './execution-env.ts';
export {
	boundedView,
	Deadline,
	randomName,
	resolvePath,
	spill,
	spillPath,
	TMP,
	tempDirPath,
	tempFilePath,
} from './execution-env.ts';
export type { WorkspaceLog, WorkspaceLogOptions } from './log.ts';
export { openLog } from './log.ts';
export type { RoomMessageEntry, RoomMirror, RoomMirrorOptions } from './mirror.ts';
export { SHARED_DATABASE } from './sql.ts';
export type { Workspace } from './workspace.ts';
export { openWorkspace } from './workspace.ts';

/** Kept in step with package.json by a test. */
export const PACKAGE_NAME = '@ambionframework/workspace';
