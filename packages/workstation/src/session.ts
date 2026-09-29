/**
 * One authenticated SSH client for one agent, with its SFTP channel and its
 * home.
 *
 * The client refuses a server whose host key does not match the pinned
 * fingerprint: `ssh2` accepts every host key when `hostVerifier` is unset,
 * so the session always sets it. The session keeps the key that it
 * verified, for a `known_hosts` line. The SFTP server starts in the account's
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

/** A host key as a `known_hosts` line shows it: the key type, a space, and the base64 key. */
function hostKeyText(key: Buffer): string {
	const length = key.readUInt32BE(0);
	return `${key.subarray(4, 4 + length).toString('latin1')} ${key.toString('base64')}`;
}

/** One live client for one agent. */
export class Session {
	private open = true;
	private readonly onEnd = new Set<() => void>();
	private stop: (error: Error) => void = () => undefined;
	/**
	 * Rejects when the session ends. `ssh2` fails the SFTP requests in flight
	 * when the channel closes, and keeps a request made after that pending
	 * forever, so `guard` races every call against it.
	 */
	private readonly ended = new Promise<never>((_, reject) => {
		this.stop = reject;
	});

	private constructor(
		private readonly client: Client,
		readonly sftp: SFTPWrapper,
		readonly home: string,
		/** The host key that the client verified, as `hostKeyText` renders it. */
		readonly hostKey: string,
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
		const { client, hostKey } = await authenticated(address, credential, signal);
		try {
			const sftp = await setupCall(
				client,
				call<SFTPWrapper>((done) => client.sftp(done)),
				signal,
			);
			const home = await setupCall(
				client,
				call<string>((done) => sftp.realpath('.', done)),
				signal,
				sftp,
			);
			return new Session(client, sftp, home, hostKeyText(hostKey));
		} catch (error) {
			client.end();
			throw error;
		}
	}

	get closed(): boolean {
		return !this.open;
	}

	/** Run `fn` once, when the session ends for any reason. */
	whenEnded(fn: () => void): () => void {
		if (this.open) {
			this.onEnd.add(fn);
			return () => this.onEnd.delete(fn);
		}
		fn();
		return () => undefined;
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

	/** Open one SSH direct-tcpip channel to the workstation's loopback. */
	async forwardOut(port: number, signal?: AbortSignal): Promise<ClientChannel> {
		if (!this.open) throw new ConnectionClosed();
		if (signal?.aborted) throw signal.reason ?? new Error('Port opening aborted.');
		return new Promise<ClientChannel>((resolve, reject) => {
			let settled = false;
			let removeEnd: () => void = () => {};
			const finish = (error?: Error, channel?: ClientChannel) => {
				if (settled) {
					if (channel !== undefined) drainAndDestroy(channel);
					return;
				}
				settled = true;
				signal?.removeEventListener('abort', abort);
				removeEnd();
				settleForward(error, channel, this.open, resolve, reject);
			};
			const abort = () =>
				finish(
					signal?.reason instanceof Error ? signal.reason : new Error('Port opening aborted.'),
				);
			const ended = () => finish(closedError());
			signal?.addEventListener('abort', abort, { once: true });
			removeEnd = this.whenEnded(ended);
			try {
				this.client.forwardOut('127.0.0.1', 0, '127.0.0.1', port, (error, channel) =>
					finish(error ?? undefined, channel),
				);
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	close(): void {
		this.client.end();
		this.end();
	}

	private end(): void {
		if (!this.open) return;
		this.open = false;
		this.stop(closedError());
		for (const fn of this.onEnd) fn();
		this.onEnd.clear();
	}
}

function settleForward(
	error: Error | undefined,
	channel: ClientChannel | undefined,
	open: boolean,
	resolve: (channel: ClientChannel) => void,
	reject: (error: Error) => void,
): void {
	if (error !== undefined) {
		if (channel !== undefined) drainAndDestroy(channel);
		reject(error);
		return;
	}
	if (channel === undefined) {
		reject(new Error('SSH returned no forwarding channel.'));
		return;
	}
	if (!open) {
		drainAndDestroy(channel);
		reject(closedError());
		return;
	}
	channel.on('error', () => undefined);
	resolve(channel);
}

function drainAndDestroy(channel: ClientChannel): void {
	channel.unpipe();
	channel.resume();
	channel.destroy();
}

/** The error of a call that the session's end cut short. */
export class ConnectionClosed extends Error {
	constructor() {
		super('The workstation connection closed.');
		this.name = 'ConnectionClosed';
	}
}

const closedError = () => new ConnectionClosed();

/** Reject an SFTP setup stage when its authenticated SSH client ends. */
async function setupCall<T>(
	client: Client,
	work: Promise<T>,
	signal: AbortSignal | undefined,
	sftp?: SFTPWrapper,
): Promise<T> {
	let fail: (error: Error) => void = () => {};
	const disconnected = new Promise<T>((_, reject) => {
		fail = reject;
	});
	const failed = (error: Error) => fail(error);
	const closed = () => fail(closedError());
	client.on('error', failed);
	client.on('close', closed);
	sftp?.on('error', failed);
	sftp?.on('close', closed);
	try {
		return await abortable(Promise.race([work, disconnected]), signal, () => client.end());
	} finally {
		client.off('error', failed);
		client.off('close', closed);
		sftp?.off('error', failed);
		sftp?.off('close', closed);
	}
}

/** Race one SSH setup stage against cancellation, and release its client on abort. */
function abortable<T>(
	work: Promise<T>,
	signal: AbortSignal | undefined,
	cleanup: () => void,
): Promise<T> {
	if (signal === undefined) return work;
	if (signal.aborted) {
		cleanup();
		void work.catch(() => undefined);
		return Promise.reject(signal.reason ?? new Error('Connection aborted.'));
	}
	return new Promise<T>((resolve, reject) => {
		const abort = () => {
			cleanup();
			reject(signal.reason ?? new Error('Connection aborted.'));
		};
		signal.addEventListener('abort', abort, { once: true });
		work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
	});
}

/** A client that has authenticated, and the host key it verified. */
interface Authenticated {
	readonly client: Client;
	readonly hostKey: Buffer;
}

/** A client that has authenticated, or a rejection that names why it did not. */
function authenticated(
	address: ServerAddress,
	credential: WorkstationCredential,
	signal: AbortSignal | undefined,
): Promise<Authenticated> {
	return new Promise<Authenticated>((resolve, reject) => {
		const client = new Client();
		// Keep the event handled between authentication and Session construction.
		client.on('error', () => undefined);
		let mismatch: string | undefined;
		let verified: Buffer = Buffer.alloc(0);
		const abort = () => {
			client.end();
			reject(signal?.reason ?? new Error('Connection aborted.'));
		};
		const failure = (error: Error) => {
			settle();
			client.end();
			reject(mismatch === undefined ? error : new Error(mismatch));
		};
		const closed = () => failure(closedError());
		if (signal?.aborted) return abort();
		signal?.addEventListener('abort', abort, { once: true });
		const settle = () => {
			signal?.removeEventListener('abort', abort);
			client.off('error', failure);
			client.off('close', closed);
		};
		client.once('ready', () => {
			settle();
			// Each SFTP call waits for its answer. Nagle's algorithm holds a small
			// request until the last one is acknowledged, which adds tens of
			// milliseconds to every call.
			client.setNoDelay(true);
			resolve({ client, hostKey: verified });
		});
		client.on('error', failure);
		client.once('close', closed);
		const options = {
			host: address.host,
			port: address.port,
			username: credential.username,
			privateKey: credential.privateKey,
			...(credential.passphrase === undefined ? {} : { passphrase: credential.passphrase }),
			hostVerifier: (key: Buffer) => {
				const offered = fingerprint(key);
				if (offered === address.hostKey) {
					verified = key;
					return true;
				}
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
			failure(error instanceof Error ? error : new Error(String(error)));
		}
	});
}
