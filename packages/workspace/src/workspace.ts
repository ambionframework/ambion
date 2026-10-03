import type { AmbionTool, Room, ToolBundle, ToolContext } from '@ambionframework/ambion';
import { type AuditLog, type AuditLogOptions, auditGuidance, openAuditLog } from './audit.ts';
import type { BashBackend, WorkspaceBackends, WorkspaceEnv } from './backend.ts';
import { type Capability, joinNotes, mergeReminders } from './capability.ts';
import { defaultToolGuidance, fileCapability } from './default-tools.ts';
import { fetchCapability } from './fetch-tool.ts';
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
import { createProcessFetch, type ProcessFetch } from './process-fetch.ts';
import type { Process } from './process-files.ts';
import type { ProcessEvent, ProcessQuery, ProcessTable } from './process-table.ts';
import { processCapability } from './process-tools.ts';
import { openProcessTable } from './processes.ts';
import {
	openResource,
	type ResourceBackend,
	type WorkspaceAgent,
	type WorkspaceResource,
} from './resource.ts';
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
	 * host, read from each agent's files, in the order they started. With
	 * `query.agent`, the list reads that agent's files even when the agent has
	 * not acted in this run: the read adopts the live processes of an earlier
	 * run, and a host that restarted finds them. The call rejects when the
	 * backend has no such agent.
	 */
	list(query?: ProcessQuery): Promise<readonly Process[]>;
	/** Call `listener` when a process starts and when it ends. Returns the unsubscribe. */
	subscribe(listener: (event: ProcessEvent) => void): () => void;
	/**
	 * Cancel the process `handle` of any agent, and give its record once it
	 * ends, or after 15 seconds, the grace and 5 seconds, when it can still
	 * read `running`.
	 */
	cancel(handle: string): Promise<Process>;
}

/** The resource over the bash backend, with an Ambion tool bundle. */
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
	 * The resource of the SQL backend, when the workspace has one. Host code
	 * runs statements through its `use`. A SQL operation may wait on the
	 * bash resource, so do not await this resource inside a callback of `use`.
	 */
	readonly sql?: WorkspaceResource<SqlEnv>;
	/**
	 * The resource of the git backend, when the workspace has one. Host code
	 * lists and forks repositories through its `use`.
	 */
	readonly git?: WorkspaceResource<GitEnv>;
	/**
	 * The resource of the object backend, where the bytes of each snapshot
	 * live. It is `backend.objects`, or a file store at `layout.snapshots`
	 * when that is absent. An object operation may wait on the bash resource.
	 */
	readonly objects: WorkspaceResource<ObjectEnv>;
	/**
	 * The processes of the agents of this run. Read the output of one through
	 * `use`, as its owner agent, at `Process.output`.
	 */
	readonly processes: WorkspaceProcesses;
	/**
	 * Send a request to the port of a running process, by name or handle, as
	 * the host. The host may use any method and any headers, and nothing is
	 * kept. Available when the bash backend has `endpoints`.
	 */
	readonly fetch?: (process: string, path: string, init?: RequestInit) => Promise<Response>;
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
	 * host agent puts the bytes of each file on the object resource, under their
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

/** The SQL backend of a workspace, and the resource the workspace opened over it. */
interface SqlBinding {
	readonly backend: SqlBackend;
	readonly resource: WorkspaceResource<SqlEnv>;
}

/** The git backend of a workspace, and the resource the workspace opened over it. */
interface GitBinding {
	readonly backend: GitBackend;
	readonly resource: WorkspaceResource<GitEnv>;
}

/** What the capabilities of a workspace need from its backends. */
interface WorkspaceBackings {
	readonly sql?: SqlBinding;
	readonly git?: GitBinding;
	readonly processes: ProcessTable;
	readonly store: SnapshotStore;
	readonly processFetch?: ProcessFetch;
}

/**
 * The capabilities of a workspace, in the order of its bundle: files,
 * processes, snapshots, SQL, git and fetch. The composer leaves out a
 * capability whose backend is absent.
 */
function capabilitiesOf(
	resource: WorkspaceResource<WorkspaceEnv>,
	{ sql, git, processFetch, store, processes }: WorkspaceBackings,
): readonly Capability[] {
	return [
		fileCapability(resource.use),
		processCapability({ bash: resource.use, processes }),
		snapshotCapability(store),
		sql && sqlCapability(sql.backend, sql.resource),
		git &&
			gitCapability({
				git: git.resource.use,
				bash: resource.use,
				server: git.backend.label,
				workspace: resource.name,
			}),
		processFetch && fetchCapability({ processFetch, store }),
	].filter((capability) => capability !== undefined);
}

/**
 * Compose the bundle from the capabilities of the workspace. The tools keep
 * the order of the capabilities. The guidance holds the tool line, the notes
 * of each capability in order, the bash backend's note, the audit note when
 * one is set, and the rooms note. The tool line opens the first note, in the
 * same paragraph. The bundle's reminder merges the reminders of the
 * capabilities, so it names each seat's processes.
 * When the workspace has an audit log, `audited` wraps every tool of the bundle.
 */
function workspaceTools(
	bash: BashBackend,
	resource: WorkspaceResource<WorkspaceEnv>,
	backends: WorkspaceBackings,
	audit: AuditLog | undefined,
): ToolBundle {
	const capabilities = capabilitiesOf(resource, backends);
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
			audit === undefined ? tools : tools.map((tool) => audited(tool, resource.use, audit)),
		),
		guidance: joinNotes(notes),
		remind: mergeReminders(capabilities.map((capability) => capability.remind)),
	});
}

/**
 * The bundle with the skills of `set`. The guidance lists them. The
 * reminder queues the copy on the bash resource, then gives the reminder
 * of the bundle. The bash resource runs its operations in order, so the copy ends
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
	bash: WorkspaceResource<WorkspaceEnv>['use'],
): ToolBundle {
	const copied = new Set<string>();
	const copy = (agent: string): void => {
		copied.add(agent);
		bash({ name: agent }, (env) => syncSkills(env, set)).catch(() => undefined);
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
		...(set.macros.length === 0 ? {} : { macros: set.macros }),
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
 * The bash backend with the process table in its disposal. The bash
 * resource calls `dispose` once its queue drains: the table cancels its
 * processes and waits for the end first, and the backend then releases its
 * handles. A process can reach the git backend, and the git resource
 * disposes after the bash resource.
 */
function withProcesses(
	backend: ResourceBackend<WorkspaceEnv>,
	processes: ProcessTable,
	processFetch?: ProcessFetch,
): ResourceBackend<WorkspaceEnv> {
	return {
		connect: (agent, signal) => backend.connect(agent, signal),
		dispose: async () => {
			// `close()` is memoised, so a second call awaits the first.
			await processFetch?.close();
			await processes.close();
			await backend.dispose?.();
		},
	};
}

/** The forward cache of the workspace, when the bash backend has `endpoints`. */
function openProcessFetch(bash: BashBackend, processes: ProcessTable): ProcessFetch | undefined {
	return bash.endpoints === undefined
		? undefined
		: createProcessFetch({ processes, endpoints: bash.endpoints });
}

/** The `fetch` of the host over the forward cache, or no member when there is none. */
function hostFetch(processFetch: ProcessFetch | undefined): Pick<Workspace, 'fetch'> {
	if (processFetch === undefined) return {};
	return {
		fetch: async (process, path, init) =>
			processFetch.send(await processFetch.resolve(process), path, init),
	};
}

/** The file store at `root` on the bash resource, written as the host agent. */
function defaultObjects(
	bash: WorkspaceResource<WorkspaceEnv>,
	mirrorAgent: WorkspaceAgent,
	root: string,
): ObjectBackend {
	return fileObjectBackend({ bash: bash.use, mirrorAgent, root });
}

/** Dispose each resource in turn, and report the first failure once every one has run. */
async function disposeInOrder(resources: readonly { dispose(): Promise<void> }[]): Promise<void> {
	let failure: { reason: unknown } | undefined;
	for (const resource of resources) {
		try {
			await resource.dispose();
		} catch (reason) {
			failure ??= { reason };
		}
	}
	if (failure !== undefined) throw failure.reason;
}

/**
 * Open the SQL resource. Each connection gets the calling agent's
 * `WorkspaceFiles` on the bash resource, so a SQL operation may wait on the
 * bash resource. No bash operation waits on the SQL resource.
 */
function openSqlResource(
	name: string,
	backend: SqlBackend,
	bash: WorkspaceResource<WorkspaceEnv>,
): WorkspaceResource<SqlEnv> {
	return openResource<SqlEnv>({
		name,
		backend: {
			connect: (agent, signal) => backend.connect(agent, workspaceFiles(bash.use, agent), signal),
			dispose: async () => backend.dispose?.(),
		},
	});
}

/**
 * Open one workspace over its backends. `backend.bash` is required, and
 * `backend.sql` is optional. The git backend is `backend.bash.git`, and it
 * is optional. Each backend gets its own resource, so a long shell
 * command does not delay a query or a fork. The SQL backend reaches the
 * bash backend through `WorkspaceFiles` to write an export. The bash
 * backend reaches its own git backend through the access that its package
 * defines. `use` and `mirror()` reach the bash resource, `sql` exposes the
 * SQL resource, and `git` the git resource. The bash backend's `layout` names where
 * the audit log and the room mirrors live. A workspace with no SQL backend
 * has no `sql` tool, and one with no git backend has no `repos` or
 * `fork` tool. Set `audit.path` to record every bound tool call at a path
 * of your own; the default is `layout.audit`. Tool guidance then tells
 * every agent the log exists and where to read it, and always names the
 * room mirror convention at `layout.rooms`. `backend.objects` holds the
 * bytes of each snapshot; absent, a file store at `layout.snapshots` holds
 * them, written through the bash resource as the host agent.
 */
export function openWorkspace(options: {
	name: string;
	backend: WorkspaceBackends;
	audit?: AuditLogOptions;
}): Workspace {
	const { bash, sql: sqlBackend } = options.backend;
	const gitBackend = bash.git;
	// Each process connects its own environment, outside the queue of the bash resource.
	const table = openProcessTable({
		connect: (agent) => bash.connect(agent),
		// The bash resource opens below. The table calls it only after the workspace opens.
		bash: (agent, operation, signal) => resource.use(agent, operation, signal),
	});
	const processFetch = openProcessFetch(bash, table);
	const resource = openResource<WorkspaceEnv>({
		name: options.name,
		backend: withProcesses(bash, table, processFetch),
	});
	const sql =
		sqlBackend === undefined
			? undefined
			: { backend: sqlBackend, resource: openSqlResource(options.name, sqlBackend, resource) };
	const git =
		gitBackend === undefined
			? undefined
			: {
					backend: gitBackend,
					resource: openResource<GitEnv>({ name: options.name, backend: gitBackend }),
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
		mirrorAgent,
		bash: resource.use,
		objects: objects.use,
	};
	const toolBundle = workspaceTools(
		bash,
		resource,
		{ sql, git, processes: table, store, processFetch },
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
	// The SQL resource goes first: a SQL operation may still write through
	// the bash resource. The git resource goes last: a push in the active bash
	// operation reaches the git backend, so the bash resource drains first.
	// The object resource goes after the bash resource, so a use that starts
	// after `dispose` is refused at once. An object operation that then asks
	// the bash resource for a write is refused, the same as any queued operation.
	const resources = [sql?.resource, resource, objects, git?.resource].flatMap((entry) =>
		entry === undefined ? [] : [entry],
	);
	const dispose = (): Promise<void> => {
		// This call stops a pending forward at once, even while the bash
		// resource is busy. The call in `withProcesses` then awaits the same close.
		const fetchClose = processFetch?.close() ?? Promise.resolve();
		const resourcesClose = disposeInOrder(resources);
		return Promise.all([fetchClose, resourcesClose]).then(() => undefined);
	};
	return Object.freeze({
		...resource,
		dispose,
		tools,
		mirrorAgent,
		processes,
		...hostFetch(processFetch),
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
				git.resource.use,
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
				git.resource.use,
				options.name,
				readOptions.agent ?? mirrorAgent,
				ref,
				readOptions.signal,
			);
		},
		...(sql === undefined ? {} : { sql: sql.resource }),
		...(git === undefined ? {} : { git: git.resource }),
	});
}
