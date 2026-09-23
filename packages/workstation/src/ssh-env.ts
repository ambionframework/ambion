/**
 * `SshEnv`: Pi's `ExecutionEnv` for one agent, over that agent's SSH
 * session. A file call goes over SFTP, and `exec` opens one channel for each
 * command (`exec.ts`). The workspace's helpers supply the path rule and the
 * temporary names.
 *
 * SFTP needs six adjustments:
 *
 * - a coarse SFTP status becomes a Pi code through one `lstat` (`sftp.ts`)
 * - `writeFile` and `appendFile` make each missing parent first
 * - `renameFile` calls `posix-rename@openssh.com`, which replaces the
 *   target, and a server without that extension gets a plain `RENAME`
 * - `createDir` makes each missing component of the path in order
 * - a recursive `remove` runs `rm -rf --` through `exec`
 * - SFTP gives `mtime` in seconds, and `FileInfo` wants milliseconds
 *
 * Every SFTP call races the end of the session: `ssh2` keeps a request on a
 * dead channel pending forever, and the owner runs one operation at a time
 * for every agent. A call that the connection's end cuts short answers
 * `unknown`, and nothing retries it.
 *
 * An ordinary file is created with mode `0664`, so a default ACL on a shared
 * folder can give the group write. A temporary file is created with mode
 * `0600` and an exclusive create, and a temporary directory with mode
 * `0700`: every account shares `/tmp`.
 */

import { posix } from 'node:path';
import type { WorkspaceEnv } from '@ambionframework/workspace';
import { resolvePath, tempDirPath, tempFilePath } from '@ambionframework/workspace';
import {
	type Context,
	type ExecutionError,
	err,
	FileError,
	type FileInfo,
	ok,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
} from '@earendil-works/pi-agent-core';
import type { ClientChannel, Stats } from 'ssh2';
import { type CommandHost, runCommand } from './exec.ts';
import { quote } from './script.ts';
import { ConnectionClosed, type Session } from './session.ts';
import {
	call,
	type Expect,
	isMissing,
	lstat,
	readdir,
	stat,
	statusOf,
	toFileError,
} from './sftp.ts';

type FileResult<T> = Promise<Result<T, FileError>>;

/** The mode of an ordinary file. A default ACL can then give the group write. */
const FILE_MODE = 0o664;
/** The mode of a temporary file or a spill file, which no other account reads. */
const PRIVATE_FILE_MODE = 0o600;
/** The mode of a temporary directory. */
const PRIVATE_DIR_MODE = 0o700;

function toFileInfo(path: string, stats: Stats): FileInfo {
	return {
		name: posix.basename(path),
		path,
		kind: stats.isSymbolicLink() ? 'symlink' : stats.isDirectory() ? 'directory' : 'file',
		size: stats.size,
		mtimeMs: stats.mtime * 1000,
	};
}

export class SshEnv implements WorkspaceEnv {
	readonly cwd: string;
	private readonly channels = new Set<ClientChannel>();
	private readonly host: CommandHost;

	constructor(
		private readonly session: Session,
		private readonly release: () => void,
	) {
		this.cwd = session.home;
		this.host = {
			open: (command) => this.open(command),
			isDirectory: (path) => this.isDirectory(path),
			exists: (path) => this.guarded(() => this.isPresent(path)),
			discard: (path) =>
				this.guarded(() => call<void>((done) => this.sftp.unlink(path, done))).catch(
					() => undefined,
				),
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
	private classify(error: unknown, path: string, expect: Expect): Promise<FileError> {
		if (error instanceof ConnectionClosed) {
			return Promise.resolve(new FileError('unknown', error.message, path, error));
		}
		return this.guarded(() => toFileError(this.sftp, error, path, expect)).catch(
			(closed: Error) => new FileError('unknown', closed.message, path, closed),
		);
	}

	/** Run one SFTP operation, and turn what it throws into a `FileError`. */
	private async attempt<T>(
		path: string,
		expect: Expect,
		context: Context,
		fn: () => Promise<T>,
	): FileResult<T> {
		if (context.abortSignal?.aborted)
			return err(new FileError('aborted', 'Operation aborted', path));
		try {
			return ok(await this.guarded(fn));
		} catch (error) {
			return err(await this.classify(error, path, expect));
		}
	}

	private resolve(path: string): string {
		return resolvePath(this.session.home, this.cwd, path);
	}

	async absolutePath(path: string): FileResult<string> {
		return ok(this.resolve(path));
	}

	async joinPath(parts: string[]): FileResult<string> {
		return ok(posix.join(...parts));
	}

	private readBuffer(path: string): Promise<Buffer> {
		return call<Buffer>((done) => this.sftp.readFile(path, done));
	}

	readTextFile(path: string, context: Context): FileResult<string> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, 'file', context, async () =>
			(await this.readBuffer(resolved)).toString('utf8'),
		);
	}

	async readTextLines(
		path: string,
		options: { maxLines?: number } | undefined,
		context: Context,
	): FileResult<string[]> {
		const text = await this.readTextFile(path, context);
		if (!text.ok) return text;
		const lines = text.value.split('\n');
		return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
	}

	readBinaryFile(path: string, context: Context): FileResult<Uint8Array> {
		const resolved = this.resolve(path);
		return this.attempt(
			resolved,
			'file',
			context,
			async () => new Uint8Array(await this.readBuffer(resolved)),
		);
	}

	private put(path: string, content: string | Uint8Array, flag: 'w' | 'a'): Promise<void> {
		const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
		const write =
			flag === 'w' ? this.sftp.writeFile.bind(this.sftp) : this.sftp.appendFile.bind(this.sftp);
		return call<void>((done) => write(path, data, { mode: FILE_MODE, flag }, done));
	}

	/** Write or append, and make each missing parent first, as `NodeExecutionEnv` does. */
	private async putWithParents(
		path: string,
		content: string | Uint8Array,
		flag: 'w' | 'a',
	): Promise<void> {
		await this.makeDir(posix.dirname(path), true);
		await this.put(path, content, flag);
	}

	writeFile(path: string, content: string | Uint8Array, context: Context): FileResult<void> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, 'file', context, () =>
			this.putWithParents(resolved, content, 'w'),
		);
	}

	appendFile(path: string, content: string | Uint8Array, context: Context): FileResult<void> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, 'file', context, () =>
			this.putWithParents(resolved, content, 'a'),
		);
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

	async renameFile(
		sourcePath: string,
		destinationPath: string,
		context: Context,
	): FileResult<void> {
		const source = this.resolve(sourcePath);
		const destination = this.resolve(destinationPath);
		const moved = await this.attempt(source, 'any', context, () =>
			this.rename(source, destination),
		);
		if (moved.ok || moved.error.code !== 'invalid') return moved;
		// The source exists, so the destination decides the code: a missing parent is `not_found`.
		return err(await this.classify(moved.error.cause ?? moved.error, destination, 'any'));
	}

	fileInfo(path: string, context: Context): FileResult<FileInfo> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, 'any', context, async () =>
			toFileInfo(resolved, await lstat(this.sftp, resolved)),
		);
	}

	listDir(path: string, context: Context): FileResult<FileInfo[]> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, 'directory', context, async () =>
			(await readdir(this.sftp, resolved)).map((entry) =>
				toFileInfo(posix.join(resolved, entry.filename), entry.attrs as Stats),
			),
		);
	}

	canonicalPath(path: string, context: Context): FileResult<string> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, 'any', context, () =>
			call<string>((done) => this.sftp.realpath(resolved, done)),
		);
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

	exists(path: string, context: Context): FileResult<boolean> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, 'any', context, () => this.isPresent(resolved));
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

	private mkdir(path: string, mode?: number): Promise<void> {
		const attrs = mode === undefined ? {} : { mode };
		return call<void>((done) => this.sftp.mkdir(path, attrs, done));
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

	createDir(
		path: string,
		options: { recursive?: boolean } | undefined,
		context: Context,
	): FileResult<void> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, 'any', context, () =>
			this.makeDir(resolved, options?.recursive ?? true),
		);
	}

	/** Remove a whole tree through the shell: SFTP removes one entry for each request. */
	private async removeTree(path: string, context: Context): Promise<void> {
		const result = await runCommand(
			this.host,
			`rm -rf -- ${quote(path)}`,
			this.cwd,
			undefined,
			context,
		);
		if (!result.ok) throw result.error;
		if (result.value.exitCode !== 0) throw new Error(`rm -rf exited with ${result.value.exitCode}`);
	}

	private async removeOne(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
		context: Context,
	): Promise<void> {
		let stats: Stats;
		try {
			stats = await lstat(this.sftp, path);
		} catch (error) {
			if (options?.force === true && isMissing(error)) return;
			throw error;
		}
		if (!stats.isDirectory()) return call<void>((done) => this.sftp.unlink(path, done));
		if (options?.recursive === true) return this.removeTree(path, context);
		return call<void>((done) => this.sftp.rmdir(path, done));
	}

	remove(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
		context: Context,
	): FileResult<void> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, 'any', context, () => this.removeOne(resolved, options, context));
	}

	createTempDir(prefix: string | undefined, context: Context): FileResult<string> {
		const dir = tempDirPath(prefix);
		return this.attempt(dir, 'any', context, async () => {
			await this.mkdir(dir, PRIVATE_DIR_MODE);
			return dir;
		});
	}

	/** Create an empty file that no other account reads, and refuse one that already exists. */
	private async createPrivate(path: string, content: string): Promise<void> {
		const data = Buffer.from(content, 'utf8');
		await call<void>((done) =>
			this.sftp.writeFile(path, data, { mode: PRIVATE_FILE_MODE, flag: 'wx' }, done),
		);
	}

	createTempFile(
		options: { prefix?: string; suffix?: string } | undefined,
		context: Context,
	): FileResult<string> {
		const file = tempFilePath(options);
		return this.attempt(file, 'any', context, async () => {
			await this.createPrivate(file, '');
			return file;
		});
	}

	private async open(command: string): Promise<ClientChannel> {
		const channel = await this.session.exec(command);
		this.channels.add(channel);
		channel.on('close', () => this.channels.delete(channel));
		return channel;
	}

	exec(
		command: string,
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		const cwd = options?.cwd === undefined ? this.cwd : this.resolve(options.cwd);
		return runCommand(this.host, command, cwd, options, context);
	}

	/** Close any channel the operation left open, and hand the client back to the backend. */
	async cleanup(): Promise<void> {
		for (const channel of this.channels) channel.close();
		this.channels.clear();
		this.release();
	}
}
