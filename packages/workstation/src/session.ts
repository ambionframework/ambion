/**
 * One authenticated SSH client for one agent, with its SFTP channel and its
 * home.
 *
 * The client refuses a server whose host key does not match the pinned
 * fingerprint: `ssh2` accepts every host key when `hostVerifier` is unset,
 * so the session always sets it. The SFTP server starts in the account's
 * home, so `realpath('.')` reads the home once for the client's life.
 *
 * The session listens for `error` on the client, because an `error` event
 * with no listener stops the Node process. A client that errs, closes,
 * loses its SFTP channel, or cannot open a channel is closed for good; the
 * backend builds a new one on the next `connect()`.
 */

import { createHash } from 'node:crypto';
import { Client, type ClientChannel, type SFTPWrapper } from 'ssh2';
import { call } from './sftp.ts';

/** How long a connection may take to authenticate. */
const READY_TIMEOUT_MS = 20_000;
/** How often the client probes the server, so a dead connection surfaces as an error. */
const KEEPALIVE_MS = 15_000;

/** What one agent logs in with. */
export interface WorkstationCredential {
	readonly username: string;
	readonly privateKey: string;
	readonly passphrase?: string;
}

/** The server a session connects to. */
export interface ServerAddress {
	readonly host: string;
	readonly port: number;
	/** The pinned host key fingerprint, `SHA256:` then unpadded base64, as `ssh-keygen -lf` prints it. */
	readonly hostKey: string;
}

/** The fingerprint of a host key, in the form `ssh-keygen -lf` prints. */
export function fingerprint(key: Buffer): string {
	return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/** One live client for one agent. */
export class Session {
	private open = true;
	private readonly onEnd: Array<() => void> = [];
	private stop: (error: Error) => void = () => undefined;
	/**
	 * Rejects when the session ends. `ssh2` keeps an SFTP request on a dead
	 * channel pending forever, so `guard` races every call against it.
	 */
	private readonly ended = new Promise<never>((_, reject) => {
		this.stop = reject;
	});

	private constructor(
		private readonly client: Client,
		readonly sftp: SFTPWrapper,
		readonly home: string,
	) {
		// Swallow the rejection here; `guard` hands it to each caller.
		this.ended.catch(() => undefined);
		const end = () => this.end();
		client.on('error', end);
		client.on('close', end);
		// `client.sftp()` drops its own `error` listener once the channel is ready,
		// and `ssh2` emits `error` on a malformed SFTP packet.
		sftp.on('error', end);
		sftp.on('close', end);
	}

	/** Connect, authenticate, open SFTP, and read the home. */
	static async connect(
		address: ServerAddress,
		credential: WorkstationCredential,
		signal?: AbortSignal,
	): Promise<Session> {
		const client = await authenticated(address, credential, signal);
		try {
			const sftp = await call<SFTPWrapper>((done) => client.sftp(done));
			const home = await call<string>((done) => sftp.realpath('.', done));
			return new Session(client, sftp, home);
		} catch (error) {
			client.end();
			throw error;
		}
	}

	get closed(): boolean {
		return !this.open;
	}

	/** Run `fn` once, when the session ends for any reason. */
	whenEnded(fn: () => void): void {
		if (this.open) this.onEnd.push(fn);
		else fn();
	}

	/** `work`, or a rejection as soon as the session ends. */
	guard<T>(work: () => Promise<T>): Promise<T> {
		if (!this.open) return Promise.reject(closedError());
		return Promise.race([work(), this.ended]);
	}

	/**
	 * Open one `exec` channel with no terminal. A client that cannot open a
	 * channel closes, and the next `connect()` builds a new one.
	 */
	async exec(command: string): Promise<ClientChannel> {
		try {
			return await this.guard(() => call<ClientChannel>((done) => this.client.exec(command, done)));
		} catch (error) {
			this.close();
			throw error;
		}
	}

	close(): void {
		this.client.end();
		this.end();
	}

	private end(): void {
		if (!this.open) return;
		this.open = false;
		this.stop(closedError());
		for (const fn of this.onEnd.splice(0)) fn();
	}
}

/** The error of a call that the session's end cut short. */
export class ConnectionClosed extends Error {
	constructor() {
		super('The workstation connection closed.');
		this.name = 'ConnectionClosed';
	}
}

const closedError = () => new ConnectionClosed();

/** A client that has authenticated, or a rejection that names why it did not. */
function authenticated(
	address: ServerAddress,
	credential: WorkstationCredential,
	signal: AbortSignal | undefined,
): Promise<Client> {
	return new Promise<Client>((resolve, reject) => {
		const client = new Client();
		let mismatch: string | undefined;
		const abort = () => {
			client.end();
			reject(signal?.reason ?? new Error('Connection aborted.'));
		};
		if (signal?.aborted) return abort();
		signal?.addEventListener('abort', abort, { once: true });
		const settle = () => signal?.removeEventListener('abort', abort);
		client.once('ready', () => {
			settle();
			// Each SFTP call waits for its answer. Nagle's algorithm holds a small
			// request until the last one is acknowledged, which adds tens of
			// milliseconds to every call.
			client.setNoDelay(true);
			resolve(client);
		});
		client.once('error', (error) => {
			settle();
			reject(mismatch === undefined ? error : new Error(mismatch));
		});
		const options = {
			host: address.host,
			port: address.port,
			username: credential.username,
			privateKey: credential.privateKey,
			...(credential.passphrase === undefined ? {} : { passphrase: credential.passphrase }),
			hostVerifier: (key: Buffer) => {
				const offered = fingerprint(key);
				if (offered === address.hostKey) return true;
				mismatch = `The host key of ${address.host} is ${offered}, and the workstation pins ${address.hostKey}.`;
				return false;
			},
			readyTimeout: READY_TIMEOUT_MS,
			keepaliveInterval: KEEPALIVE_MS,
		};
		try {
			client.connect(options);
		} catch (error) {
			// `ssh2` throws at once for a key it cannot read.
			settle();
			reject(error);
		}
	});
}
