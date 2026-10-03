/**
 * A workspace for Ambion: a bash backend, an optional SQL backend, an
 * optional git backend, and the tools an agent uses on them.
 *
 * `openWorkspace` opens a workspace over its backends by kind:
 * `backend: { bash, sql?, objects? }`, and the bash backend carries the
 * optional git backend. `workspace.tools()` returns the tools and
 * guidance the workspace exposes to an agent. The root entry loads no
 * backend: `./sqlite` holds the SQLite SQL backend, and `./resource` holds
 * the neutral resource contract. The bash backends are separate packages:
 * `@ambionframework/just-bash` and `@ambionframework/workstation`. The root
 * entry exports the environment helpers from `./execution-env.ts`, so a new
 * `WorkspaceEnv` backend can build on them. The file and shell types of the
 * port come from `./port.ts`.
 *
 * ```ts
 * import { defineAgent } from '@ambionframework/ambion';
 * import { openWorkspace } from '@ambionframework/workspace';
 * import { memoryBackend } from '@ambionframework/just-bash';
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

export type { AuditEntry, AuditLog, AuditLogOptions } from './audit.ts';
export { DEFAULT_AUDIT_LOG, openAuditLog } from './audit.ts';
export type {
	BashBackend,
	WorkspaceBackends,
	WorkspaceEndpoint,
	WorkspaceEndpoints,
	WorkspaceEnv,
	WorkspaceLayout,
} from './backend.ts';
export type { FileExpect, FileOperations, ScriptRun } from './execution-env.ts';
export {
	boundedView,
	DEFAULT_TIMEOUT_SECONDS,
	Deadline,
	deliverView,
	HomeEnv,
	randomName,
	resolvePath,
	runScript,
	shellQuote,
	withDeadline,
} from './execution-env.ts';
export type {
	GitBackend,
	GitChange,
	GitCommit,
	GitEnv,
	GitForkOutcome,
	GitRepository,
	GitRepositoryId,
	GitRevision,
} from './git-backend.ts';
export type { WorkspaceLog, WorkspaceLogOptions } from './log.ts';
export { openLog } from './log.ts';
export type { RoomMessageEntry, RoomMirror, RoomMirrorOptions } from './mirror.ts';
export type { ObjectBackend, ObjectDigest, ObjectEnv } from './object-backend.ts';
export type {
	FileErrorCode,
	FileInfo,
	FileResult,
	Result,
	ShellErrorCode,
	ShellExecResult,
	ShellOutputLimits,
	ShellOutputTruncation,
	ShellOutputView,
	WorkspaceExecOptions,
} from './port.ts';
export { err, FileError, ok, ShellError } from './port.ts';
export type { Process, ProcessKind, ProcessState } from './process-files.ts';
export { MAX_TIMER_SECONDS } from './process-run.ts';
export type { ProcessEvent, ProcessQuery } from './process-table.ts';
export type { SkillInfo, SkillSet } from './skills.ts';
export { loadSkills } from './skills.ts';
export type { SnapshotDetails, SnapshotOptions } from './snapshots.ts';
export { SNAPSHOT_LIMITS } from './snapshots.ts';
export type { FileSource, SourceFiles, SourceInput } from './sources.ts';
export { fromDirectory } from './sources.ts';
export type {
	SqlBackend,
	SqlEnv,
	SqlImported,
	SqlImportTable,
	SqlOutcome,
	SqlParam,
	SqlProvenance,
	SqlRow,
	SqlRunOptions,
	SqlValue,
	WorkspaceFiles,
	WorkspaceRead,
} from './sql-backend.ts';
export { sqlImport } from './sql-import.ts';
export { sqlResult } from './sql-result.ts';
export { ToolFailure } from './tools.ts';
export type { Workspace, WorkspaceProcesses, WorkspaceToolsOptions } from './workspace.ts';
export { openWorkspace } from './workspace.ts';

/** Kept in step with package.json by a test. */
export const PACKAGE_NAME = '@ambionframework/workspace';
