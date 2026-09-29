import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A real loopback HTTP service for exercising both SSH forwarding tiers. */
export async function startHttpServer() {
	let requests = 0;
	let closed = false;
	const held = new Set<import('node:http').ServerResponse>();
	const server = createServer((request, response) => {
		requests += 1;
		if (request.url === '/hold') {
			held.add(response);
			response.once('close', () => held.delete(response));
			return;
		}
		response.writeHead(200, { 'content-type': 'text/plain' });
		response.end(`served ${request.method} ${request.url}`);
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const { port } = server.address() as AddressInfo;
	return {
		port,
		get requests() {
			return requests;
		},
		releaseHeld() {
			for (const response of held) response.end('released');
			held.clear();
		},
		close: async () => {
			if (closed) return;
			closed = true;
			for (const response of held) response.destroy();
			held.clear();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		},
	};
}
