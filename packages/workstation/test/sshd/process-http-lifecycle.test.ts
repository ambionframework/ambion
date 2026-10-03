/**
 * Acceptance: a process that serves HTTP on `$PORT`, on a real server. The
 * sensor-server template starts through `bash` in a host that then crashes.
 * A second agent reads it with `fetch` before and after the crash, the owner
 * cancels it, and `fetch` refuses the name.
 */

import { createHash } from 'node:crypto';
import { chmod, cp, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromDirectory, openWorkspace, type Workspace } from '@ambionframework/workspace';
import type { RepositoryRegistration } from '@ambionframework/workspace/git';
import { describe, expect, it, onTestFinished } from 'vitest';
import { workstationBackend, workstationGitBackend } from '../../src/index.ts';
import {
	action,
	dynamicAction,
	expectCancelled,
	expectSuccess,
	latest,
	refOf,
	runToolRoom,
} from '../support/process-http.ts';
import { killChild, openRecovery, startCrashHost } from '../support/process-http-crash.ts';
import { configPath, keyOf, options, readSetup, run, WIPE, withEnv } from '../support/sshd.ts';

const templatePath = fileURLToPath(
	new URL('../../../../examples/workbench/templates/sensor-server/', import.meta.url),
);
const OWNER = 'analyst';
const READER = 'reviewer';
const OBSERVATION = { process: 'sensor-server', path: '/room-temperature/observe' };

describe.skipIf(configPath === undefined)('process HTTP on OpenSSH', () => {
	it('reads a template process as a second agent across a host crash, a cancel, and a refusal', async () => {
		const rig = await openRig();
		onTestFinished(() => rig.dispose());
		const runtime = await stageRuntime();
		onTestFinished(() => rm(runtime.root, { recursive: true, force: true }));
		await clearHomes();
		await forkTemplate(rig.workspace, runtime);
		const frame = await readFile(join(templatePath, 'fixtures/frame.png'));
		const digest = createHash('sha256').update(frame).digest('hex');

		const host = await startCrashHost(launchCommand(runtime.node));
		onTestFinished(() => killChild(host.child));

		const listed = await runToolRoom(rig.workspace, OWNER, [action('ps', {})]);
		expect(latest(listed.results, 'ps')).toMatch(
			new RegExp(`\\|\\s*${host.handle}\\s*\\|\\s*sensor-server\\s*\\|\\s*${host.port}\\s*\\|`),
		);
		const before = await runToolRoom(rig.workspace, READER, [
			action('fetch', OBSERVATION, expectFetched(host.handle, 'application/json')),
			action('fetch', { process: 'sensor-server', path: `/files/${digest}` }, (text) => {
				expect(text).toContain(`${frame.length} bytes`);
				expect(text).toContain('image/png');
			}),
			dynamicAction('say', (results) => ({
				text: 'The observation and the frame are retained.',
				refs: results.filter((one) => one.tool === 'fetch').map((one) => refOf(one.text)),
			})),
		]);
		expect(latest(before.results, 'fetch')).toContain('image/png');
		expect(
			before.messages.some((message) => message.kind === 'said' && message.refs?.length === 2),
		).toBe(true);

		await killChild(host.child);

		const recovery = await openRecovery();
		onTestFinished(async () => {
			await recovery.workspace.dispose();
			await recovery.bash.dispose?.();
		});
		const adopted = await runToolRoom(recovery.workspace, OWNER, [action('ps', {})]);
		expect(latest(adopted.results, 'ps')).toContain(host.handle);
		const after = await runToolRoom(recovery.workspace, READER, [
			action('fetch', OBSERVATION, expectFetched(host.handle, 'application/json')),
		]);
		expect(latest(after.results, 'fetch')).toContain('21.5');

		await runToolRoom(recovery.workspace, OWNER, [
			action('cancel', { handle: host.handle }, expectCancelled(host.handle)),
		]);
		const refused = await runToolRoom(recovery.workspace, READER, [action('fetch', OBSERVATION)]);
		expect(latest(refused.results, 'fetch')).toContain(
			"No running process is named 'sensor-server'",
		);
		await verifyStopped(runtime.node, host.port);
	}, 300_000);
});

/** Require the text of a `fetch` of the process `handle` with status 200 and `mediaType`. */
function expectFetched(handle: string, mediaType: string) {
	return (text: string): void => {
		if (!text.includes(`(${handle}): 200, ${mediaType},`) || !text.includes('Snapshot ref: ')) {
			throw new Error(`The fetch did not read ${handle}: ${text}`);
		}
	};
}

interface Rig {
	readonly workspace: Workspace;
	dispose(): Promise<void>;
}

interface Runtime {
	readonly root: string;
	readonly node: string;
	readonly typebox: string;
}

async function openRig(): Promise<Rig> {
	const ssh = await options();
	const setup = await readSetup();
	const template: RepositoryRegistration = {
		source: await fromDirectory(templatePath),
		description: 'A deterministic server for the process HTTP acceptance.',
	};
	const git = workstationGitBackend({
		server: setup.host,
		port: setup.port,
		hostKey: setup.hostKey,
		account: { username: 'lab-git', privateKey: await keyOf(setup, 'lab-git') },
		templates: { 'sensor-server': template },
	});
	const bash = workstationBackend({ ...ssh, git });
	const workspace = openWorkspace({ name: 'lab', backend: { bash }, audit: {} });
	let disposed = false;
	return {
		workspace,
		dispose: async () => {
			if (disposed) return;
			disposed = true;
			await workspace.dispose();
			await bash.dispose?.();
			await git.dispose?.();
		},
	};
}

async function clearHomes(): Promise<void> {
	const backend = workstationBackend(await options());
	try {
		for (const account of [OWNER, READER, 'lab-git']) {
			const result = await withEnv(backend, account, (env) => run(env, WIPE));
			if (result.code !== 0) {
				throw new Error(
					`Could not clear ${account}'s home (exit ${result.code}): ${result.output}`,
				);
			}
		}
		const repositories = await withEnv(backend, 'lab-git', (env) =>
			run(env, 'rm -rf -- ~/repos ~/.ssh/authorized_keys.ambion'),
		);
		if (repositories.code !== 0) {
			throw new Error(`Could not clear the repositories (exit ${repositories.code}).`);
		}
	} finally {
		await backend.dispose?.();
	}
}

/** Fork the template into the home of the owner, and give the clone its one dependency. */
async function forkTemplate(workspace: Workspace, runtime: Runtime): Promise<void> {
	await runToolRoom(workspace, OWNER, [
		action(
			'fork',
			{ source: 'templates/sensor-server', name: 'sensor-server', clone: '~/sensor-server' },
			(text) => {
				if (!text.includes('Forked templates/sensor-server to analyst/sensor-server.')) {
					throw new Error(`The sensor template fork failed: ${text}`);
				}
			},
		),
		action(
			'bash',
			{
				command: `mkdir -p ~/sensor-server/node_modules && cp -R ${shellQuote(runtime.typebox)} ~/sensor-server/node_modules/typebox`,
				wait: 30,
			},
			expectSuccess('Install the dependency of the template'),
		),
	]);
}

/** A Node binary and the one dependency of the template, readable by every account. */
async function stageRuntime(): Promise<Runtime> {
	const root = await mkdtemp(join(tmpdir(), 'ambion-process-http-'));
	const workspaceRoot = fileURLToPath(new URL('../../../workspace/', import.meta.url));
	const node = join(root, 'node');
	const typebox = join(root, 'node_modules/typebox');
	await chmod(root, 0o755);
	await cp(await realpath(process.execPath), node);
	await chmod(node, 0o755);
	await cp(join(workspaceRoot, 'node_modules/typebox'), typebox, {
		recursive: true,
		dereference: true,
	});
	return { root, node, typebox };
}

/** The server prints nothing and listens on the `$PORT` that the workspace sets. */
function launchCommand(node: string): string {
	return `cd ~/sensor-server && AMBION_SENSOR_DATA_DIR="$HOME/sensor-data/http" ${shellQuote(node)} server.mjs`;
}

async function verifyStopped(node: string, port: number): Promise<void> {
	const checker = workstationBackend(await options());
	try {
		await withEnv(checker, OWNER, async (env) => {
			const result = await run(
				env,
				`${shellQuote(node)} --input-type=module -e ${shellQuote(`fetch('http://127.0.0.1:${port}/').then(()=>process.exit(1),()=>console.log('stopped'))`)}`,
			);
			expect(result.code).toBe(0);
			expect(result.output).toContain('stopped');
		});
	} finally {
		await checker.dispose?.();
	}
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
