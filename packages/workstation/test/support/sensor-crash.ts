/** Start and recover an SN35 sensor host across a real parent-process crash. */

import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { openWorkspace, type Workspace } from '@ambionframework/workspace';
import { workstationBackend, workstationGitBackend } from '../../src/index.ts';
import {
	action,
	dynamicAction,
	expectCancelled,
	expectSuccess,
	latest,
	manifestRef,
	readyPort,
	runToolRoom,
} from './sensor-lifecycle.ts';
import { configPath, keyOf, options, readSetup, run, withEnv } from './sshd.ts';

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
export async function startSensorLifecycleCrashHost(
	nodePath: string,
	options: { readonly startupTimeoutMs?: number; readonly responseDelayMs?: number } = {},
): Promise<SensorCrashHost> {
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
			...(options.responseDelayMs === undefined
				? {}
				: { AMBION_SENSOR_LIFECYCLE_RESPONSE_DELAY_MS: String(options.responseDelayMs) }),
		},
	});
	let remote: { readonly handle: string; readonly port: number } | undefined;
	try {
		remote = await readReadyMarker(child);
		const line = await readStartupLine(child, options.startupTimeoutMs ?? 30_000);
		const started = JSON.parse(line) as { readonly handle: string; readonly port: number };
		if (!/^bash-[a-f0-9]+$/.test(started.handle) || !validPort(started.port)) {
			throw new Error(`The crash host returned an invalid process identity: ${line}`);
		}
		return { child, handle: started.handle, port: started.port };
	} catch (error) {
		try {
			await killChild(child);
			await cleanupOrphan(remote, nodePath);
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				`Crash-host startup failed and orphan cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
			);
		}
		if (remote !== undefined) {
			throw new Error(
				`Crash host startup failed after remote READY ${remote.handle} on port ${remote.port}; orphan was cancelled and port closed.`,
				{ cause: error },
			);
		}
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
			action(
				'clone',
				{ source: 'analyst/sensor-server', path: '~/sensor-server-mover' },
				(text) => {
					if (!text.includes('Cloned'))
						throw new Error(`Could not create the separate checkout: ${text}`);
				},
			),
			action(
				'bash',
				{
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
					wait: 120,
				},
				expectSuccess('Advance and push the lifecycle branch from a separate checkout'),
			),
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
	const git = workstationGitBackend({
		server: setup.host,
		port: setup.port,
		hostKey: setup.hostKey,
		account: { username: 'lab-git', privateKey: await keyOf(setup, 'lab-git') },
	});
	const bash = workstationBackend({ ...ssh, git });
	return {
		workspace: openWorkspace({ name: 'lab', backend: { bash }, audit: {} }),
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

async function readStartupLine(child: ChildProcess, timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		let stdout = '';
		let stderr = '';
		const timeout = setTimeout(
			() => finish(new Error(`The crash host did not return startup data in ${timeoutMs}ms.`)),
			timeoutMs,
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

async function readReadyMarker(
	child: ChildProcess,
): Promise<{ readonly handle: string; readonly port: number }> {
	return new Promise((resolve, reject) => {
		let stderr = '';
		const timeout = setTimeout(
			() => finish(new Error('The crash host did not report remote READY.')),
			30_000,
		);
		const finish = (
			error?: Error,
			remote?: { readonly handle: string; readonly port: number },
		): void => {
			clearTimeout(timeout);
			child.stderr?.off('data', onStderr);
			child.off('error', onError);
			child.off('exit', onExit);
			if (error !== undefined) reject(error);
			else if (remote !== undefined) resolve(remote);
			else reject(new Error('The crash host READY marker was empty.'));
		};
		const onStderr = (chunk: Buffer): void => {
			stderr += chunk.toString('utf8');
			const line = stderr
				.split('\n')
				.slice(0, -1)
				.find((item) => item.startsWith('SN35_READY:'));
			if (line === undefined) return;
			try {
				const remote = JSON.parse(line.slice('SN35_READY:'.length)) as {
					readonly handle: string;
					readonly port: number;
				};
				if (!/^bash-[a-f0-9]+$/.test(remote.handle) || !validPort(remote.port)) {
					throw new Error(`Invalid remote READY identity: ${line}`);
				}
				finish(undefined, remote);
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		};
		const onError = (error: Error): void => finish(error);
		const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
			finish(
				new Error(`The crash host exited before reporting READY (${code ?? signal}): ${stderr}`),
			);
		child.stderr?.on('data', onStderr);
		child.once('error', onError);
		child.once('exit', onExit);
	});
}

async function killChild(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = once(child, 'exit');
	child.kill('SIGKILL');
	await exited;
}

async function cleanupOrphan(
	remote: { readonly handle: string; readonly port: number } | undefined,
	nodePath: string,
): Promise<void> {
	const { workspace, bash, git } = await makeWorkspace();
	try {
		const listing = await runToolRoom(workspace, 'analyst', [action('ps', {})]);
		const processes = latest(listing.results, 'ps');
		const discovered = /\|\s*(bash-[a-f0-9]+)\s*\|\s*sensor-server-crash-host\s*\|/.exec(
			processes,
		)?.[1];
		if (remote !== undefined && discovered !== remote.handle) {
			throw new Error(`The READY server was not adopted by cleanup: ${processes}`);
		}
		if (discovered !== undefined) {
			const status = await runToolRoom(workspace, 'analyst', [
				action('status', { handle: discovered }, (text) => {
					if (!text.includes(`Process ${discovered} (sensor-server-crash-host) is running.`)) {
						throw new Error(`The orphan was not still running for cleanup: ${text}`);
					}
				}),
				dynamicAction(
					'bash',
					(results) => {
						const path = outputPath(latest(results, 'status'));
						return { command: `cat -- ${shellQuote(path)}`, wait: 30 };
					},
					expectSuccess('Read the retained orphan process output'),
				),
				action('cancel', { handle: discovered }, expectCancelled(discovered)),
			]);
			const port = readyPort(latest(status.results, 'bash'));
			if (remote !== undefined && port !== remote.port) {
				throw new Error(`The orphan port changed from ${remote.port} to ${port}.`);
			}
			await withEnv(bash, 'analyst', async (env) => {
				const result = await run(
					env,
					`${shellQuote(nodePath)} --input-type=module -e ${shellQuote(`fetch('http://127.0.0.1:${port}/').then(()=>process.exit(1),()=>console.log('stopped'))`)}`,
				);
				if (result.code !== 0 || !result.output.includes('stopped')) {
					throw new Error(
						`The orphan port ${port} remained open after cancellation: ${result.output}`,
					);
				}
			});
		} else if (remote !== undefined) {
			throw new Error(`The READY server ${remote.handle} was missing during orphan cleanup.`);
		}
	} finally {
		await disposeWorkspace(workspace, bash, git);
	}
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function outputPath(text: string): string {
	const path = /Output: (\/[^\s\]]+)\./.exec(text)?.[1];
	if (path === undefined) throw new Error(`The orphan status has no process output path: ${text}`);
	return path;
}

function validPort(port: number): boolean {
	return Number.isInteger(port) && port >= 1 && port <= 65535;
}
