import type { Room, ToolBundle } from '@ambionframework/ambion';
import { type AuditLog, type AuditLogOptions, auditGuidance, openAuditLog } from './audit.ts';
import type { BashBackend, BashServices, WorkspaceBackends, WorkspaceEnv } from './backend.ts';
import { createFileTools, defaultToolGuidance } from './default-tools.ts';
import { workspaceFiles } from './files.ts';
import type { GitBackend, GitEnv } from './git-backend.ts';
import { createGitTools, GIT_TOOL_NAMES, gitToolGuidance } from './git-tools.ts';
import {
	mirrorRoom,
	type RoomMirror,
	type RoomMirrorOptions,
	roomMirrorGuidance,
} from './mirror.ts';
import {
	openResource,
	type ResourceBackend,
	type WorkspaceAgent,
	type WorkspaceResource,
} from './resource.ts';
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
	 * runs statements through its `use`. A SQL operation may wait on the
	 * bash owner, so do not await this owner inside a callback of `use`.
	 */
	readonly sql?: WorkspaceResource<SqlEnv>;
	/**
	 * The owner of the git backend, when the workspace has one. Host code
	 * lists and forks repositories through its `use`.
	 */
	readonly git?: WorkspaceResource<GitEnv>;
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

/** The git backend of a workspace, and the owner the workspace opened over it. */
interface GitBinding {
	readonly backend: GitBackend;
	readonly owner: WorkspaceResource<GitEnv>;
}

/** The `sql` tool and its notes, when the workspace has a SQL backend. */
function sqlPart(
	sql: SqlBinding | undefined,
	shell: WorkspaceResource<WorkspaceEnv>,
	audit?: AuditLog,
) {
	if (sql === undefined) return { names: [], tools: [], notes: [] };
	const { database, guidance } = sql.backend;
	return {
		names: ['sql'],
		tools: [createSqlTool({ sql: sql.owner.use, shell: shell.use, database, audit })],
		notes: [sqlToolGuidance(database), guidance],
	};
}

/** The `repos` and `fork` tools and the git note, when the workspace has a git backend. */
function gitPart(
	git: GitBinding | undefined,
	shell: WorkspaceResource<WorkspaceEnv>,
	audit?: AuditLog,
) {
	if (git === undefined) return { names: [], tools: [], notes: [] };
	const { server } = git.backend;
	return {
		names: [...GIT_TOOL_NAMES],
		tools: createGitTools({ git: git.owner.use, shell: shell.use, server, audit }),
		notes: [gitToolGuidance(server)],
	};
}

/**
 * Bind the four file tools, `sql` when the workspace has a SQL backend,
 * `repos` and `fork` when it has a git backend, and the bash backend's own
 * tools. The guidance names the tools, then the SQL notes, the git note,
 * the bash backend's note, the audit note when one is set, and the rooms
 * note, in that order.
 */
function workspaceTools(
	bash: BashBackend,
	shell: WorkspaceResource<WorkspaceEnv>,
	backends: { sql?: SqlBinding; git?: GitBinding },
	audit: AuditLog | undefined,
): ToolBundle {
	const { layout, tools: own = [], guidance } = bash;
	const files = bindTools(createFileTools(), shell.use, undefined, audit).tools;
	const extra = bindTools(own, shell.use, undefined, audit).tools;
	const sql = sqlPart(backends.sql, shell, audit);
	const git = gitPart(backends.git, shell, audit);
	const notes = [
		defaultToolGuidance([...sql.names, ...git.names]),
		...sql.notes,
		...git.notes,
		guidance,
		audit && auditGuidance(audit),
		roomMirrorGuidance(layout.rooms),
	];
	return Object.freeze({
		tools: Object.freeze([...files, ...sql.tools, ...git.tools, ...extra]),
		guidance: joinNotes(notes),
	});
}

/**
 * The bash backend under its owner. With a git backend, each `connect`
 * passes the backend's access, so the shell of each agent reaches the
 * repositories. The owner reads `connect` and `dispose` alone.
 */
function bashUnderOwner(
	bash: BashBackend,
	git: GitBackend | undefined,
): ResourceBackend<WorkspaceEnv> {
	if (git === undefined) return bash;
	const services: BashServices = { git: git.access };
	return {
		connect: (agent, signal) => bash.connect(agent, signal, services),
		dispose: async () => bash.dispose?.(),
	};
}

/** Dispose each owner in turn, and report the first failure once every one has run. */
async function disposeInOrder(owners: readonly { dispose(): Promise<void> }[]): Promise<void> {
	let failure: { reason: unknown } | undefined;
	for (const owner of owners) {
		try {
			await owner.dispose();
		} catch (reason) {
			failure ??= { reason };
		}
	}
	if (failure !== undefined) throw failure.reason;
}

/**
 * Open the SQL owner. Each connection gets the calling agent's
 * `WorkspaceFiles` on the bash owner, so a SQL operation may wait on the
 * bash owner. No bash operation waits on the SQL owner.
 */
function openSqlOwner(
	name: string,
	backend: SqlBackend,
	shell: WorkspaceResource<WorkspaceEnv>,
): WorkspaceResource<SqlEnv> {
	return openResource<SqlEnv>({
		name,
		backend: {
			connect: (agent, signal) => backend.connect(agent, workspaceFiles(shell.use, agent), signal),
			dispose: async () => backend.dispose?.(),
		},
	});
}

/**
 * Open one workspace over its backends. `backend.bash` is required, and
 * `backend.sql` and `backend.git` are optional. Each backend gets its own
 * resource owner, so a long shell command does not delay a query or a
 * fork. The SQL backend reaches the bash backend through `WorkspaceFiles`
 * to write an export. The bash backend reaches the git backend through the
 * `GitAccess` that each `connect` receives. `use` and `mirror()` reach the
 * bash owner, `sql` exposes the SQL owner, and `git` the git owner. The
 * bash backend's `layout` names where the audit log and the room mirrors
 * live. A workspace with no SQL backend has no `sql` tool, and one with no
 * git backend has no `repos` and no `fork` tool. Set `audit.path`
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
	const { bash, sql: sqlBackend, git: gitBackend } = options.backend;
	const resource = openResource<WorkspaceEnv>({
		name: options.name,
		backend: bashUnderOwner(bash, gitBackend),
	});
	const sql =
		sqlBackend === undefined
			? undefined
			: { backend: sqlBackend, owner: openSqlOwner(options.name, sqlBackend, resource) };
	const git =
		gitBackend === undefined
			? undefined
			: {
					backend: gitBackend,
					owner: openResource<GitEnv>({ name: options.name, backend: gitBackend }),
				};
	const layout = bash.layout;
	const audit =
		options.audit === undefined
			? undefined
			: openAuditLog({ ...options.audit, path: options.audit.path ?? layout.audit });
	const toolBundle = workspaceTools(bash, resource, { sql, git }, audit);
	const tools = (): ToolBundle => toolBundle;
	// The workspace's own name for a mirror: one agent it owns, so a caller
	// names only the room.
	const host: WorkspaceAgent = { name: `${options.name}-host` };
	const mirror = (room: Room, mirrorOptions?: RoomMirrorOptions): Promise<RoomMirror> =>
		mirrorRoom(room, resource, host, layout.rooms, mirrorOptions);
	// The SQL owner goes first: a SQL operation may still write through the
	// bash owner. The git owner goes last: a push in the active bash
	// operation reaches the git backend, so the bash owner drains first.
	const owners = [sql?.owner, resource, git?.owner].flatMap((owner) =>
		owner === undefined ? [] : [owner],
	);
	const dispose = (): Promise<void> => disposeInOrder(owners);
	return Object.freeze({
		...resource,
		dispose,
		tools,
		host,
		mirror,
		...(sql === undefined ? {} : { sql: sql.owner }),
		...(git === undefined ? {} : { git: git.owner }),
	});
}
