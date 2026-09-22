/**
 * The workspace resource contract for Ambion: the neutral `ResourceBackend`
 * contract, the filesystem-shaped `WorkspaceBackend` contract over it, and
 * the generic machinery — audit, change tracking, a room mirror, an
 * append-only log — that runs over any backend that satisfies it.
 *
 * This package holds no backend of its own. `@ambionframework/emulators`
 * implements `WorkspaceBackend` over just-bash; a host picks an
 * implementation and passes it to `openWorkspace`, which creates one owner.
 * `workspace.tools()` returns the tools and guidance that owner exposes to
 * an agent.
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
 * The design contract is `docs/workspace.md`; the backend contract's
 * implementations are `docs/emulators.md`.
 */

/**
 * A caller of `workspace.use` reaches Pi's `ExecutionEnv`, whose members take
 * a context. Use this context when the call has no other one.
 */
export { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
export type { AuditEntry, AuditLog, AuditLogOptions } from './audit.ts';
export { DEFAULT_AUDIT_LOG, openAuditLog } from './audit.ts';
export type { WorkspaceBackend, WorkspaceEnv } from './backend.ts';
export type { ChangeLog, ChangeLogOptions, ChangeQuery, WorkspaceChange } from './changes.ts';
export { DEFAULT_CHANGE_LOG, openChangeLog } from './changes.ts';
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
export type {
	SqlProvenance,
	SqlResource,
	SqlResourceEnv,
	SqlResourceOptions,
	SqlValue,
} from './sql-resource.ts';
export { openSqlResource, PROVENANCE_COLUMNS } from './sql-resource.ts';
export type { Workspace } from './workspace.ts';
export { openWorkspace } from './workspace.ts';

/** Kept in step with package.json by a test. */
export const PACKAGE_NAME = '@ambionframework/workspace';
