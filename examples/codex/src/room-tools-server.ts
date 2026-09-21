/**
 * The room tools server. Codex spawns it as a stdio MCP server.
 *
 * It holds no room. On start it connects to the activation's socket, asks
 * the host for the tool list, and serves it. Each call the model makes goes
 * over the socket and its result comes back. The server exits when Codex
 * closes its input or the host closes the socket.
 *
 * Run: `node room-tools-server.ts <socket path>`
 */
import { connect } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { frame, type Reply, type Request, receive } from './wire.ts';

const address = process.argv[2];
if (address === undefined) {
	process.stderr.write('room-tools-server: no socket path.\n');
	process.exit(2);
}

const socket = connect(address);
const waiting = new Map<number, (reply: Reply) => void>();
let serial = 0;

receive(socket, (message) => {
	const reply = message as Reply;
	waiting.get(reply.id)?.(reply);
	waiting.delete(reply.id);
});
socket.on('close', () => process.exit(0));
socket.on('error', () => process.exit(1));
process.stdin.on('end', () => process.exit(0));

/** Send one request to the host and wait for its reply. */
function ask(request: DistributiveOmit<Request, 'id'>): Promise<Reply> {
	serial += 1;
	const id = serial;
	return new Promise((resolve) => {
		waiting.set(id, resolve);
		socket.write(frame({ ...request, id }));
	});
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

await new Promise<void>((resolve) => socket.once('connect', resolve));
const manifest = await ask({ kind: 'manifest' });
const tools = 'tools' in manifest ? manifest.tools : [];

const server = new Server({ name: 'ambion', version: '0.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, () => ({
	tools: tools.map((one) => ({
		name: one.name,
		description: one.description,
		inputSchema: one.inputSchema as { type: 'object' },
	})),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const reply = await ask({
		kind: 'call',
		tool: request.params.name,
		args: request.params.arguments ?? {},
	});
	if ('result' in reply) return reply.result;
	const message = 'error' in reply ? reply.error : 'The host sent no result.';
	return { content: [{ type: 'text' as const, text: message }], isError: true };
});

await server.connect(new StdioServerTransport());
