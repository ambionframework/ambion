/** What one activation passes to the Codex client. */
import { describe, expect, it } from 'vitest';
import { clientOptions } from '../src/options.ts';

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
