import { get as httpGet } from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { type WorkstationCredential, workstationBackend } from '../src/index.ts';
import { startHttpServer } from './support/http-server.ts';
import { startSshServer } from './support/server.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(options: { readonly idleTimeout?: number } = {}) {
	const ssh = await startSshServer(['ada']);
	const http = await startHttpServer();
	const backend = workstationBackend({ ...ssh.options, ...options });
	cleanups.push(async () => {
		await backend.dispose?.();
		await http.close();
		await ssh.stop();
	});
	return { backend, http, ssh };
}

async function textAt(url: string, path = ''): Promise<string> {
	const response = await fetch(new URL(path, url));
	if (!response.ok) throw new Error(`HTTP returned ${response.status}.`);
	return response.text();
}

async function until(check: () => boolean, message: string, timeoutMs = 1_000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
	if (!check()) throw new Error(message);
}

const tcpServerCount = () =>
	process.getActiveResourcesInfo().filter((resource) => resource === 'TCPServerWrap').length;

async function open(backend: ReturnType<typeof workstationBackend>, port: number) {
	const endpoints = backend.endpoints;
	if (endpoints === undefined) throw new Error('The workstation has no endpoint capability.');
	return endpoints.forward({ name: 'ada' }, port);
}

describe('workstation endpoints over the in-process SSH tier', () => {
	it('forwards actual loopback HTTP, exposes the configured hostname, and releases on close', async () => {
		const { backend, http, ssh } = await fixture();
		const endpoints = backend.endpoints;
		if (endpoints === undefined) throw new Error('The workstation has no endpoint capability.');
		expect(endpoints.machine).toBe(ssh.options.server);
		const controller = new AbortController();
		const port = await endpoints.forward({ name: 'ada' }, http.port, controller.signal);
		controller.abort(new Error('signal ended after open'));
		const local = new URL(port.url);
		expect(local.protocol).toBe('http:');
		expect(local.hostname).toBe('127.0.0.1');
		expect(Number(local.port)).toBeGreaterThan(0);
		expect(await textAt(port.url)).toBe('served GET /');
		expect(http.requests).toBe(1);
		expect(ssh.forwards.size).toBe(1);
		await port.close();
		await port.close();
		await until(() => ssh.forwards.size === 0, 'SSH direct-tcpip channel remained after close.');
		await expect(fetch(port.url)).rejects.toThrow();
	});

	it('rejects invalid service ports before opening an SSH session', async () => {
		const { backend, ssh } = await fixture();
		const endpoints = backend.endpoints;
		if (endpoints === undefined) throw new Error('The workstation has no endpoint capability.');
		for (const port of [0, -1, 1.5, 65_536, Number.NaN, Number.POSITIVE_INFINITY]) {
			await expect(endpoints.forward({ name: 'ada' }, port)).rejects.toThrow(/port/i);
		}
		expect(ssh.logins.get('ada') ?? 0).toBe(0);
	});

	it('reports SSH forwarding refusal and keeps the shared workstation session usable', async () => {
		const { backend, http, ssh } = await fixture();
		const env = await backend.connect({ name: 'ada' });
		ssh.refuseForwarding(true);
		await expect(open(backend, http.port)).rejects.toThrow(/forward.*127\.0\.0\.1/i);
		expect(ssh.forwards.size).toBe(0);
		ssh.refuseForwarding(false);
		const port = await open(backend, http.port);
		expect(await textAt(port.url)).toBe('served GET /');
		await port.close();
		await env.cleanup();
	});

	it('releases the failed open lease and unpublished loopback listener after forwarding refusal', async () => {
		const { backend, http, ssh } = await fixture({ idleTimeout: 0.05 });
		const endpoints = backend.endpoints;
		if (endpoints === undefined) throw new Error('The workstation has no endpoint capability.');
		ssh.refuseForwarding(true);
		const listenersBefore = tcpServerCount();
		await expect(endpoints.forward({ name: 'ada' }, http.port)).rejects.toThrow(/forward/i);
		await until(
			() => tcpServerCount() === listenersBefore,
			'The refused port open kept a loopback listener alive.',
		);
		await until(
			() => ssh.clients.size === 0,
			'The refused port open kept its session lease alive.',
			1_500,
		);
	});

	it('surfaces an unavailable remote loopback service without leaking its transport', async () => {
		const { backend, ssh } = await fixture();
		const unavailable = await unusedPort();
		// The code lets `fetch` say that the process does not listen.
		await expect(open(backend, unavailable)).rejects.toMatchObject({
			message: expect.stringMatching(/forward.*127\.0\.0\.1/i),
			code: 'ECONNREFUSED',
		});
		await until(() => ssh.forwards.size === 0, 'A refused SSH channel remained open.');
		const env = await backend.connect({ name: 'ada' });
		expect(await env.writeFile('probe.txt', 'ready')).toMatchObject({
			ok: true,
		});
		await env.cleanup();
	});

	it('rejects a mismatched SSH host key before opening any port channel', async () => {
		const ssh = await startSshServer(['ada']);
		const backend = workstationBackend({ ...ssh.options, hostKey: `SHA256:${'A'.repeat(43)}` });
		cleanups.push(async () => {
			await backend.dispose?.();
			await ssh.stop();
		});
		await expect(open(backend, 12_345)).rejects.toThrow(/host key/i);
		expect(ssh.logins.size).toBe(0);
		expect(ssh.forwards.size).toBe(0);
	});

	it('cancels establishment while another reader owns the shared session and drains a late accept', async () => {
		const { backend, http, ssh } = await fixture();
		const listenersBefore = tcpServerCount();
		const env = await backend.connect({ name: 'ada' });
		const controller = new AbortController();
		ssh.holdForwarding(true);
		const opening = openWithSignal(backend, http.port, controller.signal);
		await until(
			() => ssh.pendingForwards.size === 1,
			'The forwarding probe did not reach the fixture.',
		);
		controller.abort(new Error('test establishment abort'));
		await expect(opening).rejects.toThrow('test establishment abort');
		expect(ssh.clients.size).toBe(1);
		ssh.releaseForwarding();
		await until(
			() => ssh.pendingForwards.size === 0 && ssh.forwards.size === 0,
			'A late forwarding accept leaked a channel.',
		);
		await until(
			() => tcpServerCount() === listenersBefore,
			'Aborted port establishment kept a local listener alive.',
		);
		expect(await env.writeFile('probe.txt', 'ready')).toMatchObject({
			ok: true,
		});
		await env.cleanup();
	});

	it('releases a credential wait when the backend is disposed', async () => {
		const ssh = await startSshServer(['ada']);
		let resolveCredential: ((credential: WorkstationCredential) => void) | undefined;
		let requested = false;
		const backend = workstationBackend({
			...ssh.options,
			credentialFor: () => {
				requested = true;
				return new Promise<WorkstationCredential>((resolve) => {
					resolveCredential = resolve;
				});
			},
		});
		cleanups.push(async () => {
			await backend.dispose?.();
			await ssh.stop();
		});
		const opening = open(backend, 12_345);
		await until(() => requested, 'The credential resolver was not called.');
		await promptly(backend.dispose?.() ?? Promise.resolve());
		await expect(opening).rejects.toThrow();
		resolveCredential?.(await ssh.options.credentialFor({ name: 'ada' }));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(ssh.clients.size).toBe(0);
	});

	it('lets another waiter finish shared credential setup after one opener cancels', async () => {
		const ssh = await startSshServer(['ada']);
		const http = await startHttpServer();
		let resolveCredential: ((credential: WorkstationCredential) => void) | undefined;
		let requested = false;
		const backend = workstationBackend({
			...ssh.options,
			credentialFor: () => {
				requested = true;
				return new Promise<WorkstationCredential>((resolve) => {
					resolveCredential = resolve;
				});
			},
		});
		cleanups.push(async () => {
			await backend.dispose?.();
			await http.close();
			await ssh.stop();
		});
		const endpoints = backend.endpoints;
		if (endpoints === undefined) throw new Error('The workstation has no endpoint capability.');
		const controller = new AbortController();
		const canceled = endpoints.forward({ name: 'ada' }, http.port, controller.signal);
		await until(() => requested, 'The shared credential resolver was not called.');
		const surviving = endpoints.forward({ name: 'ada' }, http.port);
		controller.abort(new Error('first opener canceled'));
		await expect(canceled).rejects.toThrow('first opener canceled');
		resolveCredential?.(await ssh.options.credentialFor({ name: 'ada' }));
		const port = await surviving;
		expect(await textAt(port.url)).toBe('served GET /');
		expect(ssh.logins.get('ada')).toBe(1);
		await port.close();
	});

	it('holds a session past idle expiry, then releases it after the last port closes', async () => {
		const { backend, http, ssh } = await fixture({ idleTimeout: 0.05 });
		const env = await backend.connect({ name: 'ada' });
		const port = await open(backend, http.port);
		await env.cleanup();
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(ssh.clients.size).toBe(1);
		expect(await textAt(port.url)).toBe('served GET /');
		await port.close();
		await until(
			() => ssh.clients.size === 0,
			'The idle session was not released after port close.',
			1_500,
		);
	});

	it('keeps an opened port after a reader cancels and closes a pending reader promptly', async () => {
		const { backend, http, ssh } = await fixture();
		const env = await backend.connect({ name: 'ada' });
		const port = await open(backend, http.port);
		const controller = new AbortController();
		const canceled = rawRequest(new URL('/hold', port.url), controller.signal);
		await until(() => http.requests === 1, 'The held HTTP request did not reach the fixture.');
		controller.abort(new Error('reader canceled'));
		await expect(canceled).rejects.toThrow();
		expect(await textAt(port.url)).toBe('served GET /');
		expect(ssh.forwards.size).toBeGreaterThan(0);

		http.releaseHeld();
		ssh.holdForwarding(true);
		const pending = rawRequest(new URL('/hold', port.url)).then(
			() => false,
			() => true,
		);
		await until(
			() => ssh.pendingForwards.size === 1,
			'The pending reader did not open a forwarding request.',
		);
		await promptly(port.close());
		expect(await pending).toBe(true);
		ssh.releaseForwarding();
		await until(
			() => ssh.pendingForwards.size === 0 && ssh.forwards.size === 0,
			'A late reader channel leaked.',
		);
		expect(await env.writeFile('probe.txt', 'ready')).toMatchObject({
			ok: true,
		});
		await env.cleanup();
	});

	it('closes its listener and channels on SSH disconnect and backend disposal', async () => {
		const { backend, http, ssh } = await fixture();
		const listenersBefore = tcpServerCount();
		const port = await open(backend, http.port);
		await textAt(port.url);
		ssh.dropClients();
		await until(() => ssh.forwards.size === 0, 'The forwarding channel survived SSH disconnect.');
		await expect(fetch(port.url)).rejects.toThrow();
		await port.close();

		const next = await open(backend, http.port);
		await textAt(next.url);
		await backend.dispose?.();
		await until(
			() => ssh.forwards.size === 0 && ssh.clients.size === 0,
			'Backend disposal left SSH resources open.',
		);
		await until(
			() => tcpServerCount() === listenersBefore,
			'Backend disposal kept a private listener open.',
		);
		await expect(fetch(next.url)).rejects.toThrow();
	});

	it('closes an open transport when a later forwarding request is refused', async () => {
		const { backend, http, ssh } = await fixture();
		const port = await open(backend, http.port);
		ssh.refuseForwarding(true);
		await expect(fetch(new URL('/hold', port.url))).rejects.toThrow();
		await until(
			() => ssh.forwards.size === 0,
			'The failed forwarding request left a channel open.',
		);
		await expect(fetch(port.url)).rejects.toThrow();
	});
});

async function openWithSignal(
	backend: ReturnType<typeof workstationBackend>,
	port: number,
	signal: AbortSignal,
) {
	const endpoints = backend.endpoints;
	if (endpoints === undefined) throw new Error('The workstation has no endpoint capability.');
	return endpoints.forward({ name: 'ada' }, port, signal);
}

async function promptly(work: Promise<unknown>): Promise<void> {
	await Promise.race([
		work,
		new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error('close did not finish promptly')), 1_000),
		),
	]);
}

async function unusedPort(): Promise<number> {
	const server = net.createServer();
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (address === null || typeof address === 'string')
		throw new Error('Could not reserve a loopback port.');
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
	return address.port;
}

function rawRequest(url: URL, signal?: AbortSignal): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const request = httpGet(url, { agent: false, signal }, (response) => {
			let body = '';
			response.setEncoding('utf8');
			response.on('data', (chunk: string) => {
				body += chunk;
			});
			response.once('end', () => resolve(body));
		});
		request.once('error', reject);
	});
}
