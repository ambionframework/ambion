/**
 * The host side of the local socket.
 *
 * One bridge serves one activation. The room tools server that Codex spawns
 * connects to it, asks for the tool list, and sends each call the model
 * makes. The bridge runs the call on the tool that the core bound and
 * returns the MCP result.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RoomTool } from './tools.ts';
import { frame, type Reply, type Request, receive } from './wire.ts';

/** A running bridge: where the server connects, and how the executor stops it. */
export interface Bridge {
	readonly socketPath: string;
	close(): void;
}

/** A path for one socket. A name in the temp directory is short enough for a Unix socket. */
function socketAddress(): string {
	const name = `ambion-${randomBytes(6).toString('hex')}`;
	return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
}

/** The reply to one request. A tool that throws gives the server an error. */
async function answer(
	request: Request,
	tools: readonly RoomTool[],
	signal: AbortSignal,
): Promise<Reply> {
	if (request.kind === 'manifest') {
		return { id: request.id, tools: tools.map((one) => one.spec) };
	}
	const one = tools.find((candidate) => candidate.spec.name === request.tool);
	if (one === undefined) return { id: request.id, error: `No tool named '${request.tool}'.` };
	if (signal.aborted) return { id: request.id, error: 'The activation was cut.' };
	try {
		return { id: request.id, result: await one.run(request.args) };
	} catch (error) {
		return { id: request.id, error: error instanceof Error ? error.message : String(error) };
	}
}

/** Whether a message from the wire is a request the bridge knows. */
function isRequest(message: unknown): message is Request {
	if (typeof message !== 'object' || message === null) return false;
	const { id, kind } = message as { id?: unknown; kind?: unknown };
	return typeof id === 'number' && (kind === 'manifest' || kind === 'call');
}

/** Open the socket for one activation. It resolves once the socket listens. A cut activation runs no call. */
export async function startBridge(
	tools: readonly RoomTool[],
	signal: AbortSignal,
): Promise<Bridge> {
	const sockets = new Set<Socket>();
	const server: Server = createServer((socket) => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		socket.on('error', () => socket.destroy());
		receive(socket, (message) => {
			if (!isRequest(message)) return;
			void answer(message, tools, signal).then((reply) => {
				if (!socket.destroyed) socket.write(frame(reply));
			});
		});
	});
	const socketPath = socketAddress();
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(socketPath, resolve);
	});
	return {
		socketPath,
		close: () => {
			for (const socket of sockets) socket.destroy();
			server.close();
		},
	};
}
