/**
 * Where Pi keeps the sign-in of a subscription provider.
 *
 * An OAuth sign-in rotates its refresh token on every refresh. A store that
 * loses a rotated token locks the account out until the next sign-in, so the
 * store writes each change through a lock and a rename. The store loads the
 * Node file system on first use, so the entry of this package loads on a
 * host with no disk.
 */
import type {
	AuthOperationOptions,
	Credential,
	CredentialInfo,
	CredentialStore,
} from '@earendil-works/pi-ai';

/** The file content: one credential for each provider id. */
type Credentials = Record<string, Credential>;

/** How long a process waits for the lock, and how old a lock must be before another process takes it. */
const LOCK_WAIT_MS = 30_000;
const LOCK_STALE_MS = 60_000;
const LOCK_RETRY_MS = 50;

/** The tail of the writes in this process for each file. */
const tails = new Map<string, Promise<unknown>>();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Whether `error` is a Node error with the code `code`. */
const hasCode = (error: unknown, code: string) =>
	typeof error === 'object' && error !== null && 'code' in error && error.code === code;

/** Read the file. A file that does not exist holds no credential. */
async function load(path: string): Promise<Credentials> {
	const { readFile } = await import('node:fs/promises');
	try {
		return JSON.parse(await readFile(path, 'utf8')) as Credentials;
	} catch (error) {
		if (hasCode(error, 'ENOENT')) return {};
		throw new Error(`The credential file '${path}' cannot be read: ${String(error)}`);
	}
}

/** Write the whole file with access for its owner only, in one rename. A failed write leaves no temporary file. */
async function save(path: string, credentials: Credentials): Promise<void> {
	const { rename, rm, writeFile } = await import('node:fs/promises');
	const temporary = `${path}.${process.pid}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(credentials, null, '\t')}\n`, { mode: 0o600 });
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

/** Whether the file is older than `LOCK_STALE_MS`: its process died. A file that is gone is not stale. */
async function stale(file: string): Promise<boolean> {
	const { stat } = await import('node:fs/promises');
	const age = await stat(file).then(
		(stats) => Date.now() - stats.mtimeMs,
		() => 0,
	);
	return age > LOCK_STALE_MS;
}

/** Create the lock file with the token of its owner, or answer `false` when another process holds it. */
async function create(lock: string, token: string): Promise<boolean> {
	const { writeFile } = await import('node:fs/promises');
	try {
		await writeFile(lock, token, { flag: 'wx', mode: 0o600 });
		return true;
	} catch (error) {
		if (hasCode(error, 'EEXIST')) return false;
		throw error;
	}
}

/**
 * Take a stale lock away. The rename lets one waiter win. A waiter that read
 * its age before another waiter made a fresh lock renames the fresh one, so
 * it links that file back, and the owner keeps its lock.
 */
async function steal(lock: string, token: string): Promise<void> {
	const { link, rename, unlink } = await import('node:fs/promises');
	const taken = `${lock}.${token}.stale`;
	try {
		await rename(lock, taken);
	} catch {
		return;
	}
	if (!(await stale(taken))) await link(taken, lock).catch(() => undefined);
	await unlink(taken).catch(() => undefined);
}

/** Take the lock file, and wait for the process that holds it. */
async function acquire(lock: string, token: string, signal: AbortSignal | undefined) {
	const deadline = Date.now() + LOCK_WAIT_MS;
	signal?.throwIfAborted();
	while (!(await create(lock, token))) {
		signal?.throwIfAborted();
		if (await stale(lock)) await steal(lock, token);
		else if (Date.now() > deadline) throw new Error(`The credential lock '${lock}' stays held.`);
		else await sleep(LOCK_RETRY_MS);
	}
}

/** Remove the lock file when this process still owns it. A stolen lock belongs to its new owner. */
async function release(lock: string, token: string): Promise<void> {
	const { readFile, unlink } = await import('node:fs/promises');
	const owner = await readFile(lock, 'utf8').catch(() => undefined);
	if (owner === token) await unlink(lock).catch(() => undefined);
}

/** Run `work` after every earlier write to the file in this process and in any other. */
async function exclusive<T>(
	path: string,
	options: AuthOperationOptions | undefined,
	work: () => Promise<T>,
): Promise<T> {
	const run = async (): Promise<T> => {
		const { mkdir } = await import('node:fs/promises');
		const { dirname } = await import('node:path');
		const { randomUUID } = await import('node:crypto');
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		const lock = `${path}.lock`;
		const token = `${process.pid}-${randomUUID()}`;
		await acquire(lock, token, options?.signal);
		try {
			return await work();
		} finally {
			await release(lock, token);
		}
	};
	const next = (tails.get(path) ?? Promise.resolve()).then(run, run);
	tails.set(
		path,
		next.catch(() => undefined),
	);
	return next;
}

/**
 * A credential store in one JSON file, keyed by provider id. Pass it as
 * `credentials` to `piExecution`, and to `loginPi` to sign in. The file
 * holds secrets: the store creates it with mode `0600`, and a directory that it
 * creates gets mode `0700`. The store serializes writes in this process and,
 * through a lock file, across processes on the same disk. A second host needs its own file,
 * or a store of its own that shares one.
 */
export function fileCredentials(path: string): CredentialStore {
	return {
		read: async (providerId) => (await load(path))[providerId],
		list: async (): Promise<readonly CredentialInfo[]> =>
			Object.entries(await load(path)).map(([providerId, { type }]) => ({ providerId, type })),
		modify: (providerId, fn, options) =>
			exclusive(path, options, async () => {
				const all = await load(path);
				const next = await fn(all[providerId]);
				if (next === undefined) return all[providerId];
				await save(path, { ...all, [providerId]: next });
				return next;
			}),
		delete: (providerId, options) =>
			exclusive(path, options, async () => {
				const { [providerId]: _removed, ...rest } = await load(path);
				await save(path, rest);
			}),
	};
}
