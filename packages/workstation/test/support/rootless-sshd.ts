import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net, { type Socket } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { type WorkstationOptions, workstationBackend } from '../../src/index.ts';

/** Start an unprivileged OpenSSH server for a real forwarding test. */
export async function startRootlessSshd({
	allowForwarding = true,
}: { allowForwarding?: boolean } = {}) {
	const state = await mkdtemp(join(tmpdir(), 'ambion-rootless-sshd-'));
	const hostKey = join(state, 'host');
	const clientKey = join(state, 'client');
	let daemon: ChildProcessWithoutNullStreams | undefined;
	let backend: ReturnType<typeof workstationBackend> | undefined;
	let stderr = '';
	try {
		run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey]);
		run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', clientKey]);
		const username = userInfo().username;
		const port = await unusedPort();
		const fingerprint = run('ssh-keygen', ['-lf', `${hostKey}.pub`]).split(/\s+/)[1];
		if (fingerprint === undefined)
			throw new Error('Could not read the rootless sshd host key fingerprint.');
		await writeFile(join(state, 'authorized_keys'), await readFile(`${clientKey}.pub`), {
			mode: 0o600,
		});
		const config = join(state, 'sshd_config');
		await writeFile(
			config,
			`${[
				`Port ${port}`,
				'ListenAddress 127.0.0.1',
				`HostKey ${hostKey}`,
				`PidFile ${join(state, 'sshd.pid')}`,
				`AuthorizedKeysFile ${join(state, 'authorized_keys')}`,
				'StrictModes no',
				'UsePAM no',
				'AuthenticationMethods publickey',
				'PubkeyAuthentication yes',
				'PasswordAuthentication no',
				'KbdInteractiveAuthentication no',
				`AllowTcpForwarding ${allowForwarding ? 'local' : 'no'}`,
				'AllowStreamLocalForwarding no',
				'GatewayPorts no',
				...(allowForwarding ? ['PermitOpen 127.0.0.1:*'] : []),
				`AllowUsers ${username}`,
				'Subsystem sftp internal-sftp',
				'LogLevel VERBOSE',
			].join('\n')}\n`,
			{ mode: 0o600 },
		);
		run('/usr/sbin/sshd', ['-t', '-f', config]);
		daemon = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', config], { stdio: 'pipe' });
		daemon.stderr.setEncoding('utf8').on('data', (text: string) => {
			stderr += text;
		});
		await waitForListener(daemon, port, () => stderr);
		const privateKey = await readFile(clientKey, 'utf8');
		const options: WorkstationOptions = {
			host: '127.0.0.1',
			port,
			hostKey: fingerprint,
			layout: {
				audit: join(state, 'audit.jsonl'),
				rooms: join(state, 'rooms'),
				snapshots: join(state, 'snapshots'),
			},
			credentialFor: () => ({ username, privateKey }),
		};
		backend = workstationBackend(options);
		return {
			backend,
			options,
			username,
			clientKey,
			async close() {
				await backend?.dispose?.();
				await stopDaemon(daemon);
				await rm(state, { recursive: true, force: true });
			},
		};
	} catch (error) {
		await backend?.dispose?.();
		await stopDaemon(daemon);
		await rm(state, { recursive: true, force: true });
		throw new Error(`Could not start the rootless OpenSSH fixture: ${String(error)}${stderr}`);
	}
}

function run(command: string, args: string[]): string {
	const result = spawnSync(command, args, { encoding: 'utf8' });
	if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr}`);
	return result.stdout.trim();
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

async function waitForListener(
	daemon: ChildProcessWithoutNullStreams,
	port: number,
	getStderr: () => string,
): Promise<void> {
	for (let attempt = 0; attempt < 80; attempt += 1) {
		if (daemon.exitCode !== null)
			throw new Error(`sshd exited with ${daemon.exitCode}: ${getStderr()}`);
		try {
			await probe(port);
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
	throw new Error(`sshd did not listen on 127.0.0.1:${port}: ${getStderr()}`);
}

function probe(port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket: Socket = net.connect(port, '127.0.0.1');
		socket.once('connect', () => {
			socket.destroy();
			resolve();
		});
		socket.once('error', reject);
	});
}

async function stopDaemon(daemon: ChildProcessWithoutNullStreams | undefined): Promise<void> {
	if (daemon === undefined || daemon.exitCode !== null) return;
	const exited = new Promise<void>((resolve) => daemon.once('exit', () => resolve()));
	daemon.kill('SIGTERM');
	await exited;
}
