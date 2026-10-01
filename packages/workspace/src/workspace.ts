import type { AmbionTool, Room, ToolBundle, ToolContext } from '@ambionframework/ambion';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import { type AuditLog, type AuditLogOptions, auditGuidance, openAuditLog } from './audit.ts';
import type { BashBackend, BashServices, WorkspaceBackends, WorkspaceEnv } from './backend.ts';
import { type Capability, joinNotes, mergeReminders } from './capability.ts';
import { defaultToolGuidance, fileCapability } from './default-tools.ts';
import { workspaceFiles } from './files.ts';
import type { GitBackend, GitCommit, GitEnv, GitRevision } from './git-backend.ts';
import { commitRefOf, readCommitOf } from './git-refs.ts';
import { gitCapability } from './git-tools.ts';
import {
	mirrorRoom,
	type RoomMirror,
	type RoomMirrorOptions,
	roomMirrorGuidance,
} from './mirror.ts';
import type { ObjectBackend, ObjectEnv } from './object-backend.ts';
import { fileObjectBackend } from './object-files.ts';
import { sensorCapability } from './observe-tool.ts';
import type { ProcessRecord } from './process-files.ts';
import type { ProcessEvent, ProcessQuery, ProcessTable } from './process-table.ts';
import { processCapability } from './process-tools.ts';
import { openProcessTable } from './processes.ts';
import {
	openResource,
	type ResourceBackend,
	type WorkspaceAgent,
	type WorkspaceResource,
} from './resource.ts';
import { createSensorConnections, type SensorConnections } from './sensor-connections.ts';
import { type SkillSet, skillGuidance, skillSetOf, syncSkills } from './skills.ts';
import {
	readSnapshot,
	type SnapshotOptions,
	type SnapshotStore,
	snapshotCapability,
	takeSnapshot,
} from './snapshots.ts';
import type { SqlBackend, SqlEnv } from './sql-backend.ts';
import { sqlCapability } from './sql-tool.ts';
import { audited } from './tools.ts';

/** What one agent's bundle adds to the tools every agent shares. */
export interface WorkspaceToolsOptions {
	/**
	 * The agent's skills, from `loadSkills`. The guidance lists them, and
	 * each respond activation makes `~/.skills` in the agent's home hold
	 * their files.
	 */
	readonly skills?: SkillSet;
}

/**
 * The host's view of the processes of a workspace. A host shows a person
 * what runs, and cancels a process that an agent left running.
 */
export interface WorkspaceProcesses {
	/**
	 * The processes of the agents that used the workspace in this run of the
	 * host, read from each agent's files, in the order they started.
	 */
	list(query?: ProcessQuery): Promise<readonly ProcessRecord[]>;
	/** Call `listener` when a process starts and when it ends. Returns the unsubscribe. */
	subscribe(listener: (event: ProcessEvent) => void): () => void;
	/**
	 * Cancel the process `handle` of any agent, and give its record once it
	 * ends, or after 15 seconds, the grace and 5 seconds, when it can still
	 * read `running`.
	 */
	cancel(handle: string): Promise<ProcessRecord>;
}

/** A workspace resource with an ordinary Ambion tool bundle. */
export interface Workspace extends WorkspaceResource<WorkspaceEnv> {
	/**
	 * Return the backend tools and optional model guidance. With no options,
	 * the bundle is one stable value. With `skills`, the bundle holds the
	 * same tools, its guidance lists the skills, and its reminder copies
	 * them into the home of the seat's agent.
	 */
	tools(options?: WorkspaceToolsOptions): ToolBundle;
	/**
	 * The agent identity `mirror()` writes as: `<name>-host`, one agent this
	 * workspace owns. A backend with real accounts can give it credentials.
	 */
	readonly mirrorAgent: WorkspaceAgent;
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
	 * The owner of the object backend, where the bytes of each snapshot live.
	 * It is `backend.objects`, or a file store at `layout.snapshots` when that
	 * is absent. An object operation may wait on the bash owner.
	 */
	readonly objects: WorkspaceResource<ObjectEnv>;
	/**
	 * The processes of the agents of this run. Read the output of one through
	 * `use`, as its owner agent, at `ProcessRecord.output`.
	 */
	readonly processes: WorkspaceProcesses;
	/**
	 * Start mirroring `room`'s messages under the backend's layout, at
	 * `<layout.rooms>/<room.name>/messages.jsonl`. Call once the room has
	 * started.
	 */
	mirror(room: Room, options?: RoomMirrorOptions): Promise<RoomMirror>;
	/**
	 * Freeze the files at `paths` and give one snapshot ref for each, in
	 * order: `ambion://workspace/<name>/snapshot/<digest>/<path>`. The
	 * `agent` of `options` reads the files, and the default is `host`. The
	 * host agent puts the bytes of each file on the object owner, under their
	 * digest.
	 * The same bytes give the same ref.
	 */
	snapshot(paths: readonly string[], options?: SnapshotOptions): Promise<readonly string[]>;
	/**
	 * The bytes a snapshot ref of this workspace names. The call refuses a
	 * copy whose bytes do not match the digest in the ref.
	 */
	readSnapshot(ref: string, options?: { readonly signal?: AbortSignal }): Promise<Uint8Array>;
	/**
	 * The ref of the commit that `at` names in `repository`, with its full
	 * hash: `ambion://workspace/<name>/repo/<repository>[/branch/<b>|/tag/<t>]/commit/<hash>`.
	 * A branch or a tag gives the commit it names now. Throws when the
	 * workspace has no git backend, and when the repository or the name does
	 * not exist.
	 */
	commitRef(
		repository: string,
		at: GitRevision,
		options?: { readonly agent?: WorkspaceAgent; readonly signal?: AbortSignal },
	): Promise<string>;
	/**
	 * The commit that a commit ref of this workspace names: its message, its
	 * author, its parents, and the paths it changed. Throws when the
	 * workspace has no git backend, and when the server holds no such commit.
	 */
	readCommit(
		ref: string,
		options?: { readonly agent?: WorkspaceAgent; readonly signal?: AbortSignal },
	): Promise<GitCommit>;
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

/** What the capabilities of a workspace need from its backends. */
interface WorkspaceBackings {
	readonly sql?: SqlBinding;
	readonly git?: GitBinding;
	readonly processes: ProcessTable;
	readonly store: SnapshotStore;
	readonly connections?: SensorConnections;
}

/**
 * The capabilities of a workspace, in the order of its bundle: files,
 * processes, snapshots, SQL, git and sensors. The composer leaves out a
 * capability whose backend is absent.
 */
function capabilitiesOf(
	shell: WorkspaceResource<WorkspaceEnv>,
	{ sql, git, connections, store, processes }: WorkspaceBackings,
): readonly Capability[] {
	return [
		fileCapability(shell.use),
		processCapability({ shell: shell.use, processes }),
		snapshotCapability(store),
		sql && sqlCapability(sql.backend, sql.owner),
		git &&
			gitCapability({
				git: git.owner.use,
				shell: shell.use,
				server: git.backend.label,
				workspace: shell.name,
			}),
		connections && sensorCapability({ connections, store }),
	].filter((capability) => capability !== undefined);
}

/**
 * Compose the bundle from the capabilities of the workspace. The tools keep
 * the order of the capabilities. The guidance holds the tool line, the notes
 * of each capability in order, the bash backend's note, the audit note when
 * one is set, and the rooms note. The tool line opens the first note, in the
 * same paragraph. The bundle's reminder merges the reminders of the
 * capabilities, so it names each seat's processes and connected sensors.
 * When the workspace has an audit log, `audited` wraps every tool of the bundle.
 */
function workspaceTools(
	bash: BashBackend,
	shell: WorkspaceResource<WorkspaceEnv>,
	backends: WorkspaceBackings,
	audit: AuditLog | undefined,
): ToolBundle {
	const capabilities = capabilitiesOf(shell, backends);
	const tools = capabilities.flatMap((capability) => capability.tools);
	const toolLine = defaultToolGuidance(tools.map((tool) => tool.name));
	const [first = '', ...rest] = capabilities.flatMap((capability) => capability.notes);
	const notes = [
		`${toolLine}\n${first}`,
		...rest,
		bash.guidance,
		audit && auditGuidance(audit),
		roomMirrorGuidance(bash.layout.rooms),
	];
	return Object.freeze({
		tools: Object.freeze(
			audit === undefined ? tools : tools.map((tool) => audited(tool, shell.use, audit)),
		),
		guidance: joinNotes(notes),
		remind: mergeReminders(capabilities.map((capability) => capability.remind)),
	});
}

/**
 * The bundle with the skills of `set`. The guidance lists them. The
 * reminder queues the copy on the bash owner, then gives the reminder of
 * the bundle. The owner runs its operations in order, so the copy ends
 * before any tool call of the activation starts. The reminder does not
 * wait for the copy, so the bound of the reminder does not cut it. A copy
 * that fails leaves no manifest, and the next activation copies again.
 *
 * A run with no reminder, such as Pi's `runAgent`, copies at the first
 * tool call of the bundle for each agent that this bundle has not copied.
 */
function withSkills(
	bundle: ToolBundle,
	set: SkillSet,
	shell: WorkspaceResource<WorkspaceEnv>['use'],
): ToolBundle {
	const copied = new Set<string>();
	const copy = (agent: string): void => {
		copied.add(agent);
		shell({ name: agent }, (env) => syncSkills(env, set, BACKGROUND_CONTEXT)).catch(
			() => undefined,
		);
	};
	const tools = bundle.tools.map((tool): AmbionTool =>
		Object.freeze({
			...tool,
			invoke: (params: unknown, ctx: ToolContext) => {
				if (!copied.has(ctx.agent.name)) copy(ctx.agent.name);
				return tool.invoke(params, ctx);
			},
		}),
	);
	return Object.freeze({
		...bundle,
		tools: Object.freeze(tools),
		guidance: joinNotes([bundle.guidance, skillGuidance(set)]),
		remind: mergeReminders([
			(seat) => {
				copy(seat.agent);
				return undefined;
			},
			bundle.remind,
		]),
	});
}

/**
 * Refuse a git backend whose transport the bash backend does not carry.
 * Neither backend has a name, so the error names the transport and the
 * server of the git backend, and the transports of the bash backend.
 */
function assertTransport(bash: BashBackend, git: GitBackend | undefined): void {
	if (git === undefined) return;
	const { transport } = git.access;
	const carried = bash.gitTransports ?? [];
	if (carried.includes(transport)) return;
	const list = carried.length === 0 ? 'no git transport' : carried.join(', ');
	throw new Error(
		`The bash backend cannot reach the git backend at ${git.label}: the git backend uses the transport ${transport}, and the bash backend carries ${list}.`,
	);
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

/**
 * The bash backend with the process table in its disposal. The bash owner
 * calls `dispose` once its queue drains: the table cancels its processes and
 * waits for the end first, and the backend then releases its handles. A process can reach the git
 * backend, and the git owner disposes after the bash owner.
 */
function withProcesses(
	backend: ResourceBackend<WorkspaceEnv>,
	processes: ProcessTable,
	connections?: SensorConnections,
): ResourceBackend<WorkspaceEnv> {
	return {
		connect: (agent, signal) => backend.connect(agent, signal),
		dispose: async () => {
			// The processes wait until the connections have closed. `close()` is
			// memoised, so a second call awaits the first.
			await connections?.close();
			await processes.close();
			await backend.dispose?.();
		},
	};
}

/** The file store at `root` on the bash owner, written as the host agent. */
function defaultObjects(
	shell: WorkspaceResource<WorkspaceEnv>,
	mirrorAgent: WorkspaceAgent,
	root: string,
): ObjectBackend {
	return fileObjectBackend({ shell: shell.use, host: mirrorAgent, root });
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
 * `GitAccess` that each `connect` receives. `openWorkspace` throws when
 * `bash.gitTransports` does not hold the transport of that access. `use`
 * and `mirror()` reach the bash owner, `sql` exposes the SQL owner, and
 * `git` the git owner. The
 * bash backend's `layout` names where the audit log and the room mirrors
 * live. A workspace with no SQL backend has no `sql` tool, and one with no
 * git backend has no `repos`, `clone` or `fork` tool. Set `audit.path`
 * to record every bound tool call at a path of your own; the default is
 * `layout.audit`. Tool guidance then tells every agent the log exists and
 * where to read it, and always names the room mirror convention at
 * `layout.rooms`. `backend.objects` holds the bytes of each snapshot; absent,
 * a file store at `layout.snapshots` holds them, written through the bash
 * owner as the host agent.
 */
export function openWorkspace(options: {
	name: string;
	backend: WorkspaceBackends;
	audit?: AuditLogOptions;
}): Workspace {
	const { bash, sql: sqlBackend, git: gitBackend } = options.backend;
	assertTransport(bash, gitBackend);
	const shellBackend = bashUnderOwner(bash, gitBackend);
	// Each process connects its own environment, outside the queue of the bash owner.
	const table = openProcessTable({
		connect: (agent) => shellBackend.connect(agent),
		// The owner opens below. The table calls it only after the workspace opens.
		shell: (agent, operation, signal) => resource.use(agent, operation, signal),
	});
	const connections =
		bash.endpoints === undefined ? undefined : createSensorConnections(bash.endpoints, table);
	const resource = openResource<WorkspaceEnv>({
		name: options.name,
		backend: withProcesses(shellBackend, table, connections),
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
	// The workspace's own name for a mirror and a snapshot: one agent it
	// owns, so a caller names only the room or the paths.
	const mirrorAgent: WorkspaceAgent = { name: `${options.name}-host` };
	const objects = openResource<ObjectEnv>({
		name: options.name,
		backend: options.backend.objects ?? defaultObjects(resource, mirrorAgent, layout.snapshots),
	});
	const store: SnapshotStore = {
		workspace: options.name,
		host: mirrorAgent,
		shell: resource.use,
		objects: objects.use,
	};
	const toolBundle = workspaceTools(
		bash,
		resource,
		{ sql, git, processes: table, store, connections },
		audit,
	);
	const processes: WorkspaceProcesses = Object.freeze({
		list: (query?: ProcessQuery) => table.hostList(query),
		subscribe: (listener: (event: ProcessEvent) => void) => table.subscribe(listener),
		cancel: (handle: string) => table.hostCancel(handle),
	});
	const tools = (toolsOptions?: WorkspaceToolsOptions): ToolBundle => {
		return toolsOptions?.skills === undefined
			? toolBundle
			: withSkills(toolBundle, skillSetOf(toolsOptions.skills), resource.use);
	};
	const mirror = (room: Room, mirrorOptions?: RoomMirrorOptions): Promise<RoomMirror> =>
		mirrorRoom(room, resource, mirrorAgent, layout.rooms, mirrorOptions);
	// The SQL owner goes first: a SQL operation may still write through the
	// bash owner. The git owner goes last: a push in the active bash
	// operation reaches the git backend, so the bash owner drains first.
	// The object owner goes after the bash owner, so a use that starts after
	// `dispose` is refused at once. An object operation that then asks the
	// bash owner for a write is refused, the same as any queued operation.
	const owners = [sql?.owner, resource, objects, git?.owner].flatMap((owner) =>
		owner === undefined ? [] : [owner],
	);
	const dispose = (): Promise<void> => {
		// This call stops a pending sensor connect at once, even while the bash
		// owner is busy. The call in `withProcesses` then awaits the same close.
		const connectionClose = connections?.close() ?? Promise.resolve();
		const ownersClose = disposeInOrder(owners);
		return Promise.all([connectionClose, ownersClose]).then(() => undefined);
	};
	return Object.freeze({
		...resource,
		dispose,
		tools,
		mirrorAgent,
		processes,
		mirror,
		snapshot: (paths: readonly string[], snapshotOptions?: SnapshotOptions) =>
			takeSnapshot(store, paths, snapshotOptions),
		readSnapshot: (ref: string, readOptions?: { readonly signal?: AbortSignal }) =>
			readSnapshot(store, ref, readOptions),
		objects,
		commitRef: async (
			repository: string,
			at: GitRevision,
			refOptions: { agent?: WorkspaceAgent; signal?: AbortSignal } = {},
		) => {
			if (git === undefined) throw new Error(`Workspace '${options.name}' has no git backend.`);
			return commitRefOf(
				git.owner.use,
				options.name,
				refOptions.agent ?? mirrorAgent,
				{ repository, at },
				refOptions.signal,
			);
		},
		readCommit: async (
			ref: string,
			readOptions: { agent?: WorkspaceAgent; signal?: AbortSignal } = {},
		) => {
			if (git === undefined) throw new Error(`Workspace '${options.name}' has no git backend.`);
			return readCommitOf(
				git.owner.use,
				options.name,
				readOptions.agent ?? mirrorAgent,
				ref,
				readOptions.signal,
			);
		},
		...(sql === undefined ? {} : { sql: sql.owner }),
		...(git === undefined ? {} : { git: git.owner }),
	});
}
