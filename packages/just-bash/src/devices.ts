/**
 * The device layer of the just-bash backends.
 *
 * just-bash seeds `/dev/null` and its siblings only on a filesystem with
 * synchronous writes. The in-memory filesystem gets them as plain files that
 * keep every byte written. The directory filesystem gets none, and a redirect
 * to `/dev/null` writes a real file under the root. `withDevices` wraps a
 * filesystem and answers every `/dev` path itself, so both backends behave
 * the same and no device path reaches the base filesystem.
 *
 * `/dev/null` discards writes and reads empty. `/dev/zero`, `/dev/stdin`,
 * `/dev/stdout` and `/dev/stderr` also discard writes and read empty. `/dev/zero`
 * ends at once and does not stream zero bytes.
 */

import { posix } from 'node:path';
import type { ByteString, FsStat, IFileSystem } from 'just-bash';

type Dirent = Awaited<ReturnType<NonNullable<IFileSystem['readdirWithFileTypes']>>>[number];

export const DEV_DIR = '/dev';

/** The device names under `/dev`, sorted. */
const DEVICES = ['fd', 'null', 'stderr', 'stdin', 'stdout', 'zero'] as const;

type Kind = 'directory' | 'file';

const KIND_FLAGS = {
	file: { isFile: true, isDirectory: false, isSymbolicLink: false },
	directory: { isFile: false, isDirectory: true, isSymbolicLink: false },
} as const;

/** What `/dev` holds at `path`: the directory, a device file, or nothing. */
function deviceAt(path: string): Kind | undefined {
	const clean = posix.normalize(path);
	if (clean === DEV_DIR) return 'directory';
	if (!clean.startsWith(`${DEV_DIR}/`)) return undefined;
	const name = clean.slice(DEV_DIR.length + 1);
	return (DEVICES as readonly string[]).includes(name) ? 'file' : undefined;
}

function statOf(kind: Kind): FsStat {
	return {
		...KIND_FLAGS[kind],
		mode: kind === 'file' ? 0o666 : 0o755,
		size: 0,
		mtime: new Date(0),
	};
}

/** The error a base filesystem throws when a path exists. */
function exists(path: string, action: string): Error {
	return new Error(`EEXIST: file already exists, ${action} '${path}'`);
}

/** A filesystem that answers `/dev` paths itself and delegates every other path. */
class DeviceFs implements IFileSystem {
	constructor(private readonly base: IFileSystem) {
		const readBytes = base.readFileBytes?.bind(base);
		if (readBytes) {
			this.readFileBytes = async (path) =>
				deviceAt(path) === 'file' ? ('' as unknown as ByteString) : readBytes(path);
		}
		this.forwardSeeder(base);
		const readTyped = base.readdirWithFileTypes?.bind(base);
		if (readTyped) this.readdirWithFileTypes = (path) => this.typedEntries(path, readTyped);
	}

	async readFile(path: string, options?: Parameters<IFileSystem['readFile']>[1]) {
		return deviceAt(path) === 'file' ? '' : this.base.readFile(path, options);
	}

	/**
	 * just-bash lays out `/bin`, `/tmp` and the like on a filesystem with `mkdirSync` and
	 * `writeFileSync`, and skips the layout without them. Forward both, and skip `/dev`.
	 */
	mkdirSync?: (path: string, options?: unknown) => void;
	writeFileSync?: (path: string, content: unknown, options?: unknown) => void;

	private forwardSeeder(base: IFileSystem): void {
		const sync = base as unknown as Pick<DeviceFs, 'mkdirSync' | 'writeFileSync'>;
		const { mkdirSync, writeFileSync } = sync;
		if (typeof mkdirSync !== 'function' || typeof writeFileSync !== 'function') return;
		this.mkdirSync = (path, options) => {
			if (deviceAt(path) === undefined) mkdirSync.call(base, path, options);
		};
		this.writeFileSync = (path, content, options) => {
			if (deviceAt(path) === undefined) writeFileSync.call(base, path, content, options);
		};
	}

	/** Present only when the base filesystem reads bytes; just-bash falls back to `readFileBuffer`. */
	readFileBytes?: (path: string) => Promise<ByteString>;

	async readFileBuffer(path: string) {
		return deviceAt(path) === 'file' ? new Uint8Array() : this.base.readFileBuffer(path);
	}

	async writeFile(
		path: string,
		content: Parameters<IFileSystem['writeFile']>[1],
		options?: Parameters<IFileSystem['writeFile']>[2],
	) {
		if (deviceAt(path) !== 'file') return this.base.writeFile(path, content, options);
	}

	async appendFile(
		path: string,
		content: Parameters<IFileSystem['appendFile']>[1],
		options?: Parameters<IFileSystem['appendFile']>[2],
	) {
		if (deviceAt(path) !== 'file') return this.base.appendFile(path, content, options);
	}

	async exists(path: string) {
		return deviceAt(path) !== undefined || this.base.exists(path);
	}

	async stat(path: string) {
		const kind = deviceAt(path);
		return kind ? statOf(kind) : this.base.stat(path);
	}

	async lstat(path: string) {
		const kind = deviceAt(path);
		return kind ? statOf(kind) : this.base.lstat(path);
	}

	async mkdir(path: string, options?: Parameters<IFileSystem['mkdir']>[1]) {
		const kind = deviceAt(path);
		if (kind === 'file' || (kind === 'directory' && !options?.recursive)) {
			throw exists(path, 'mkdir');
		}
		if (kind === undefined) return this.base.mkdir(path, options);
	}

	async readdir(path: string) {
		if (deviceAt(path) === 'directory') return [...DEVICES];
		const names = await this.base.readdir(path);
		const isRoot = posix.normalize(path) === '/';
		return isRoot && !names.includes('dev') ? [...names, 'dev'].sort() : names;
	}

	/** Present only when the base filesystem lists with types; just-bash falls back to `readdir`. */
	readdirWithFileTypes?: (path: string) => Promise<Dirent[]>;

	private async typedEntries(
		path: string,
		read: (path: string) => Promise<Dirent[]>,
	): Promise<Dirent[]> {
		if (deviceAt(path) === 'directory') {
			return DEVICES.map((name) => ({ name, ...KIND_FLAGS.file }));
		}
		const entries = await read(path);
		if (posix.normalize(path) !== '/' || entries.some((entry) => entry.name === 'dev')) {
			return entries;
		}
		return [...entries, { name: 'dev', ...KIND_FLAGS.directory }].sort((a, b) =>
			a.name.localeCompare(b.name),
		);
	}

	async rm(path: string, options?: Parameters<IFileSystem['rm']>[1]) {
		if (deviceAt(path) === undefined) return this.base.rm(path, options);
	}

	cp(src: string, dest: string, options?: Parameters<IFileSystem['cp']>[2]) {
		return this.base.cp(src, dest, options);
	}

	mv(src: string, dest: string) {
		return this.base.mv(src, dest);
	}

	resolvePath(base: string, path: string) {
		return this.base.resolvePath(base, path);
	}

	getAllPaths() {
		return this.base.getAllPaths();
	}

	async chmod(path: string, mode: number) {
		if (deviceAt(path) === undefined) return this.base.chmod(path, mode);
	}

	symlink(target: string, linkPath: string) {
		return this.base.symlink(target, linkPath);
	}

	link(existingPath: string, newPath: string) {
		return this.base.link(existingPath, newPath);
	}

	readlink(path: string) {
		return this.base.readlink(path);
	}

	async realpath(path: string) {
		return deviceAt(path) === undefined ? this.base.realpath(path) : posix.normalize(path);
	}

	async utimes(path: string, atime: Date, mtime: Date) {
		if (deviceAt(path) === undefined) return this.base.utimes(path, atime, mtime);
	}
}

/** Wrap a filesystem so `/dev` is a fixed device set below both `Bash` and `BashEnv`. */
export function withDevices(base: IFileSystem): IFileSystem {
	return new DeviceFs(base);
}
