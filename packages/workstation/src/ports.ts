import { createServer, type Server, type Socket } from 'node:net';
import type { WorkspacePort } from '@ambionframework/workspace';
import type { ClientChannel } from 'ssh2';
import { ConnectionClosed, type Session } from './session.ts';

/** ssh2 waits for peer close and readable end, so bound cleanup against a silent peer. */
const CHANNEL_CLOSE_GRACE_MS = 250;

interface PortResources {
	server: Server | undefined;
	readonly sockets: Set<Socket>;
	readonly channels: Set<ClientChannel>;
	readonly pending: Set<Promise<ClientChannel>>;
	closed: boolean;
	closing: Promise<void> | undefined;
	removeEnd: () => void;
	untrack: () => void;
}

/** Open one remote loopback service through an existing agent session. */
export async function openWorkspacePort(
	session: Session,
	remotePort: number,
	signal: AbortSignal | undefined,
	release: () => void,
	track: (close: () => Promise<void>) => () => void,
): Promise<WorkspacePort> {
	const resources: PortResources = {
		server: undefined,
		sockets: new Set(),
		channels: new Set(),
		pending: new Set(),
		closed: false,
		closing: undefined,
		removeEnd: () => {},
		untrack: () => {},
	};
	const setup = new AbortController();
	const abortSetup = () => setup.abort(signal?.reason ?? new Error('Port setup closed.'));
	const close = createPortCloser(resources, setup, signal, release, track, abortSetup);
	if (signal?.aborted) setup.abort(signal.reason);
	signal?.addEventListener('abort', abortSetup, { once: true });
	resources.removeEnd = session.whenEnded(() => void close());
	try {
		ensureOpen(resources, session, setup.signal);
		const localPort = await listenLoopback(resources, session, remotePort, setup, close);
		const probe = await probeForward(session, remotePort, setup.signal);
		probe.on('error', () => undefined);
		await closeChannel(probe);
		ensureOpen(resources, session, setup.signal);
		signal?.removeEventListener('abort', abortSetup);
		return { url: `http://127.0.0.1:${localPort}/`, close };
	} catch (error) {
		await close();
		throw error;
	}
}

async function listenLoopback(
	resources: PortResources,
	session: Session,
	remotePort: number,
	setup: AbortController,
	close: () => Promise<void>,
): Promise<number> {
	resources.server = createServer((socket) =>
		forwardSocket(session, remotePort, socket, resources, close),
	);
	resources.server.on('error', (error) => {
		setup.abort(error);
		void close();
	});
	await listen(resources.server, setup.signal);
	const address = resources.server.address();
	if (address === null || typeof address === 'string') {
		throw new Error('The private workstation port listener has no TCP address.');
	}
	return address.port;
}

function ensureOpen(resources: PortResources, session: Session, signal: AbortSignal): void {
	if (resources.closed || session.closed) throw new ConnectionClosed();
	if (signal.aborted) throw signal.reason ?? new Error('Port opening aborted.');
}

function probeForward(session: Session, port: number, signal: AbortSignal): Promise<ClientChannel> {
	const probe = session.forwardOut(port, signal).catch((error: unknown) => {
		if (signal.aborted) throw signal.reason ?? error;
		if (error instanceof ConnectionClosed) throw error;
		throw forwardingRefused(port, error);
	});
	return waitFor(probe, signal, (channel) => void closeChannel(channel));
}

function createPortCloser(
	resources: PortResources,
	setup: AbortController,
	signal: AbortSignal | undefined,
	release: () => void,
	track: (close: () => Promise<void>) => () => void,
	abortSetup: () => void,
): () => Promise<void> {
	const close = (): Promise<void> => {
		if (resources.closing !== undefined) return resources.closing;
		resources.closed = true;
		setup.abort(new Error('Port closed.'));
		signal?.removeEventListener('abort', abortSetup);
		resources.removeEnd();
		for (const socket of resources.sockets) socket.destroy();
		resources.closing = (async () => {
			if (resources.server?.listening) {
				await new Promise<void>((resolve) => resources.server?.close(() => resolve()));
			}
			await Promise.allSettled([...resources.pending]);
			await Promise.all([...resources.channels].map(closeChannel));
			release();
			resources.untrack();
		})();
		return resources.closing;
	};
	resources.untrack = track(close);
	return close;
}

function forwardSocket(
	session: Session,
	remotePort: number,
	socket: Socket,
	resources: PortResources,
	close: () => Promise<void>,
): void {
	resources.sockets.add(socket);
	socket.once('close', () => resources.sockets.delete(socket));
	if (resources.closed || session.closed) {
		socket.destroy();
		return;
	}
	socket.on('error', () => socket.destroy());
	const controller = new AbortController();
	socket.once('close', () => controller.abort(new Error('Local port request closed.')));
	const forwarding = session.forwardOut(remotePort, controller.signal);
	resources.pending.add(forwarding);
	void forwarding.then(
		(channel) => attachForward(channel, socket, resources, forwarding, close, controller.signal),
		() => failedForward(socket, controller, forwarding, resources.pending, close),
	);
}

function attachForward(
	channel: ClientChannel,
	socket: Socket,
	resources: PortResources,
	forwarding: Promise<ClientChannel>,
	close: () => Promise<void>,
	signal: AbortSignal,
): void {
	resources.channels.add(channel);
	resources.pending.delete(forwarding);
	channel.once('close', () => resources.channels.delete(channel));
	channel.on('error', () => {
		socket.destroy();
		void close();
	});
	if (resources.closed || socket.destroyed) {
		void closeChannel(channel);
		return;
	}
	channel.once('close', () => socket.destroy());
	socket.once('close', () => void closeChannel(channel));
	channel.pipe(socket);
	socket.pipe(channel);
	if (signal.aborted) void closeChannel(channel);
}

function failedForward(
	socket: Socket,
	controller: AbortController,
	forwarding: Promise<ClientChannel>,
	pending: Set<Promise<ClientChannel>>,
	close: () => Promise<void>,
): void {
	pending.delete(forwarding);
	const canceled = controller.signal.aborted || socket.destroyed;
	socket.destroy();
	if (!canceled) void close();
}

function waitFor<T>(
	work: Promise<T>,
	signal: AbortSignal | undefined,
	onLate?: (value: T) => void,
): Promise<T> {
	if (signal === undefined) return work;
	if (signal.aborted) {
		void work.then(onLate, () => undefined);
		return Promise.reject(signal.reason ?? new Error('Operation aborted.'));
	}
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const abort = () => {
			if (settled) return;
			settled = true;
			reject(signal.reason ?? new Error('Operation aborted.'));
		};
		signal.addEventListener('abort', abort, { once: true });
		work.then(
			(value) => {
				if (settled) onLate?.(value);
				else {
					settled = true;
					signal.removeEventListener('abort', abort);
					resolve(value);
				}
			},
			(error: unknown) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener('abort', abort);
				reject(error);
			},
		);
	});
}

function listen(server: Server, signal: AbortSignal | undefined): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const cleanup = () => {
			server.off('listening', listening);
			server.off('error', failed);
			signal?.removeEventListener('abort', aborted);
		};
		const listening = () => {
			cleanup();
			resolve();
		};
		const failed = (error: Error) => {
			cleanup();
			reject(error);
		};
		const aborted = () => {
			cleanup();
			server.close();
			reject(signal?.reason ?? new Error('Port opening aborted.'));
		};
		if (signal?.aborted) return aborted();
		server.once('listening', listening);
		server.once('error', failed);
		signal?.addEventListener('abort', aborted, { once: true });
		server.listen(0, '127.0.0.1');
	});
}

function forwardingRefused(port: number, error: unknown): Error {
	const detail = error instanceof Error ? error.message : String(error);
	return new Error(`SSH port forwarding to workstation 127.0.0.1:${port} was refused: ${detail}`, {
		cause: error,
	});
}

function closeChannel(channel: ClientChannel): Promise<void> {
	if (channel.destroyed) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const finish = () => {
			clearTimeout(timer);
			channel.off('close', finish);
			resolve();
		};
		const timer = setTimeout(finish, CHANNEL_CLOSE_GRACE_MS);
		timer.unref();
		channel.once('close', finish);
		channel.unpipe();
		channel.resume();
		channel.destroy();
	});
}
