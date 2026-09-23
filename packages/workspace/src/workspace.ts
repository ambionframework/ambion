import type { Room, ToolBundle } from '@ambionframework/ambion';
import { type AuditLog, type AuditLogOptions, auditGuidance, openAuditLog } from './audit.ts';
import type { BashBackend, WorkspaceBackends, WorkspaceEnv } from './backend.ts';
import { createFileTools, defaultToolGuidance } from './default-tools.ts';
import {
	mirrorRoom,
	type RoomMirror,
	type RoomMirrorOptions,
	roomMirrorGuidance,
} from './mirror.ts';
import { openResource, type WorkspaceAgent, type WorkspaceResource } from './resource.ts';
import type { SqlBackend, SqlEnv } from './sql-backend.ts';
import { createSqlTool, sqlToolGuidance } from './sql-tool.ts';
import { bindTools } from './tools.ts';

/** A workspace resource with an ordinary Ambion tool bundle. */
export interface Workspace extends WorkspaceResource<WorkspaceEnv> {
	/** Return the backend tools and optional model guidance as one stable bundle. */
	tools(): ToolBundle;
	/**
	 * The agent identity `mirror()` writes as: `<name>-host`, one agent this
	 * workspace owns. A backend with real accounts can give it credentials.
	 */
	readonly host: WorkspaceAgent;
	/**
	 * The owner of the SQL backend, when the workspace has one. Host code
	 * runs statements through its `use`. Do not await one owner's `use`
	 * inside the other's callback.
	 */
	readonly sql?: WorkspaceResource<SqlEnv>;
	/**
	 * Start mirroring `room`'s messages under the backend's layout, at
	 * `<layout.rooms>/<room.name>/messages.jsonl`. Call once the room has
	 * started.
	 */
	mirror(room: Room, options?: RoomMirrorOptions): Promise<RoomMirror>;
}

/** The notes that are set, joined as paragraphs in the order given. */
function joinNotes(notes: readonly (string | undefined)[]): string {
	return notes.filter((note): note is string => note !== undefined && note !== '').join('\n\n');
}

/** The SQL backend of a workspace, and the owner the workspace opened over it. */
interface SqlBinding {
	readonly backend: SqlBackend;
	readonly owner: WorkspaceResource<SqlEnv>;
}

/**
 * Bind the four file tools, `sql` when the workspace has a SQL backend, and
 * the bash backend's own tools. The guidance names the tools, the SQL
 * backend's note, the bash backend's note, the audit note when one is set,
 * and the rooms note, in that order.
 */
function workspaceTools(
	bash: BashBackend,
	shell: WorkspaceResource<WorkspaceEnv>,
	sql: SqlBinding | undefined,
	audit: AuditLog | undefined,
): ToolBundle {
	const { layout, tools: own = [], guidance } = bash;
	const files = bindTools(createFileTools(), shell.use, undefined, audit).tools;
	const extra = bindTools(own, shell.use, undefined, audit).tools;
	const sqlTools =
		sql === undefined
			? []
			: [
					createSqlTool({
						sql: sql.owner.use,
						shell: shell.use,
						database: sql.backend.database,
						audit,
					}),
				];
	const notes = [
		defaultToolGuidance(sql && sqlToolGuidance(sql.backend.database)),
		sql?.backend.guidance,
		guidance,
		audit && auditGuidance(audit),
		roomMirrorGuidance(layout.rooms),
	];
	return Object.freeze({
		tools: Object.freeze([...files, ...sqlTools, ...extra]),
		guidance: joinNotes(notes),
	});
}

/** Dispose every owner, and report the first failure once each one has settled. */
async function disposeAll(owners: readonly { dispose(): Promise<void> }[]): Promise<void> {
	const results = await Promise.allSettled(owners.map((owner) => owner.dispose()));
	const failure = results.find((result) => result.status === 'rejected');
	if (failure !== undefined) throw failure.reason;
}

/**
 * Open one workspace over its backends. `backend.bash` is required, and
 * `backend.sql` is optional. Each backend gets its own resource owner, so
 * a long shell command does not delay a query. `use` and `mirror()` reach
 * the bash owner, and `sql` exposes the SQL owner. The bash backend's
 * `layout` names where the audit log and the room mirrors live. A
 * workspace with no SQL backend has no `sql` tool. Set `audit.path`
 * to record every bound tool call at a path of your own; the default is
 * `layout.audit`. Tool guidance then tells every agent the log exists and
 * where to read it, and always names the room mirror convention at
 * `layout.rooms`.
 */
export function openWorkspace(options: {
	name: string;
	backend: WorkspaceBackends;
	audit?: AuditLogOptions;
}): Workspace {
	const { bash, sql: sqlBackend } = options.backend;
	const resource = openResource<WorkspaceEnv>({ name: options.name, backend: bash });
	const sql =
		sqlBackend === undefined
			? undefined
			: {
					backend: sqlBackend,
					owner: openResource<SqlEnv>({ name: options.name, backend: sqlBackend }),
				};
	const layout = bash.layout;
	const audit =
		options.audit === undefined
			? undefined
			: openAuditLog({ ...options.audit, path: options.audit.path ?? layout.audit });
	const toolBundle = workspaceTools(bash, resource, sql, audit);
	const tools = (): ToolBundle => toolBundle;
	// The workspace's own name for a mirror: one agent it owns, so a caller
	// names only the room.
	const host: WorkspaceAgent = { name: `${options.name}-host` };
	const mirror = (room: Room, mirrorOptions?: RoomMirrorOptions): Promise<RoomMirror> =>
		mirrorRoom(room, resource, host, layout.rooms, mirrorOptions);
	const owners = sql === undefined ? [resource] : [resource, sql.owner];
	const dispose = (): Promise<void> => disposeAll(owners);
	return Object.freeze({
		...resource,
		dispose,
		tools,
		host,
		mirror,
		...(sql === undefined ? {} : { sql: sql.owner }),
	});
}
