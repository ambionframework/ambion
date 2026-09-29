import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { workstationBackend } from '../../src/index.ts';
import { startHttpServer } from '../support/http-server.ts';
import { startRootlessSshd } from '../support/rootless-sshd.ts';
import { configPath, options as provisionedOptions } from '../support/sshd.ts';

const sshdAvailable = existsSync('/usr/sbin/sshd');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function rootless(allowForwarding = true) {
	const fixture = await startRootlessSshd({ allowForwarding });
	cleanups.push(() => fixture.close());
	return fixture;
}

async function http() {
	const fixture = await startHttpServer();
	cleanups.push(() => fixture.close());
	return fixture;
}

describe('workstation ports on real OpenSSH', () => {
	it.skipIf(!sshdAvailable)(
		'reaches a real loopback HTTP service through OpenSSH direct-tcpip',
		async () => {
			const ssh = await rootless();
			const service = await http();
			const ports = ssh.backend.ports;
			if (ports === undefined) throw new Error('The workstation has no port capability.');
			const port = await ports.open({ name: 'opener' }, service.port);
			expect(ports.hostname).toBe(ssh.options.host);
			expect(new URL(port.url).hostname).toBe('127.0.0.1');
			expect(await (await fetch(port.url)).text()).toBe('served GET /');
			expect(service.requests).toBe(1);
			await port.close();
			await expect(fetch(port.url)).rejects.toThrow();
		},
	);

	it.skipIf(!sshdAvailable)('reports OpenSSH forwarding policy denial', async () => {
		const ssh = await rootless(false);
		const service = await http();
		const ports = ssh.backend.ports;
		if (ports === undefined) throw new Error('The workstation has no port capability.');
		await expect(ports.open({ name: 'opener' }, service.port)).rejects.toThrow(
			/SSH port forwarding.*127\.0\.0\.1/i,
		);
	});

	it.skipIf(!sshdAvailable)(
		'restricts OpenSSH forwarding destinations to workstation loopback',
		async () => {
			const ssh = await rootless();
			const result = spawnSync(
				'ssh',
				[
					'-i',
					ssh.clientKey,
					'-p',
					String(ssh.options.port),
					'-o',
					'BatchMode=yes',
					'-o',
					'IdentitiesOnly=yes',
					'-o',
					'StrictHostKeyChecking=no',
					'-o',
					'UserKnownHostsFile=/dev/null',
					'-W',
					'192.0.2.1:80',
					`${ssh.username}@127.0.0.1`,
				],
				{ encoding: 'utf8', timeout: 3_000 },
			);
			expect(result.status).toBe(255);
			expect(result.stderr).toMatch(/administratively prohibited|open failed/i);
		},
	);

	it.skipIf(!sshdAvailable)('refuses a pinned host key mismatch before forwarding', async () => {
		const ssh = await rootless();
		const service = await http();
		const backend = workstationBackend({ ...ssh.options, hostKey: `SHA256:${'A'.repeat(43)}` });
		cleanups.push(async () => backend.dispose?.());
		const ports = backend.ports;
		if (ports === undefined) throw new Error('The workstation has no port capability.');
		await expect(ports.open({ name: 'opener' }, service.port)).rejects.toThrow(/host key/i);
		expect(service.requests).toBe(0);
	});

	it.skipIf(configPath === undefined)(
		'reaches a real loopback HTTP service on the provisioned OpenSSH tier',
		async () => {
			const options = await provisionedOptions();
			const backend = workstationBackend(options);
			const service = await http();
			cleanups.push(async () => backend.dispose?.());
			const ports = backend.ports;
			if (ports === undefined) throw new Error('The workstation has no port capability.');
			const port = await ports.open({ name: 'analyst' }, service.port);
			expect(await (await fetch(port.url)).text()).toBe('served GET /');
			await port.close();
			await expect(fetch(port.url)).rejects.toThrow();
		},
	);
});
