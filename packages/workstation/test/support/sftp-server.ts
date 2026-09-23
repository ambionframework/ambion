/**
 * SFTP handlers over the local disk, for the scripted tier's SSH server.
 *
 * A relative path resolves against the account's home, where OpenSSH's
 * `sftp-server` starts. Each error answers with the status that
 * `sftp-server` gives for its `errno` (`errno_to_portable` in OpenSSH), so
 * `ENOTDIR` reads as `NO_SUCH_FILE`, and `EISDIR`, `EEXIST`, and `ENOTEMPTY`
 * read as `FAILURE`.
 */

import { type Dirent, promises as fs, type Stats } from 'node:fs';
import { posix } from 'node:path';
import ssh2, { type Attributes, type SFTPWrapper } from 'ssh2';

const { STATUS_CODE, flagsToString } = ssh2.utils.sftp;

/** The status OpenSSH's `sftp-server` gives for an `errno`. */
function statusFor(error: unknown): number {
	switch ((error as NodeJS.ErrnoException).code) {
		case 'ENOENT':
		case 'ENOTDIR':
		case 'EBADF':
		case 'ELOOP':
			return STATUS_CODE.NO_SUCH_FILE;
		case 'EPERM':
		case 'EACCES':
			return STATUS_CODE.PERMISSION_DENIED;
		case 'ENAMETOOLONG':
		case 'EINVAL':
			return STATUS_CODE.BAD_MESSAGE;
		default:
			return STATUS_CODE.FAILURE;
	}
}

function attrsOf(stats: Stats): Attributes {
	return {
		mode: stats.mode,
		uid: stats.uid,
		gid: stats.gid,
		size: stats.size,
		atime: Math.floor(stats.atimeMs / 1000),
		mtime: Math.floor(stats.mtimeMs / 1000),
	};
}

type Handle =
	| { kind: 'file'; fd: fs.FileHandle }
	| { kind: 'dir'; path: string; entries: Dirent[] | undefined };

/** Serve one SFTP session over the local disk, rooted at `home` for relative paths. */
export function serveSftp(sftp: SFTPWrapper, home: string): void {
	const handles = new Map<string, Handle>();
	let next = 0;
	const at = (path: string) => posix.resolve(home, path);
	const newHandle = (handle: Handle): Buffer => {
		next += 1;
		const id = String(next);
		handles.set(id, handle);
		return Buffer.from(id);
	};
	/** Answer `reqid` with what `work` gives, or with the status for what it throws. */
	const answer = (reqid: number, work: () => Promise<void>) => {
		work().catch((error: unknown) => sftp.status(reqid, statusFor(error), String(error)));
	};
	const ok = (reqid: number) => sftp.status(reqid, STATUS_CODE.OK);

	sftp.on('OPEN', (reqid, filename, flags, attrs) =>
		answer(reqid, async () => {
			const mode = typeof attrs.mode === 'number' ? attrs.mode : 0o666;
			const fd = await fs.open(at(filename), flagsToString(flags) ?? 'r', mode);
			sftp.handle(reqid, newHandle({ kind: 'file', fd }));
		}),
	);
	sftp.on('READ', (reqid, handle, offset, length) =>
		answer(reqid, async () => {
			const open = handles.get(handle.toString());
			if (open?.kind !== 'file') return void sftp.status(reqid, STATUS_CODE.FAILURE);
			const buffer = Buffer.alloc(length);
			const { bytesRead } = await open.fd.read(buffer, 0, length, offset);
			if (bytesRead === 0) return void sftp.status(reqid, STATUS_CODE.EOF);
			sftp.data(reqid, buffer.subarray(0, bytesRead));
		}),
	);
	sftp.on('WRITE', (reqid, handle, offset, data) =>
		answer(reqid, async () => {
			const open = handles.get(handle.toString());
			if (open?.kind !== 'file') return void sftp.status(reqid, STATUS_CODE.FAILURE);
			await open.fd.write(data, 0, data.length, offset);
			ok(reqid);
		}),
	);
	sftp.on('FSTAT', (reqid, handle) =>
		answer(reqid, async () => {
			const open = handles.get(handle.toString());
			if (open?.kind !== 'file') return void sftp.status(reqid, STATUS_CODE.FAILURE);
			sftp.attrs(reqid, attrsOf(await open.fd.stat()));
		}),
	);
	sftp.on('CLOSE', (reqid, handle) =>
		answer(reqid, async () => {
			const open = handles.get(handle.toString());
			handles.delete(handle.toString());
			if (open?.kind === 'file') await open.fd.close();
			ok(reqid);
		}),
	);
	serveNames(sftp, handles, at, newHandle, answer, ok);
}

/** The handlers that take a path: directories, metadata, and the name changes. */
function serveNames(
	sftp: SFTPWrapper,
	handles: Map<string, Handle>,
	at: (path: string) => string,
	newHandle: (handle: Handle) => Buffer,
	answer: (reqid: number, work: () => Promise<void>) => void,
	ok: (reqid: number) => void,
): void {
	sftp.on('OPENDIR', (reqid, path) =>
		answer(reqid, async () => {
			const dir = at(path);
			if (!(await fs.stat(dir)).isDirectory())
				return void sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
			sftp.handle(reqid, newHandle({ kind: 'dir', path: dir, entries: undefined }));
		}),
	);
	sftp.on('READDIR', (reqid, handle) =>
		answer(reqid, async () => {
			const open = handles.get(handle.toString());
			if (open?.kind !== 'dir') return void sftp.status(reqid, STATUS_CODE.FAILURE);
			if (open.entries !== undefined) return void sftp.status(reqid, STATUS_CODE.EOF);
			open.entries = await fs.readdir(open.path, { withFileTypes: true });
			const names = await Promise.all(
				open.entries.map(async (entry) => ({
					filename: entry.name,
					longname: entry.name,
					attrs: attrsOf(await fs.lstat(posix.join(open.path, entry.name))),
				})),
			);
			if (names.length === 0) return void sftp.status(reqid, STATUS_CODE.EOF);
			sftp.name(reqid, names);
		}),
	);
	sftp.on('LSTAT', (reqid, path) =>
		answer(reqid, async () => sftp.attrs(reqid, attrsOf(await fs.lstat(at(path))))),
	);
	sftp.on('STAT', (reqid, path) =>
		answer(reqid, async () => sftp.attrs(reqid, attrsOf(await fs.stat(at(path))))),
	);
	sftp.on('SETSTAT', (reqid) => ok(reqid));
	sftp.on('FSETSTAT', (reqid) => ok(reqid));
	sftp.on('MKDIR', (reqid, path, attrs) =>
		answer(reqid, async () => {
			await fs.mkdir(at(path), { mode: typeof attrs.mode === 'number' ? attrs.mode : 0o777 });
			ok(reqid);
		}),
	);
	sftp.on('RMDIR', (reqid, path) =>
		answer(reqid, async () => {
			await fs.rmdir(at(path));
			ok(reqid);
		}),
	);
	sftp.on('REMOVE', (reqid, path) =>
		answer(reqid, async () => {
			await fs.unlink(at(path));
			ok(reqid);
		}),
	);
	sftp.on('RENAME', (reqid, from, to) =>
		answer(reqid, async () => {
			await fs.rename(at(from), at(to));
			ok(reqid);
		}),
	);
	sftp.on('REALPATH', (reqid, path) =>
		answer(reqid, async () => {
			const resolved = await realpathAllowingLast(at(path));
			sftp.name(reqid, [{ filename: resolved, longname: resolved, attrs: {} as Attributes }]);
		}),
	);
}

/** OpenSSH's `realpath` accepts a missing last component, so a new file can be named. */
async function realpathAllowingLast(path: string): Promise<string> {
	try {
		return await fs.realpath(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		return posix.join(await fs.realpath(posix.dirname(path)), posix.basename(path));
	}
}
