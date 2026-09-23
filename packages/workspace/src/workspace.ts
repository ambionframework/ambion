import type { Room, ToolBundle } from '@ambionframework/ambion';
import { type AuditLog, type AuditLogOptions, auditGuidance, openAuditLog } from './audit.ts';
import type { WorkspaceBackend, WorkspaceEnv } from './backend.ts';
import {
	createDefaultTools,
	createFileTools,
	defaultToolGuidance,
	fileToolGuidance,
} from './default-tools.ts';
import {
	mirrorRoom,
	type RoomMirror,
	type RoomMirrorOptions,
	roomMirrorGuidance,
} from './mirror.ts';
import { openResource, type WorkspaceAgent, type WorkspaceResource } from './resource.ts';
import type { SqlBackend, SqlEnv } from './sql-backend.ts';
import { createBackendSqlTool, sqlToolGuidance } from './sql-tool.ts';
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

/** What `openWorkspace` takes. */
interface WorkspaceOptions {
	name: string;
	/** The shell backend. Every workspace has one. */
	backend: WorkspaceBackend;
	/** A shared database beside the shell. Absent, `sql` opens `backend.layout.database`. */
	sql?: SqlBackend;
	audit?: AuditLogOptions;
}

/**
 * Bind the five default tools and the shell backend's own tools. With no
 * SQL backend, `sql` is the shell tool over `layout.database`. With one,
 * `sql` runs on `sqlOwner`. The guidance names the tools, the SQL
 * backend's note, the shell backend's note, the audit note when one is
 * set, and the rooms note, in that order.
 */
function workspaceTools(
	options: WorkspaceOptions,
	shell: WorkspaceResource<WorkspaceEnv>,
	sqlOwner: WorkspaceResource<SqlEnv> | undefined,
	audit: AuditLog | undefined,
): ToolBundle {
	const { layout, tools: own = [], guidance } = options.backend;
	const tail = [guidance, audit && auditGuidance(audit), roomMirrorGuidance(layout.rooms)];
	if (options.sql === undefined || sqlOwner === undefined) {
		const tools = [...createDefaultTools(layout.database), ...own];
		return bindTools(
			tools,
			shell.use,
			joinNotes([defaultToolGuidance(layout.database), ...tail]),
			audit,
		);
	}
	const database = options.sql.database;
	const sql = createBackendSqlTool({ sql: sqlOwner.use, shell: shell.use, database, audit });
	const files = bindTools(createFileTools(), shell.use, undefined, audit).tools;
	const extra = bindTools(own, shell.use, undefined, audit).tools;
	const notes = [fileToolGuidance(sqlToolGuidance(database)), options.sql.guidance, ...tail];
	return Object.freeze({
		tools: Object.freeze([...files, sql, ...extra]),
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
 * Open one workspace over a shell backend and, when `sql` is set, a SQL
 * backend. Each backend gets its own resource owner, so a long shell
 * command does not delay a query. `use` and `mirror()` reach the shell
 * owner, and `sql` exposes the SQL owner. The shell backend's `layout`
 * names where the audit log and the room mirrors live, and the shared
 * database when the workspace has no SQL backend. Set `audit.path` to
 * record every bound tool call at a path of your own; the default is
 * `layout.audit`. Tool guidance then tells every agent the log exists and
 * where to read it, and always names the room mirror convention at
 * `layout.rooms`.
 */
export function openWorkspace(options: WorkspaceOptions): Workspace {
	const resource = openResource<WorkspaceEnv>(options);
	const sqlOwner =
		options.sql === undefined
			? undefined
			: openResource<SqlEnv>({ name: options.name, backend: options.sql });
	const layout = options.backend.layout;
	const audit =
		options.audit === undefined
			? undefined
			: openAuditLog({ ...options.audit, path: options.audit.path ?? layout.audit });
	const toolBundle = workspaceTools(options, resource, sqlOwner, audit);
	const tools = (): ToolBundle => toolBundle;
	// The workspace's own name for a mirror: one agent it owns, so a caller
	// names only the room.
	const host: WorkspaceAgent = { name: `${options.name}-host` };
	const mirror = (room: Room, mirrorOptions?: RoomMirrorOptions): Promise<RoomMirror> =>
		mirrorRoom(room, resource, host, layout.rooms, mirrorOptions);
	const owners = sqlOwner === undefined ? [resource] : [resource, sqlOwner];
	const dispose = (): Promise<void> => disposeAll(owners);
	return Object.freeze({
		...resource,
		dispose,
		tools,
		host,
		mirror,
		...(sqlOwner === undefined ? {} : { sql: sqlOwner }),
	});
}
