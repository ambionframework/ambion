/** Start and recover an SN35 sensor host across a real parent-process crash. */

import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openWorkspace, type Workspace } from '@ambionframework/workspace';
import { workstationBackend, workstationGitBackend } from '../../src/index.ts';
import { action, dynamicAction, latest, manifestRef, runToolRoom } from './sensor-lifecycle.ts';
import { configPath, keyOf, options, readSetup } from './sshd.ts';

export interface SensorCrashHost {
	readonly child: ChildProcess;
	readonly handle: string;
	readonly port: number;
}

export interface SensorCrashRecovery {
	readonly workspace: Workspace;
	readonly bash: ReturnType<typeof workstationBackend>;
	readonly git: ReturnType<typeof workstationGitBackend>;
	readonly handle: string;
	readonly port: number;
	readonly advancedCommit: string;
	readonly processes: string;
	readonly source: string;
	readonly observation: string;
	readonly ref: string;
	readonly citation: string;
	readonly citationRecorded: boolean;
}

/** Start the checked-in sensor in a child host and return its live process identity. */
export async function startSensorLifecycleCrashHost(nodePath: string): Promise<SensorCrashHost> {
	if (!nodePath.startsWith('/'))
		throw new Error(`The remote Node path must be absolute: ${nodePath}`);
	const hostScript = fileURLToPath(new URL('./sensor-lifecycle-crash-host.ts', import.meta.url));
	const child = spawn(process.execPath, ['--experimental-strip-types', hostScript], {
		cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
		stdio: ['ignore', 'pipe', 'pipe'],
		env: {
			...process.env,
			AMBION_WORKSTATION_SSHD: configPath ?? '',
			AMBION_SENSOR_LIFECYCLE_NODE: nodePath,
		},
	});
	try {
		const line = await readStartupLine(child);
		const started = JSON.parse(line) as { readonly handle: string; readonly port: number };
		if (!/^bash-[a-f0-9]+$/.test(started.handle) || !validPort(started.port)) {
			throw new Error(`The crash host returned an invalid process identity: ${line}`);
		}
		return { child, handle: started.handle, port: started.port };
	} catch (error) {
		child.kill('SIGKILL');
		throw error;
	}
}

/** Recover a killed host from a new workspace and prove its launch source stayed fixed. */
export async function recoverSensorCrash(input: {
	readonly handle: string;
	readonly port: number;
	readonly expectedCommit: string;
	readonly branch: string;
}): Promise<SensorCrashRecovery> {
	if (!/^[A-Za-z0-9._/-]+$/.test(input.branch)) {
		throw new Error(`The crash recovery branch is invalid: ${input.branch}`);
	}
	const { workspace, bash, git } = await makeWorkspace();
	try {
		const run = await runToolRoom(workspace, 'analyst', [
			action('clone', { source: 'analyst/sensor-server', path: '~/sensor-server-mover' }),
			action('bash', {
				command: [
					'cd ~/sensor-server-mover',
					'git config user.name "SN35 Acceptance"',
					'git config user.email sn35@example.invalid',
					`git switch -- '${input.branch}'`,
					"sed -i 's/22.5/31.0/' server.mjs",
					"git commit -am 'Advance lifecycle branch after host crash'",
					`git push origin '${input.branch}'`,
					'git rev-parse HEAD',
				].join(' && '),
				wait: 30,
			}),
			action('ps', {}),
			action('connect', { name: 'bench', process: input.handle, port: input.port }),
			action('observe', { sensor: 'bench/room-temperature' }),
			dynamicAction('say', (results) => ({
				text: 'The adopted measurement is retained.',
				refs: [manifestRef(latest(results, 'observe'))],
			})),
		]);
		const advancedText = latest(run.results, 'bash');
		const advancedCommit = /(?:^|\n)([0-9a-f]{40})(?:\s|$)/.exec(advancedText)?.[1];
		if (advancedCommit === undefined || advancedCommit === input.expectedCommit) {
			throw new Error(
				`The separate checkout did not advance the lifecycle branch: ${advancedText}`,
			);
		}
		const processes = latest(run.results, 'ps');
		if (!processes.includes(input.handle)) {
			throw new Error(`The fresh workspace did not adopt ${input.handle}: ${processes}`);
		}
		const source = latest(run.results, 'connect');
		if (
			!source.includes(`@${input.expectedCommit} (${input.branch}) [dirty].`) ||
			!source.includes(`process ${input.handle}.`)
		) {
			throw new Error(`The recovered sensor lost its immutable launch source: ${source}`);
		}
		const observation = latest(run.results, 'observe');
		const ref = manifestRef(observation);
		const citationRecorded = run.messages.some(
			(message) => message.kind === 'said' && message.refs?.includes(ref),
		);
		if (!citationRecorded) throw new Error(`The room did not cite the recovered snapshot ${ref}.`);
		return {
			workspace,
			bash,
			git,
			handle: input.handle,
			port: input.port,
			advancedCommit,
			processes,
			source,
			observation,
			ref,
			citation: latest(run.results, 'say'),
			citationRecorded,
		};
	} catch (error) {
		await disposeWorkspace(workspace, bash, git);
		throw error;
	}
}

/** Dispose a recovered workspace and both of its remote backends. */
export async function disposeSensorCrashRecovery(recovery: SensorCrashRecovery): Promise<void> {
	await disposeWorkspace(recovery.workspace, recovery.bash, recovery.git);
}

async function makeWorkspace(): Promise<{
	readonly workspace: Workspace;
	readonly bash: ReturnType<typeof workstationBackend>;
	readonly git: ReturnType<typeof workstationGitBackend>;
}> {
	const ssh = await options();
	const setup = await readSetup();
	const bash = workstationBackend(ssh);
	const git = workstationGitBackend({
		host: setup.host,
		port: setup.port,
		hostKey: setup.hostKey,
		account: { username: 'lab-git', privateKey: await keyOf(setup, 'lab-git') },
	});
	return {
		workspace: openWorkspace({ name: 'lab', backend: { bash, git }, audit: {} }),
		bash,
		git,
	};
}

async function disposeWorkspace(
	workspace: Workspace,
	bash: ReturnType<typeof workstationBackend>,
	git: ReturnType<typeof workstationGitBackend>,
): Promise<void> {
	await workspace.dispose();
	await bash.dispose?.();
	await git.dispose?.();
}

async function readStartupLine(child: ChildProcess): Promise<string> {
	return new Promise((resolve, reject) => {
		let stdout = '';
		let stderr = '';
		const timeout = setTimeout(
			() => finish(new Error('The crash host did not start in 30 seconds.')),
			30_000,
		);
		const finish = (error?: Error, line?: string): void => {
			clearTimeout(timeout);
			child.stdout?.off('data', onStdout);
			child.stderr?.off('data', onStderr);
			child.off('error', onError);
			child.off('exit', onExit);
			if (error !== undefined) reject(error);
			else resolve(line ?? '');
		};
		const onStdout = (chunk: Buffer): void => {
			stdout += chunk.toString('utf8');
			const newline = stdout.indexOf('\n');
			if (newline >= 0) finish(undefined, stdout.slice(0, newline));
		};
		const onStderr = (chunk: Buffer): void => {
			stderr += chunk.toString('utf8');
		};
		const onError = (error: Error): void => finish(error);
		const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
			finish(
				new Error(`The crash host exited before startup (${code ?? signal}): ${stderr || stdout}`),
			);
		child.stdout?.on('data', onStdout);
		child.stderr?.on('data', onStderr);
		child.once('error', onError);
		child.once('exit', onExit);
	});
}

function validPort(port: number): boolean {
	return Number.isInteger(port) && port >= 1 && port <= 65535;
}
