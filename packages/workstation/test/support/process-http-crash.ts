/** Start a process host, and read its process from a new workspace after a crash. */

import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { openWorkspace, type Workspace } from '@ambionframework/workspace';
import { workstationBackend } from '../../src/index.ts';
import { action, latest, runToolRoom } from './process-http.ts';
import { configPath, options } from './sshd.ts';

export interface CrashHost {
	readonly child: ChildProcess;
	readonly handle: string;
	readonly port: number;
}

/** A workspace of the analyst over the provisioned server, and the backend to dispose after it. */
export async function openRecovery(): Promise<{
	readonly workspace: Workspace;
	readonly bash: ReturnType<typeof workstationBackend>;
}> {
	const bash = workstationBackend(await options());
	return { workspace: openWorkspace({ name: 'lab', backend: { bash }, audit: {} }), bash };
}

/** Start `command` in a child host, and return the identity of its process. */
export async function startCrashHost(command: string, timeoutMs = 60_000): Promise<CrashHost> {
	const child = spawn(
		process.execPath,
		[
			'--experimental-strip-types',
			fileURLToPath(new URL('./process-http-crash-host.ts', import.meta.url)),
		],
		{
			cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
			stdio: ['ignore', 'pipe', 'pipe'],
			env: {
				...process.env,
				AMBION_WORKSTATION_SSHD: configPath ?? '',
				AMBION_PROCESS_HTTP_COMMAND: command,
			},
		},
	);
	try {
		const line = await readLine(child, timeoutMs);
		const started = JSON.parse(line) as { readonly handle: string; readonly port: number };
		if (!/^bash-[a-f0-9]+$/.test(started.handle) || !Number.isInteger(started.port)) {
			throw new Error(`The crash host returned an invalid process identity: ${line}`);
		}
		return { child, handle: started.handle, port: started.port };
	} catch (error) {
		await killChild(child);
		await cancelOrphan();
		throw error;
	}
}

/** Stop the child host with SIGKILL, so that nothing cleans up its process. */
export async function killChild(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = once(child, 'exit');
	child.kill('SIGKILL');
	await exited;
}

/** The first line the child writes to stdout. */
function readLine(child: ChildProcess, timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		let stdout = '';
		let stderr = '';
		const timeout = setTimeout(
			() => finish(new Error(`The crash host did not start its process in ${timeoutMs}ms.`)),
			timeoutMs,
		);
		const finish = (error?: Error, line?: string): void => {
			clearTimeout(timeout);
			child.stdout?.off('data', onStdout);
			child.stderr?.off('data', onStderr);
			child.off('error', finish);
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
		const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
			finish(new Error(`The crash host exited before startup (${code ?? signal}): ${stderr}`));
		child.stdout?.on('data', onStdout);
		child.stderr?.on('data', onStderr);
		child.once('error', finish);
		child.once('exit', onExit);
	});
}

/** Cancel a process that a failed startup left on the server. */
async function cancelOrphan(): Promise<void> {
	const { workspace, bash } = await openRecovery();
	try {
		const listing = await runToolRoom(workspace, 'analyst', [action('ps', {})]);
		const handle = /\|\s*(bash-[a-f0-9]+)\s*\|\s*sensor-server\s*\|/.exec(
			latest(listing.results, 'ps'),
		)?.[1];
		if (handle !== undefined)
			await runToolRoom(workspace, 'analyst', [action('cancel', { handle })]);
	} finally {
		await workspace.dispose();
		await bash.dispose?.();
	}
}
