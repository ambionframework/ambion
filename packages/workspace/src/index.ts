/**
 * A workspace for Ambion: a bash backend, an optional SQL backend, and the
 * tools an agent uses on them.
 *
 * `openWorkspace` opens a workspace over its backends by kind:
 * `backend: { bash, sql? }`. `workspace.tools()` returns the tools and
 * guidance the workspace exposes to an agent. The root entry loads no
 * backend: `./just-bash` holds the just-bash bash backends, `./sqlite`
 * holds the SQLite SQL backend, `./resource` holds the neutral resource
 * contract, and `./sql` holds the SQL resource. The root entry exports the
 * environment helpers from `./execution-env.ts`, so a new `ExecutionEnv`
 * backend can build on them without a dependency on `just-bash`.
 *
 * ```ts
 * import { defineAgent } from '@ambionframework/ambion';
 * import { openWorkspace } from '@ambionframework/workspace';
 * import { memoryBackend } from '@ambionframework/workspace/just-bash';
 * import { sqliteBackend } from '@ambionframework/workspace/sqlite';
 *
 * const drive = openWorkspace({
 * 	name: 'team-site',
 * 	backend: { bash: memoryBackend(), sql: sqliteBackend('./team-site.db') },
 * });
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
export type { BashBackend, WorkspaceBackends, WorkspaceEnv, WorkspaceLayout } from './backend.ts';
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
export type { SqlBackend, SqlEnv, SqlOutcome, SqlRow, SqlValue } from './sql-backend.ts';
export type { Workspace } from './workspace.ts';
export { openWorkspace } from './workspace.ts';

/** Kept in step with package.json by a test. */
export const PACKAGE_NAME = '@ambionframework/workspace';
