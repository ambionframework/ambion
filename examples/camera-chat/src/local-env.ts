import { type ChildProcess, spawn } from 'node:child_process';
import type { Stats } from 'node:fs';
import {
	appendFile,
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from 'node:fs/promises';
import { constants } from 'node:os';
import { posix } from 'node:path';
import {
	boundedView,
	DEFAULT_TIMEOUT_SECONDS,
	deliverView,
	err,
	FileError,
	type FileErrorCode,
	type FileInfo,
	type FileOperations,
	HomeEnv,
	ok,
	type Result,
	ShellError,
	type ShellExecResult,
	type WorkspaceEnv,
	type WorkspaceExecOptions,
	withDeadline,
} from '@ambionframework/workspace';

/** The most output that a command keeps, in characters. The tail stays. */
const OUTPUT_LIMIT = 1_000_000;

/** How long the env waits for the output pipes after the shell exits. */
const DRAIN_MS = 1_000;

const ERROR_CODES: Record<string, FileErrorCode> = {
	ENOENT: 'not_found',
	EISDIR: 'is_directory',
	ENOTDIR: 'not_directory',
	ENOTEMPTY: 'invalid',
	EEXIST: 'invalid',
	EINVAL: 'invalid',
	EACCES: 'permission_denied',
	EPERM: 'permission_denied',
};

function toFileInfo(path: string, stat: Stats): FileInfo {
	return {
		name: posix.basename(path),
		path,
		kind: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file',
		size: stat.size,
		mtimeMs: stat.mtimeMs,
	};
}

/** Stop the process group of a shell. A grace of 0 sends `SIGKILL` at once. */
function stopGroup(child: ChildProcess, grace: number): void {
	const pid = child.pid;
	if (pid === undefined) return;
	const send = (signal: NodeJS.Signals) => {
		try {
			process.kill(-pid, signal);
		} catch {
			// The group has already ended.
		}
	};
	if (grace <= 0) {
		send('SIGKILL');
		return;
	}
	send('SIGTERM');
	setTimeout(() => send('SIGKILL'), grace * 1000).unref();
}

/** What one shell left: its exit code and the tail of its combined output. */
interface Finished {
	readonly exitCode: number;
	readonly output: string;
}

/** Run `command` in `bash` as its own process group. A deadline stops the whole group. */
function runShell(
	command: string,
	cwd: string,
	env: Record<string, string>,
	grace: number,
	stop: AbortSignal,
): Promise<Finished> {
	return new Promise((resolve, reject) => {
		const child = spawn('/bin/bash', ['-c', command], {
			cwd,
			env,
			detached: true,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let output = '';
		const collect = (chunk: Buffer) => {
			output += chunk.toString('utf8');
			if (output.length > OUTPUT_LIMIT * 2) output = output.slice(-OUTPUT_LIMIT);
		};
		child.stdout.on('data', collect);
		child.stderr.on('data', collect);
		const closed = new Promise<void>((done) => child.once('close', () => done()));
		const abort = () => stopGroup(child, grace);
		stop.addEventListener('abort', abort, { once: true });
		if (stop.aborted) abort();
		child.once('error', reject);
		child.once('exit', (code, signal) => {
			stop.removeEventListener('abort', abort);
			const exitCode = code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0);
			const drained = new Promise<void>((done) => setTimeout(done, DRAIN_MS).unref());
			void Promise.race([closed, drained]).then(() => {
				child.stdout.destroy();
				child.stderr.destroy();
				resolve({ exitCode, output: output.slice(-OUTPUT_LIMIT) });
			});
		});
	});
}

/**
 * The files and the shell of one agent on the host: Node's filesystem and
 * `bash`. The shell sees the variables that the backend gives and no others.
 */
export class LocalEnv extends HomeEnv implements WorkspaceEnv {
	constructor(
		home: string,
		private readonly shellEnv: Record<string, string>,
	) {
		super(home);
	}

	protected readonly files: FileOperations = {
		readText: (path) => readFile(path, 'utf8'),
		readBinary: async (path) => new Uint8Array(await readFile(path)),
		write: async (path, content) => {
			await mkdir(posix.dirname(path), { recursive: true });
			await writeFile(path, content);
		},
		append: async (path, content) => {
			await mkdir(posix.dirname(path), { recursive: true });
			await appendFile(path, content);
		},
		rename: (source, destination) => rename(source, destination),
		info: async (path) => toFileInfo(path, await lstat(path)),
		list: async (path) =>
			Promise.all(
				(await readdir(path)).map(async (name) => {
					const entry = posix.join(path, name);
					return toFileInfo(entry, await lstat(entry));
				}),
			),
		canonical: (path) => realpath(path),
		exists: async (path) => {
			try {
				await lstat(path);
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
				throw error;
			}
		},
		makeDir: async (path, recursive) => {
			await mkdir(path, { recursive });
		},
		remove: (path, options) =>
			rm(path, { recursive: options?.recursive ?? false, force: options?.force ?? false }),
	};

	protected classify(error: unknown, path: string): FileError {
		const code = (error as NodeJS.ErrnoException | undefined)?.code ?? '';
		const message = error instanceof Error ? error.message : String(error);
		return new FileError(
			ERROR_CODES[code] ?? 'unknown',
			message,
			path,
			error instanceof Error ? error : undefined,
		);
	}

	exec(
		command: string,
		options: WorkspaceExecOptions | undefined,
		signal?: AbortSignal,
	): Promise<Result<ShellExecResult, ShellError>> {
		return withDeadline(signal, options?.timeout ?? DEFAULT_TIMEOUT_SECONDS, async (deadline) => {
			const cwd = options?.cwd === undefined ? this.home : this.resolve(options.cwd);
			let finished: Finished;
			try {
				finished = await runShell(
					command,
					cwd,
					{ ...this.shellEnv, ...options?.env },
					options?.grace ?? 0,
					deadline.signal,
				);
			} catch (error) {
				const cause = error instanceof Error ? error : new Error(String(error));
				return err(new ShellError('spawn_error', cause.message, cause));
			}
			const stopped = deadline.error();
			if (stopped) return err(stopped);
			const view = boundedView(finished.output, options?.capture?.limits);
			return ok(deliverView(view, finished.exitCode, options));
		});
	}

	async cleanup(): Promise<void> {}
}
