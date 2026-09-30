import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { AmbionTool, ToolContext } from '@ambionframework/ambion';
import { describe, expect, it, onTestFinished } from 'vitest';
import { workstationBackend } from '../../workstation/src/index.ts';
import { startSshServer } from '../../workstation/test/support/server.ts';
import { hasSetsid } from '../../workstation/test/support/setsid.ts';
import { openWorkspace } from '../src/index.ts';
import type { SensorIndex } from '../src/sensors.ts';
import { toolOf } from './support/backends.ts';

describe.skipIf(!hasSetsid)('connect through workstation process tools', () => {
	it('runs the server as the owner, leaves shell resources available during readiness, and returns captured discovery', async () => {
		const ssh = await startSshServer(['owner', 'reader']);
		const workspace = openWorkspace({
			name: 'sensor-lab',
			backend: { bash: workstationBackend(ssh.options) },
		});
		onTestFinished(async () => {
			await workspace.dispose();
			await ssh.stop();
		});
		const context = (name: string): ToolContext => ({
			agent: { name, identity: `${name} identity` },
			callId: `connect-${name}`,
		});
		const port = await unusedPort();
		const home = ssh.homes.get('owner');
		if (home === undefined) throw new Error('The SSH fixture has no owner home.');
		const indexMarker = join(home, 'index-requested');
		const indexPath = join(home, 'sensor-index.json');
		const index: SensorIndex = {
			api: 1,
			source: {
				repository: 'owner/bench-sensors',
				commit: 'b'.repeat(40),
				branch: 'workbench',
				dirty: true,
			},
			sensors: [{ name: 'voltage', description: 'Supply voltage.', spans: true }],
		};
		await writeFile(indexPath, JSON.stringify(index));
		const script = [
			`import http from 'node:http';`,
			`import fs from 'node:fs';`,
			`http.createServer(async (request, response) => {`,
			`if (request.url === '/') { fs.writeFileSync(${JSON.stringify(indexMarker)}, 'entered'); await new Promise(resolve => setTimeout(resolve, 1800)); response.writeHead(200, { 'content-type': 'application/json' }); response.end(fs.readFileSync(${JSON.stringify(indexPath)}, 'utf8')); return; }`,
			`response.writeHead(404).end(); }).listen(${port}, '127.0.0.1');`,
		].join('\n');
		await writeFile(join(home, 'sensor-server.mjs'), script);
		const bash = toolOf(workspace, 'bash');
		const started = await bash.invoke(
			{ command: 'node sensor-server.mjs', name: 'sensor-server', wait: 1 },
			context('owner'),
		);
		if (typeof started === 'string') throw new Error('bash returned no process details.');
		const handle = (started.details as { process: { handle: string } }).process.handle;
		let connected = false;
		const connecting = Promise.resolve(
			toolOf(workspace, 'connect').invoke(
				{ name: 'bench', process: handle, port },
				context('owner'),
			),
		).then(
			(result) => {
				connected = true;
				return { result };
			},
			(error: unknown) => {
				connected = true;
				return { error };
			},
		);
		await untilFile(indexMarker);
		const write = await toolOf(workspace, 'write').invoke(
			{ path: 'queue-probe.txt', content: 'ready' },
			context('reader'),
		);
		if (typeof write === 'string') throw new Error('write returned no result.');
		expect(connected).toBe(false);
		expect(write.content.map((part) => (part.type === 'text' ? part.text : '')).join('')).toContain(
			'Successfully wrote',
		);
		const outcome = await connecting;
		if ('error' in outcome) throw outcome.error;
		const result = outcome.result;
		if (typeof result === 'string') throw new Error('connect returned no discovery details.');
		expect(result.details).toMatchObject({
			name: 'bench',
			hostname: ssh.options.host,
			port,
			process: handle,
			owner: 'owner',
			source: index.source,
			sensors: ['bench/voltage'],
		});
		expect(
			result.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
		).toContain('bench/voltage: Supply voltage.');
		await verifyRetryAndProcessEnd(workspace, ssh, bash, context, {
			home,
			index,
			indexPath,
			handle,
			port,
		});
		await verifyDisposeDuringReadiness(workspace, ssh, bash, context, home);
	});
});

interface ConnectedFixture {
	readonly home: string;
	readonly index: SensorIndex;
	readonly indexPath: string;
	readonly handle: string;
	readonly port: number;
}

async function verifyRetryAndProcessEnd(
	workspace: ReturnType<typeof openWorkspace>,
	ssh: Awaited<ReturnType<typeof startSshServer>>,
	bash: AmbionTool,
	context: (name: string) => ToolContext,
	fixture: ConnectedFixture,
): Promise<void> {
	const { home, index, indexPath, handle, port } = fixture;
	await waitForForwards(1, ssh);
	const updatedIndex = {
		...index,
		sensors: [{ name: 'pressure', description: 'Updated discovery.', spans: false }],
	};
	await writeFile(indexPath, JSON.stringify(updatedIndex));
	const retry = await toolOf(workspace, 'connect').invoke(
		{ name: 'bench', process: handle, port },
		context('owner'),
	);
	if (typeof retry === 'string') throw new Error('connect retry returned no discovery details.');
	expect(retry.details).toMatchObject({ source: index.source, sensors: ['bench/pressure'] });
	await waitForForwards(1, ssh);
	const changedSource = {
		...updatedIndex,
		source: { ...index.source, commit: 'c'.repeat(40), dirty: false },
	};
	await writeFile(indexPath, JSON.stringify(changedSource));
	await expect(
		toolOf(workspace, 'connect').invoke({ name: 'bench', process: handle, port }, context('owner')),
	).rejects.toThrow(/launch source changed/i);
	expect(retry.details).toMatchObject({ source: index.source, sensors: ['bench/pressure'] });
	await waitForForwards(1, ssh);
	await writeFile(indexPath, JSON.stringify(updatedIndex));
	const restored = await toolOf(workspace, 'connect').invoke(
		{ name: 'bench', process: handle, port },
		context('owner'),
	);
	if (typeof restored === 'string') throw new Error('connect retry returned no discovery details.');
	expect(restored.details).toMatchObject({ source: index.source, sensors: ['bench/pressure'] });
	await expect(
		toolOf(workspace, 'connect').invoke(
			{ name: 'other', process: handle, port },
			context('reader'),
		),
	).rejects.toThrow(/owner|process/i);
	await failReadinessAndEnd(workspace, ssh, bash, context, home, index);
	await toolOf(workspace, 'cancel').invoke({ handle }, context('owner'));
	await waitForForwards(0, ssh);
	await expect(
		toolOf(workspace, 'connect').invoke({ name: 'bench', process: handle, port }, context('owner')),
	).rejects.toThrow(/running|ended|cancelled/i);
}

async function failReadinessAndEnd(
	workspace: ReturnType<typeof openWorkspace>,
	ssh: Awaited<ReturnType<typeof startSshServer>>,
	bash: AmbionTool,
	context: (name: string) => ToolContext,
	home: string,
	index: ConnectedFixture['index'],
): Promise<void> {
	const port = await unusedPort();
	const indexPath = join(home, 'bad-index.json');
	await writeFile(indexPath, JSON.stringify({ ...index, api: 2 }));
	const server = [
		`import http from 'node:http';`,
		`import fs from 'node:fs';`,
		`http.createServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(fs.readFileSync(${JSON.stringify(indexPath)}, 'utf8')); }).listen(${port}, '127.0.0.1');`,
	].join('\n');
	await writeFile(join(home, 'bad-sensor-server.mjs'), server);
	const started = await bash.invoke(
		{ command: 'node bad-sensor-server.mjs', name: 'bad-sensor-server', wait: 1 },
		context('owner'),
	);
	if (typeof started === 'string') throw new Error('bash returned no bad process details.');
	const handle = (started.details as { process: { handle: string } }).process.handle;
	await expect(
		toolOf(workspace, 'connect').invoke({ name: 'bad', process: handle, port }, context('owner')),
	).rejects.toThrow(/sensor index/i);
	await waitForForwards(1, ssh);
	await toolOf(workspace, 'cancel').invoke({ handle }, context('owner'));
}

async function verifyDisposeDuringReadiness(
	workspace: ReturnType<typeof openWorkspace>,
	ssh: Awaited<ReturnType<typeof startSshServer>>,
	bash: AmbionTool,
	context: (name: string) => ToolContext,
	home: string,
): Promise<void> {
	const port = await unusedPort();
	const marker = join(home, 'blocked-index-requested');
	const server = [
		`import http from 'node:http';`,
		`import fs from 'node:fs';`,
		`http.createServer((request, response) => { if (request.url === '/') { fs.writeFileSync(${JSON.stringify(marker)}, 'entered'); return; } response.writeHead(404).end(); }).listen(${port}, '127.0.0.1');`,
	].join('\n');
	await writeFile(join(home, 'blocked-sensor-server.mjs'), server);
	const started = await bash.invoke(
		{ command: 'node blocked-sensor-server.mjs', name: 'blocked-sensor-server', wait: 1 },
		context('owner'),
	);
	if (typeof started === 'string') throw new Error('bash returned no blocked process details.');
	const handle = (started.details as { process: { handle: string } }).process.handle;
	const pending = Promise.resolve(
		toolOf(workspace, 'connect').invoke(
			{ name: 'pending', process: handle, port },
			context('owner'),
		),
	).then(
		(result) => ({ result }),
		(error: unknown) => ({ error }),
	);
	await untilFile(marker);
	const held = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const ownerOperation = workspace.use({ name: 'reader' }, async () => {
		held.resolve();
		await release.promise;
	});
	await held.promise;
	let disposed = false;
	const disposal = workspace.dispose().then(() => {
		disposed = true;
	});
	const outcome = await pending;
	expect('error' in outcome).toBe(true);
	await waitForForwards(0, ssh);
	expect(disposed).toBe(false);
	release.resolve();
	await Promise.all([ownerOperation, disposal]);
}

async function unusedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (address === null || typeof address === 'string')
		throw new Error('Could not allocate a test port.');
	const port = address.port;
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
	return port;
}

async function untilFile(path: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		try {
			if ((await readFile(path, 'utf8')) === 'entered') return;
		} catch {
			// The remote request has not reached the server yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error('The connected sensor server did not receive its index request.');
}

async function waitForForwards(
	expected: number,
	ssh: Awaited<ReturnType<typeof startSshServer>>,
): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (ssh.forwards.size !== expected && Date.now() < deadline)
		await new Promise((resolve) => setTimeout(resolve, 10));
	expect(ssh.forwards.size).toBe(expected);
}
