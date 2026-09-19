import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import type { CreateRuntimeOptions } from '@ambionframework/ambion';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkbenchClient } from '../src/client.ts';
import { openWorkbench } from '../src/server.ts';

const open: { close: () => Promise<void>; directory: string }[] = [];

// A stream that never answers keeps every exchange open, so the client sees the
// rooms and messages without waiting on a scripted agent.
const idleStream: CreateRuntimeOptions['stream'] = () => createAssistantMessageEventStream();

async function launch() {
	const directory = await mkdtemp(joinPath(tmpdir(), 'ambion-workbench-client-'));
	const workbench = await openWorkbench(joinPath(directory, 'run'), 'start', idleStream);
	await new Promise<void>((resolve, reject) => {
		workbench.server.once('error', reject);
		workbench.server.listen(0, '127.0.0.1', () => resolve());
	});
	const address = workbench.server.address();
	if (!address || typeof address === 'string') throw new Error('The test server did not bind.');
	open.push({ close: () => workbench.close(), directory });
	return new WorkbenchClient(`http://127.0.0.1:${address.port}`);
}

afterEach(async () => {
	for (const entry of open.splice(0)) {
		await entry.close().catch(() => undefined);
		await rm(entry.directory, { recursive: true, force: true });
	}
});

describe('WorkbenchClient', () => {
	it('reads people and rooms and reports an unknown room', async () => {
		const client = await launch();
		const people = await client.people();
		const rooms = await client.rooms();
		expect(people.map((person) => person.name)).toEqual(['mira', 'theo', 'sol']);
		expect(rooms.map((room) => room.name)).toEqual(['bringup', 'sensing', 'power']);
		await expect(client.read('unknown', 0)).rejects.toThrow(/Unknown room/);
	});

	it('joins a room and accepts a message from a present person', async () => {
		const client = await launch();
		await client.join('bringup', 'mira');
		const accepted = await client.send('bringup', 'mira', 'client-1', 'Which resistor?');
		const view = await client.read('bringup', 0);
		expect(accepted.owner).toBe('mira');
		expect(view.messages ?? []).toEqual(
			expect.arrayContaining([expect.objectContaining({ from: 'mira', text: 'Which resistor?' })]),
		);
	});

	it('reports the HTTP status when an error reply is not JSON', async () => {
		const proxy = createServer((_request, response) => {
			response.writeHead(502, { 'content-type': 'text/html' });
			response.end('<html>Bad gateway</html>');
		});
		await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
		const address = proxy.address();
		if (!address || typeof address === 'string') throw new Error('The stub did not bind.');
		try {
			const client = new WorkbenchClient(`http://127.0.0.1:${address.port}`);
			await expect(client.rooms()).rejects.toThrow(/HTTP 502/);
		} finally {
			await new Promise((resolve) => proxy.close(resolve));
		}
	});

	it('refuses a message before the person enters the room', async () => {
		const client = await launch();
		await expect(client.send('sensing', 'theo', 'client-2', 'Which pins?')).rejects.toThrow(
			/Enter this room/,
		);
	});
});
