/**
 * The scripted tier's SSH server: an `ssh2` `Server` in the test process.
 *
 * Its SFTP handlers read and write real paths on the local disk, and each
 * account gets a temporary home of its own. Each `exec` runs `sh -c` in that
 * home, the way `sshd` runs the login shell. Every account maps to the one
 * user that runs the test, so the tier tests no permission.
 *
 * The handlers answer with the status codes that OpenSSH's `sftp-server`
 * gives for each `errno`, so the backend's `lstat` classification runs the
 * same path as on a real server. The server announces no SFTP extension, so
 * the backend falls back to a plain `RENAME`. The handler replaces an
 * existing target, as `rename(2)` does.
 */

import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ssh2, { type Connection, type ServerChannel } from 'ssh2';
import { fingerprint, type WorkstationOptions } from '../../src/index.ts';
import { serveSftp } from './sftp-server.ts';

const { Server, utils } = ssh2;

/** A running test server and the options that reach it. */
export interface TestServer {
	/** Options for `workstationBackend`, one account for each name the server started with. */
	readonly options: WorkstationOptions;
	/** Each account's home, by name. */
	readonly homes: ReadonlyMap<string, string>;
	/** How many times a client has authenticated, by account. */
	readonly logins: Map<string, number>;
	/** End every client connection the server holds, as a dropped network would. */
	dropClients(): void;
	/** Refuse each new session channel while `refuse` is true, as a full `MaxSessions` would. */
	refuseChannels(refuse: boolean): void;
	stop(): Promise<void>;
}

function sameBytes(a: Buffer, b: Buffer): boolean {
	return a.length === b.length && timingSafeEqual(a, b);
}

type Parsed = Exclude<ReturnType<typeof utils.parseKey>, Error>;

function parsed(key: string): Parsed {
	const result = utils.parseKey(key);
	if (result instanceof Error) throw result;
	return Array.isArray(result) ? (result[0] as Parsed) : result;
}

/**
 * An Ed25519 pair that `ssh2` reads back. Its generator drops a leading zero
 * byte of the public key, about once in 256 pairs, and `parseKey` then
 * refuses both halves. A key from `ssh-keygen` has no such fault.
 */
function ed25519Pair(): { private: string; public: string } {
	for (;;) {
		const pair = utils.generateKeyPairSync('ed25519');
		const readable = [pair.private, pair.public].every(
			(key) => !(utils.parseKey(key) instanceof Error),
		);
		if (readable) return pair;
	}
}

/** Run one `exec` request as `sh -c` in the account's home, and pipe it both ways. */
function runExec(stream: ServerChannel, command: string, home: string): void {
	const child = spawn('sh', ['-c', command], { cwd: home, env: { ...process.env, HOME: home } });
	child.stdout.pipe(stream, { end: false });
	child.stderr.pipe(stream.stderr, { end: false });
	stream.pipe(child.stdin);
	child.on('close', (code, signal) => {
		if (signal) stream.exit(signal.replace(/^SIG/, ''), false, '');
		else stream.exit(code ?? 1);
		stream.end();
	});
}

interface ServerState {
	readonly homes: Map<string, string>;
	readonly logins: Map<string, number>;
	readonly key: Parsed;
	refuse: boolean;
}

function onClient(client: Connection, state: ServerState) {
	const { homes, logins, key } = state;
	let account: string | undefined;
	client.on('authentication', (ctx) => {
		const home = homes.get(ctx.username);
		if (ctx.method !== 'publickey' || home === undefined) return ctx.reject(['publickey']);
		const matches = ctx.key.algo === key.type && sameBytes(ctx.key.data, key.getPublicSSH());
		if (!matches) return ctx.reject(['publickey']);
		if (ctx.signature && ctx.blob && key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) {
			return ctx.reject(['publickey']);
		}
		account = ctx.username;
		if (ctx.signature) logins.set(ctx.username, (logins.get(ctx.username) ?? 0) + 1);
		ctx.accept();
	});
	client.on('ready', () => {
		client.on('session', (accept, reject) => {
			if (state.refuse) return reject();
			const session = accept();
			const home = homes.get(account ?? '') ?? '/';
			session.on('exec', (acceptExec, _reject, info) => runExec(acceptExec(), info.command, home));
			session.on('sftp', (acceptSftp) => serveSftp(acceptSftp(), home));
		});
	});
	client.on('error', () => undefined);
}

/** Start a server with one account, and one home, for each name. */
export async function startSshServer(accounts: readonly string[]): Promise<TestServer> {
	const hostKey = ed25519Pair();
	const clientKey = ed25519Pair();
	const allowed = parsed(clientKey.public);
	const homes = new Map<string, string>();
	for (const name of accounts) {
		homes.set(name, await realpath(await mkdtemp(join(tmpdir(), `ambion-ws-${name}-`))));
	}
	const logins = new Map<string, number>();
	const clients = new Set<Connection>();
	const state: ServerState = { homes, logins, key: allowed, refuse: false };
	const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
		// The server side of a connection has `setNoDelay` at runtime, and its types omit it.
		(client as Connection & { setNoDelay(on: boolean): void }).setNoDelay(true);
		clients.add(client);
		client.on('close', () => clients.delete(client));
		onClient(client, state);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	const shared = await realpath(await mkdtemp(join(tmpdir(), 'ambion-ws-shared-')));
	return {
		options: {
			host: '127.0.0.1',
			port,
			hostKey: fingerprint(parsed(hostKey.public).getPublicSSH()),
			layout: { audit: join(shared, 'audit', 'audit.jsonl'), rooms: join(shared, 'rooms') },
			credentialFor: (agent) => ({ username: agent.name, privateKey: clientKey.private }),
		},
		homes,
		logins,
		dropClients: () => {
			for (const client of clients) client.end();
		},
		refuseChannels: (refuse) => {
			state.refuse = refuse;
		},
		stop: async () => {
			for (const client of clients) client.end();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			for (const dir of [...homes.values(), shared])
				await rm(dir, { recursive: true, force: true });
		},
	};
}
