/**
 * `SshEnv`: the `WorkspaceEnv` port for one agent, over that agent's SSH
 * session. A file call goes over SFTP, and `exec` opens one channel for each
 * command (`exec.ts`). `HomeEnv` implements the file members over `files`,
 * the SFTP operations, and `classify`, the error classifier. The workspace's
 * helpers supply the path rule.
 *
 * SFTP needs seven adjustments:
 *
 * - a read refuses a file that is not regular before the open. A whole-file
 *   read counts bytes against `MAX_READ_BYTES`, and a range read has no
 *   size limit (`sftp.ts`)
 * - a coarse SFTP status becomes a code of the port through one `lstat` (`sftp.ts`)
 * - `writeFile` and `appendFile` make each missing parent first
 * - `renameFile` calls `posix-rename@openssh.com`, which replaces the
 *   target, and a server without that extension gets a plain `RENAME`
 * - `createDir` makes each missing component of the path in order
 * - a recursive `remove` runs `rm -rf --` through `exec`
 * - SFTP gives `mtime` in seconds, and `FileInfo` wants milliseconds
 *
 * Every SFTP call races the end of the session: `ssh2` keeps a request made
 * after its channel closes pending forever, and the resource runs one
 * operation at a time for every agent. A call that the connection's end cuts
 * short answers `unknown`, and nothing retries it. Each operation in `files`
 * runs under `guarded`.
 *
 * `renameFile` is the one member that the class overrides. When the base
 * member answers `invalid`, the override classifies the error again against
 * the destination path.
 *
 * A file is created with mode `0664`, so a default ACL on a shared folder
 * can give the group write.
 */

import { posix } from 'node:path';
import type {
	FileExpect,
	FileInfo,
	FileOperations,
	Result,
	ShellError,
	ShellExecResult,
	WorkspaceEnv,
	WorkspaceExecOptions,
} from '@ambionframework/workspace';
import { err, FileError, HomeEnv, shellQuote } from '@ambionframework/workspace';
import type { ClientChannel, Stats } from 'ssh2';
import { type CommandHost, runCommand } from './exec.ts';
import { ConnectionClosed, type Session } from './session.ts';
import {
	call,
	isMissing,
	lstat,
	readBounded,
	readdir,
	readRange,
	stat,
	statusOf,
	toFileError,
} from './sftp.ts';

/** The mode of an ordinary file. A default ACL can then give the group write. */
const FILE_MODE = 0o664;

function toFileInfo(path: string, stats: Stats): FileInfo {
	return {
		name: posix.basename(path),
		path,
		kind: stats.isSymbolicLink() ? 'symlink' : stats.isDirectory() ? 'directory' : 'file',
		size: stats.size,
		mtimeMs: stats.mtime * 1000,
	};
}

export class SshEnv extends HomeEnv implements WorkspaceEnv {
	private readonly channels = new Set<ClientChannel>();
	private readonly host: CommandHost;
	private released = false;

	constructor(
		private readonly session: Session,
		private readonly release: () => void,
	) {
		super(session.home);
		this.host = {
			open: (command) => this.open(command),
			queueSignal: (send) => this.session.queueSignal(send),
			isDirectory: (path) => this.isDirectory(path),
		};
	}

	private get sftp() {
		return this.session.sftp;
	}

	/** `work`, cut short when the session ends. */
	private guarded<T>(work: () => Promise<T>): Promise<T> {
		return this.session.guard(work);
	}

	/** Turn what an SFTP call threw into a `FileError`, with no `lstat` on a closed session. */
	protected classify(error: unknown, path: string, expect: FileExpect): Promise<FileError> {
		if (error instanceof ConnectionClosed) {
			return Promise.resolve(new FileError('unknown', error.message, path, error));
		}
		return this.guarded(() => toFileError(this.sftp, error, path, expect)).catch(
			(closed: Error) => new FileError('unknown', closed.message, path, closed),
		);
	}

	/** One SFTP operation for each file member, each racing the end of the session. */
	protected readonly files: FileOperations = {
		readText: (path) => this.guarded(async () => (await this.readBuffer(path)).toString('utf8')),
		readBinary: (path) => this.guarded(async () => new Uint8Array(await this.readBuffer(path))),
		readRange: (path, start, length) =>
			this.guarded(async () => new Uint8Array(await this.readSpan(path, start, length))),
		write: (path, content) => this.guarded(() => this.putWithParents(path, content, 'w')),
		append: (path, content) => this.guarded(() => this.putWithParents(path, content, 'a')),
		rename: (source, destination) => this.guarded(() => this.rename(source, destination)),
		info: (path) => this.guarded(async () => toFileInfo(path, await lstat(this.sftp, path))),
		list: (path) =>
			this.guarded(async () =>
				(await readdir(this.sftp, path)).map((entry) =>
					toFileInfo(posix.join(path, entry.filename), entry.attrs as Stats),
				),
			),
		canonical: (path) => this.guarded(() => call<string>((done) => this.sftp.realpath(path, done))),
		exists: (path) => this.guarded(() => this.isPresent(path)),
		makeDir: (path, recursive) => this.guarded(() => this.makeDir(path, recursive)),
		remove: (path, options, signal) => this.guarded(() => this.removeOne(path, options, signal)),
	};

	/** `read`, with a flag that turns true when the session ends. */
	private untilEnded<T>(read: (ended: () => boolean) => Promise<T>): Promise<T> {
		let ended = false;
		const stop = this.session.whenEnded(() => {
			ended = true;
		});
		return read(() => ended).finally(stop);
	}

	private readBuffer(path: string): Promise<Buffer> {
		return this.untilEnded((ended) => readBounded(this.sftp, path, ended));
	}

	private readSpan(path: string, start: number, length: number): Promise<Buffer> {
		return this.untilEnded((ended) => readRange(this.sftp, path, start, length, ended));
	}

	private put(path: string, content: string | Uint8Array, flag: 'w' | 'a'): Promise<void> {
		const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
		const write =
			flag === 'w' ? this.sftp.writeFile.bind(this.sftp) : this.sftp.appendFile.bind(this.sftp);
		return call<void>((done) => write(path, data, { mode: FILE_MODE, flag }, done));
	}

	/** Write or append, and make each missing parent, as a local shell does. */
	private async putWithParents(
		path: string,
		content: string | Uint8Array,
		flag: 'w' | 'a',
	): Promise<void> {
		try {
			await this.put(path, content, flag);
		} catch (error) {
			// A missing parent answers `NO_SUCH_FILE`. Make the parents and try once more.
			if (!isMissing(error)) throw error;
			await this.makeDir(posix.dirname(path), true);
			await this.put(path, content, flag);
		}
	}

	/** Replace the target through the OpenSSH extension, or rename plainly when the server lacks it. */
	private async rename(source: string, destination: string): Promise<void> {
		try {
			await call<void>((done) => this.sftp.ext_openssh_rename(source, destination, done));
		} catch (error) {
			if (statusOf(error) !== undefined) throw error;
			await call<void>((done) => this.sftp.rename(source, destination, done));
		}
	}

	override async renameFile(
		sourcePath: string,
		destinationPath: string,
		signal?: AbortSignal,
	): Promise<Result<void, FileError>> {
		const moved = await super.renameFile(sourcePath, destinationPath, signal);
		if (moved.ok || moved.error.code !== 'invalid') return moved;
		// The source exists, so the destination decides the code: a missing parent is `not_found`.
		const destination = this.resolve(destinationPath);
		return err(await this.classify(moved.error.cause ?? moved.error, destination, 'any'));
	}

	/** Whether anything is at `path`. A symbolic link counts, whatever it points at. */
	private async isPresent(path: string): Promise<boolean> {
		try {
			await lstat(this.sftp, path);
			return true;
		} catch (error) {
			if (isMissing(error)) return false;
			throw error;
		}
	}

	/** Whether `path` is a directory. A closed session rejects. */
	private async isDirectory(path: string): Promise<boolean> {
		try {
			return (await this.guarded(() => stat(this.sftp, path))).isDirectory();
		} catch (error) {
			if (error instanceof ConnectionClosed) throw error;
			return false;
		}
	}

	private mkdir(path: string): Promise<void> {
		return call<void>((done) => this.sftp.mkdir(path, {}, done));
	}

	/** Make `path`, and with `recursive`, each missing parent first. An existing directory passes. */
	private async makeDir(path: string, recursive: boolean): Promise<void> {
		try {
			await this.mkdir(path);
		} catch (error) {
			if (!recursive) throw error;
			if (await this.isDirectory(path)) return;
			const parent = posix.dirname(path);
			if (!isMissing(error) || parent === path) throw error;
			await this.makeDir(parent, true);
			await this.mkdir(path);
		}
	}

	/** Remove a whole tree through the shell: SFTP removes one entry for each request. */
	private async removeTree(path: string, signal: AbortSignal | undefined): Promise<void> {
		const result = await runCommand(
			this.host,
			`rm -rf -- ${shellQuote(path)}`,
			this.cwd,
			undefined,
			signal,
		);
		if (!result.ok) throw result.error;
		if (result.value.exitCode !== 0) throw new Error(`rm -rf exited with ${result.value.exitCode}`);
	}

	private async removeOne(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
		signal: AbortSignal | undefined,
	): Promise<void> {
		let stats: Stats;
		try {
			stats = await lstat(this.sftp, path);
		} catch (error) {
			if (options?.force === true && isMissing(error)) return;
			throw error;
		}
		if (!stats.isDirectory()) return call<void>((done) => this.sftp.unlink(path, done));
		if (options?.recursive === true) return this.removeTree(path, signal);
		return call<void>((done) => this.sftp.rmdir(path, done));
	}

	private async open(command: string): Promise<ClientChannel> {
		const channel = await this.session.exec(command);
		this.channels.add(channel);
		channel.on('close', () => this.channels.delete(channel));
		return channel;
	}

	exec(
		command: string,
		options: WorkspaceExecOptions | undefined,
		signal?: AbortSignal,
	): Promise<Result<ShellExecResult, ShellError>> {
		const cwd = options?.cwd === undefined ? this.cwd : this.resolve(options.cwd);
		return runCommand(this.host, command, cwd, options, signal);
	}

	/** Close any channel the operation left open, and hand the client back to the backend once. */
	async cleanup(): Promise<void> {
		for (const channel of this.channels) channel.close();
		this.channels.clear();
		if (this.released) return;
		this.released = true;
		this.release();
	}
}
