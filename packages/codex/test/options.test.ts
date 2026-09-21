/** What one activation passes to the Codex client. */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { clientOptions, serverPath } from '../src/options.ts';

describe('clientOptions', () => {
	it('approves the tools of the room server, which the seat owns', () => {
		const config = clientOptions({}, '/tmp/room.sock').config as {
			mcp_servers: Record<string, { default_tools_approval_mode?: string }>;
		};
		const servers = Object.values(config.mcp_servers);
		expect(servers).toHaveLength(1);
		expect(servers[0]?.default_tools_approval_mode).toBe('approve');
	});

	it('passes the socket path to the server', () => {
		const config = clientOptions({}, '/tmp/room.sock').config as {
			mcp_servers: Record<string, { args: string[] }>;
		};
		expect(Object.values(config.mcp_servers)[0]?.args.at(-1)).toBe('/tmp/room.sock');
	});
});

describe('serverPath', () => {
	it('names the TypeScript server in the source tree, and the file exists', () => {
		const path = serverPath();
		expect(path.endsWith('/src/room-tools-server.ts')).toBe(true);
		expect(existsSync(path)).toBe(true);
	});

	it('names the built server beside a built module', () => {
		expect(serverPath('file:///app/node_modules/@ambionframework/codex/dist/index.mjs')).toBe(
			'/app/node_modules/@ambionframework/codex/dist/room-tools-server.mjs',
		);
	});

	it('names an existing built file when the package is built', () => {
		const built = new URL('../dist/index.mjs', import.meta.url);
		if (!existsSync(fileURLToPath(built))) return;
		const path = serverPath(built);
		expect(path.endsWith('/dist/room-tools-server.mjs')).toBe(true);
		expect(existsSync(path)).toBe(true);
	});
});
