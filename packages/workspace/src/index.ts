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
export type {
	MemoryBackendFile,
	MemoryBackendOptions,
	MemoryWorkspaceBackend,
	SeedWriter,
} from './just-bash.ts';
export { directoryBackend, memoryBackend } from './just-bash.ts';
export type { WorkspaceLog, WorkspaceLogOptions } from './log.ts';
export { DEFAULT_ROTATE_BYTES, openLog } from './log.ts';
export type { RoomMessageEntry, RoomMirror, RoomMirrorOptions } from './mirror.ts';
export { ROOM_MIRROR_GUIDANCE, roomMirrorPath } from './mirror.ts';
export type {
	ResourceBackend,
	ResourceEnv,
	WorkspaceAgent,
	WorkspaceResource,
} from './resource.ts';
export { openResource } from './resource.ts';
export { SHARED_DATABASE } from './sql.ts';
export type { Workspace } from './workspace.ts';
export { openWorkspace } from './workspace.ts';

/** Kept in step with package.json by a test. */
export const PACKAGE_NAME = '@ambionframework/workspace';
