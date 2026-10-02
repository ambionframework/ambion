import type { GitBackend } from './git-backend.ts';
import type { ObjectBackend } from './object-backend.ts';
import type {
	FileInfo,
	FileResult,
	Result,
	ShellError,
	ShellExecResult,
	WorkspaceExecOptions,
} from './port.ts';
import type { ResourceBackend, ResourceEnv, WorkspaceAgent } from './resource.ts';
import type { SqlBackend } from './sql-backend.ts';

/**
 * The port of a bash backend: the files and the shell of one agent. A path
 * is absolute, `~` or `~/...` under the home of the agent, or relative to
 * `cwd`. An operation never throws or rejects: every failure is its
 * `Result`. An aborted `signal` ends an operation with the code `aborted`.
 * `cleanup` takes no signal, and the resource calls it once an operation
 * ends.
 */
export interface WorkspaceEnv extends ResourceEnv {
	/** The home of the agent: the directory of a relative path. */
	readonly cwd: string;
	/** The absolute path of `path`. It need not exist, and no link is followed. */
	absolutePath(path: string, signal?: AbortSignal): FileResult<string>;
	readTextFile(path: string, signal?: AbortSignal): FileResult<string>;
	readBinaryFile(path: string, signal?: AbortSignal): FileResult<Uint8Array>;
	/** Create or replace a file. Missing parent directories are created. */
	writeFile(path: string, content: string | Uint8Array, signal?: AbortSignal): FileResult<void>;
	/** Create a file or append to it. Missing parent directories are created. */
	appendFile(path: string, content: string | Uint8Array, signal?: AbortSignal): FileResult<void>;
	/** Rename a file, and replace the destination when it exists. */
	renameFile(source: string, destination: string, signal?: AbortSignal): FileResult<void>;
	/** The facts of the addressed path. A symbolic link is not followed. */
	fileInfo(path: string, signal?: AbortSignal): FileResult<FileInfo>;
	/** The direct children of a directory. A symbolic link is not followed. */
	listDir(path: string, signal?: AbortSignal): FileResult<FileInfo[]>;
	/** The path of an existing file with every link resolved. */
	canonicalPath(path: string, signal?: AbortSignal): FileResult<string>;
	/** False for a missing path. Any other failure is an error. */
	exists(path: string, signal?: AbortSignal): FileResult<boolean>;
	/** Create a directory. `recursive` defaults to true. */
	createDir(
		path: string,
		options: { readonly recursive?: boolean } | undefined,
		signal?: AbortSignal,
	): FileResult<void>;
	/** Remove a file or a directory. `recursive` and `force` default to false. */
	remove(
		path: string,
		options: { readonly recursive?: boolean; readonly force?: boolean } | undefined,
		signal?: AbortSignal,
	): FileResult<void>;
	/** Run a command in a shell. The result names the exit code, and `onUpdate` gets the output. */
	exec(
		command: string,
		options: WorkspaceExecOptions | undefined,
		signal?: AbortSignal,
	): Promise<Result<ShellExecResult, ShellError>>;
}

/**
 * Where a bash backend keeps the shared records the neutral layer writes:
 * the audit log, the room mirrors, and the snapshots. An audit log path a
 * caller sets wins over the layout's own path.
 */
export interface WorkspaceLayout {
	/** The audit log, when `openWorkspace`'s `audit` option names no path. */
	readonly audit: string;
	/** The directory `mirror()` writes each room's record under. */
	readonly rooms: string;
	/**
	 * The folder of the default object store, when `WorkspaceBackends.objects`
	 * is absent: one file for each digest. The host agent alone writes it.
	 */
	readonly snapshots: string;
}

/** A private HTTP endpoint that reaches a service through a bash backend. */
export interface WorkspaceEndpoint {
	/** The transient HTTP root URL that the workspace host can reach. */
	readonly url: string;
	/** Close the listener and release the backend resources. */
	close(): Promise<void>;
}

/** Optional access to services that run on the machine of a bash backend. */
export interface WorkspaceEndpoints {
	/** The configured machine where workspace commands run. */
	readonly machine: string;
	/** Forward a remote loopback service to a private host loopback listener. */
	forward(
		agent: { readonly name: string },
		port: number,
		signal?: AbortSignal,
	): Promise<WorkspaceEndpoint>;
}

/**
 * The bash backend: a persistent filesystem that a shell reaches, with a
 * home for each agent. The workspace binds its tools over this backend.
 */
export interface BashBackend extends ResourceBackend<WorkspaceEnv> {
	/** One agent's environment. */
	connect(agent: WorkspaceAgent, signal?: AbortSignal): Promise<WorkspaceEnv>;
	/**
	 * The repositories that the shell reaches. The package of the bash
	 * backend takes a git backend of its own type, so `git` of each agent
	 * reaches it. `openWorkspace` opens it under a resource of its own. Absent,
	 * the workspace has no `repos`, `clone` or `fork` tool.
	 */
	readonly git?: GitBackend;
	/** Optional private transport to services on the backend machine. */
	readonly endpoints?: WorkspaceEndpoints;
	/** Guidance for the backend's own shell: its commands, its network, and its isolation. */
	guidance?: string;
	/** Where this backend keeps the audit log, the room mirrors, and the snapshots. */
	readonly layout: WorkspaceLayout;
}

/**
 * The backends of one workspace, by kind. Every workspace has a `bash`
 * backend, and the bash backend carries the optional git backend. `sql` and
 * `objects` are optional.
 */
export interface WorkspaceBackends {
	/** The persistent filesystem and its shell. The file tools, the processes, the audit log, the room mirrors, and the snapshots run on it. */
	readonly bash: BashBackend;
	/** A shared database. Absent, the workspace has no `sql` tool. */
	readonly sql?: SqlBackend;
	/**
	 * Where the bytes of each snapshot live. Absent, the workspace opens a
	 * file store at `layout.snapshots` on the bash backend.
	 */
	readonly objects?: ObjectBackend;
}
