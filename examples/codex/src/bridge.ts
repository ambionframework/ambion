/**
 * The host side of the local socket.
 *
 * One bridge serves one activation. The room tools server that Codex spawns
 * connects to it, asks for the tool list, and sends each call the model
 * makes. The bridge runs the call against the room binding and returns the
 * MCP result. It also holds the workspace paths that Codex reports as
 * changed, so the next say cites them as `refs`.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActivationView, AgentDefinition } from '@ambionframework/ambion/hosting';
import { type Binding, type Changed, type RoomTool, roomTools } from './tools.ts';
import { frame, type Reply, type Request, receive } from './wire.ts';

/** A running bridge: where the server connects, and how the executor feeds and stops it. */
export interface Bridge {
	readonly socketPath: string;
	/** Paths the agent changed. The next ordinary say cites them. */
	note(paths: readonly string[]): void;
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
	binding: Binding,
): Promise<Reply> {
	if (request.kind === 'manifest') {
		return { id: request.id, tools: tools.map((one) => one.spec) };
	}
	const one = tools.find((candidate) => candidate.spec.name === request.tool);
	if (one === undefined) return { id: request.id, error: `No tool named '${request.tool}'.` };
	if (binding.signal.aborted) return { id: request.id, error: 'The activation was cut.' };
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

/** Open the socket for one activation. It resolves once the socket listens. */
export async function startBridge(
	view: ActivationView,
	definition: AgentDefinition,
	binding: Binding,
	current: () => ActivationView = () => view,
): Promise<Bridge> {
	const noted = new Set<string>();
	const changed: Changed = {
		peek: () => [...noted],
		clear: () => noted.clear(),
	};
	const tools = roomTools(view, definition, binding, changed, current);
	const sockets = new Set<Socket>();
	const server: Server = createServer((socket) => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		socket.on('error', () => socket.destroy());
		receive(socket, (message) => {
			if (!isRequest(message)) return;
			void answer(message, tools, binding).then((reply) => {
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
		note: (paths) => {
			for (const path of paths) noted.add(path);
		},
		close: () => {
			for (const socket of sockets) socket.destroy();
			server.close();
		},
	};
}
