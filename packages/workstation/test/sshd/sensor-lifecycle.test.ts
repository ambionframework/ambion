/** SN35 acceptance: one real room uses the workstation Git, process, and sensor tools. */

import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmod, cp, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromDirectory, openWorkspace, type Workspace } from '@ambionframework/workspace';
import type { RepositoryRegistration } from '@ambionframework/workspace/git';
import { describe, expect, it, onTestFinished } from 'vitest';
import { workstationBackend, workstationGitBackend } from '../../src/index.ts';
import {
	disposeSensorCrashRecovery,
	recoverSensorCrash,
	startSensorLifecycleCrashHost,
} from '../support/sensor-crash.ts';
import {
	type Action,
	action,
	dynamicAction,
	expectCancelled,
	expectExitCode,
	expectSuccess,
	latest,
	manifestRef,
	processHandle,
	readyPort,
	runToolRoom,
} from '../support/sensor-lifecycle.ts';
import { configPath, keyOf, options, readSetup, run, WIPE, withEnv } from '../support/sshd.ts';

const templatePath = fileURLToPath(
	new URL('../../../../examples/workbench/templates/sensor-server/', import.meta.url),
);
const OWNER = 'analyst';
const READER = 'reviewer';
const WORKSPACE = 'lab';

describe.skipIf(configPath === undefined)('sensor lifecycle on OpenSSH', () => {
	it('forks, saves, launches, replaces, rolls back, adopts, restores, and disposes', async () => {
		const rig = await openLifecycleWorkspace();
		const workspace = rig.workspace;
		onTestFinished(() => disposeWorkspace(rig));
		const runtime = await stageRuntimeAssets();
		onTestFinished(() => rm(runtime.root, { recursive: true, force: true }));
		let crashChild: Awaited<ReturnType<typeof startSensorLifecycleCrashHost>>['child'] | undefined;
		let recoveryDisposed = false;
		let crashRecovery: Awaited<ReturnType<typeof recoverSensorCrash>> | undefined;
		onTestFinished(async () => {
			if (
				crashChild !== undefined &&
				crashChild.exitCode === null &&
				crashChild.signalCode === null
			) {
				crashChild.kill('SIGKILL');
				await once(crashChild, 'exit');
			}
		});
		await clearHomes();

		const a = await deployVersion(workspace, runtime, '22.25', 'Save sensor version A.', true);
		const b = await deployVersion(workspace, runtime, '24.0', 'Save sensor version B.');
		const rollback = await deployRollback(workspace, runtime, a.commit);
		expect(a.commit).not.toBe(b.commit);
		expect(rollback.commit).toBe(a.commit);
		expect(a.observation).toContain('22.25');
		expect(b.observation).toContain('24');
		expect(rollback.observation).toContain('22.25');
		expect(a.source).toContain(a.commit);
		expect(b.source).toContain(b.commit);
		expect(rollback.source).toContain(a.commit);

		const frameDigest = createHash('sha256')
			.update(await readFile(`${templatePath}/fixtures/frame.png`))
			.digest('hex');
		const frame = await observeFrame(workspace, runtime, frameDigest);
		expect(frame.checksum).toBe(frameDigest);
		for (const item of [a, b, rollback, frame]) expect(item.cited).toBe(true);

		const dirty = await runToolRoom(workspace, OWNER, [
			action(
				'bash',
				{
					command: `cd ~/sensor-server && git switch -c sn35-dirty ${a.commit} && sed -i 's/22.25/22.5/' server.mjs && git status --short`,
					wait: 30,
				},
				expectSuccess('Create the dirty launch branch'),
			),
		]);
		expect(latest(dirty.results, 'bash')).toContain('server.mjs');
		const crashHost = await startSensorLifecycleCrashHost(runtime.node);
		crashChild = crashHost.child;
		crashHost.child.kill('SIGKILL');
		await once(crashHost.child, 'exit');
		const committedDirty = await runToolRoom(workspace, OWNER, [
			action(
				'bash',
				{
					command:
						"cd ~/sensor-server && git add server.mjs && git commit -m 'Save the running dirty sensor' && git push -u origin sn35-dirty && git rev-parse HEAD",
					wait: 120,
				},
				expectSuccess('Commit and push the dirty launch edits'),
			),
		]);
		expect(latest(committedDirty.results, 'bash')).not.toContain('nothing to commit');
		const crash = await recoverSensorCrash({
			handle: crashHost.handle,
			port: crashHost.port,
			expectedCommit: a.commit,
			branch: 'sn35-dirty',
		});
		crashRecovery = crash;
		onTestFinished(async () => {
			if (!recoveryDisposed && crashRecovery !== undefined) {
				recoveryDisposed = true;
				await disposeSensorCrashRecovery(crashRecovery);
			}
		});
		expect(crash.source).toContain(`${a.commit} (sn35-dirty) [dirty]`);
		expect(crash.observation).toContain('22.5');
		expect(crash.citationRecorded).toBe(true);

		const refs = {
			a: a.ref,
			b: b.ref,
			rollback: rollback.ref,
			frame: frame.ref,
			crash: crash.ref,
			file: frame.fileRef,
		};
		await disposeSensorCrashRecovery(crash);
		recoveryDisposed = true;
		await verifyStopped(runtime.node, crash.port);
		await disposeWorkspace(rig);
		await restoreAcrossAccounts(refs, frameDigest, a.commit, b.commit, runtime);
	}, 300_000);

	it('adopts and cancels a READY server when startup response times out', async () => {
		const rig = await openLifecycleWorkspace();
		const runtime = await stageRuntimeAssets();
		onTestFinished(async () => {
			await disposeWorkspace(rig);
			await rm(runtime.root, { recursive: true, force: true });
		});
		await clearHomes();
		await deployVersion(
			rig.workspace,
			runtime,
			'22.25',
			'Prepare the startup cleanup fixture.',
			true,
		);
		await expect(
			startSensorLifecycleCrashHost(runtime.node, {
				startupTimeoutMs: 50,
				responseDelayMs: 10_000,
			}),
		).rejects.toThrow(
			/remote READY bash-[a-f0-9]+ on port \d+; orphan was cancelled and port closed/,
		);
	}, 180_000);
});

interface Observation {
	readonly commit: string;
	readonly observation: string;
	readonly ref: string;
	readonly source: string;
	readonly cited: boolean;
}

interface LifecycleWorkspace {
	readonly workspace: Workspace;
	readonly bash: ReturnType<typeof workstationBackend>;
	readonly git: ReturnType<typeof workstationGitBackend>;
	disposed: boolean;
}

interface RuntimeAssets {
	readonly root: string;
	readonly node: string;
	readonly workspaceDist: string;
	readonly workspacePackage: string;
	readonly typebox: string;
}

async function openLifecycleWorkspace(): Promise<LifecycleWorkspace> {
	const ssh = await options();
	const setup = await readSetup();
	const template: RepositoryRegistration = {
		source: await fromDirectory(templatePath),
		description: 'A deterministic server for SN35 lifecycle acceptance.',
	};
	const git = workstationGitBackend({
		server: setup.host,
		port: setup.port,
		hostKey: setup.hostKey,
		account: { username: 'lab-git', privateKey: await keyOf(setup, 'lab-git') },
		templates: { 'sensor-server': template },
	});
	const bash = workstationBackend(ssh);
	return {
		workspace: openWorkspace({ name: WORKSPACE, backend: { bash, git }, audit: {} }),
		bash,
		git,
		disposed: false,
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
			throw new Error(
				`Could not clear lab-git repositories (exit ${repositories.code}): ${repositories.output}`,
			);
		}
	} finally {
		await backend.dispose?.();
	}
}

async function deployVersion(
	workspace: Workspace,
	runtime: RuntimeAssets,
	value: string,
	message: string,
	first = false,
): Promise<Observation> {
	const actions: Action[] = [];
	if (first) {
		actions.push(
			action(
				'fork',
				{
					source: 'templates/sensor-server',
					name: 'sensor-server',
					clone: '~/sensor-server',
				},
				(text) => {
					if (!text.includes('Forked templates/sensor-server to analyst/sensor-server.')) {
						throw new Error(`The sensor template fork failed: ${text}`);
					}
				},
			),
		);
		actions.push(
			action(
				'bash',
				{ command: setupCloneAndBranch(runtime), wait: 30 },
				expectSuccess('Provision the fork checkout and runtime dependencies'),
			),
		);
	}
	actions.push(
		action(
			'bash',
			{
				command: `cd ~/sensor-server && sed -i 's/${first ? '21.6' : '22.25'}/${value}/' server.mjs`,
				wait: 30,
			},
			expectSuccess(`Customize sensor version ${value}`),
		),
		action('bash', {
			command: `cd ~/sensor-server && PATH=${shellQuote(dirname(runtime.node))}:"$PATH" npm test`,
			wait: 0,
		}),
		dynamicAction(
			'wait',
			(results) => ({
				handles: [processHandle(latest(results, 'bash'))],
				timeout: 120,
			}),
			(text, prior) => {
				expectExitCode(
					text,
					0,
					`Complete template validation for sensor version ${value}`,
					processHandle(latest(prior, 'bash')),
				);
			},
		),
		action(
			'bash',
			{
				command: `cd ~/sensor-server && git add server.mjs && git commit -m '${message}' && git push -u origin lifecycle && git rev-parse HEAD`,
				wait: 120,
			},
			expectSuccess(`Commit and push sensor version ${value}`),
		),
		dynamicAction(
			'bash',
			() => ({
				command: launchCommand(runtime.node),
				name: 'sensor-server',
				wait: 1,
				timeout: 86400,
			}),
			verifyReady,
		),
		connectAction(),
		action('observe', { sensor: 'bench/room-temperature' }),
		citationAction('The measurement is retained.'),
		cancelAction(),
	);
	const runResult = await runToolRoom(workspace, OWNER, actions);
	const commitText = [...runResult.results]
		.reverse()
		.find(
			(result) => result.tool === 'bash' && /(?:^|\n)[0-9a-f]{40}(?:\s|$)/.test(result.text),
		)?.text;
	const commit =
		commitText === undefined ? undefined : /(?:^|\n)([0-9a-f]{40})(?:\s|$)/.exec(commitText)?.[1];
	if (commit === undefined) throw new Error(`The saved commit is missing: ${commitText}`);
	const observation = latest(runResult.results, 'observe');
	const ref = manifestRef(observation);
	await verifyStopped(runtime.node, readyPort(lastReady(runResult.results)));
	return {
		commit,
		observation,
		ref,
		source: latest(runResult.results, 'connect'),
		cited: citationFound(runResult.messages, ref),
	};
}

async function deployRollback(
	workspace: Workspace,
	runtime: RuntimeAssets,
	commit: string,
): Promise<Observation> {
	const runResult = await runToolRoom(workspace, OWNER, [
		action(
			'bash',
			{
				command: `printf 'sn35-marker\\n' > "$HOME/sensor-data/sn35/operator-marker.txt" && cd ~/sensor-server && git switch lifecycle && git reset --hard ${commit} && git rev-parse HEAD`,
				wait: 30,
			},
			expectSuccess('Roll back the sensor checkout and preserve acquisition data'),
		),
		dynamicAction(
			'bash',
			() => ({
				command: launchCommand(runtime.node),
				name: 'sensor-server-rollback',
				wait: 1,
				timeout: 86400,
			}),
			verifyReady,
		),
		connectAction(),
		action('observe', { sensor: 'bench/room-temperature' }),
		citationAction('The earlier measurement is retained.'),
		action(
			'bash',
			{
				command:
					'test "$(cat "$HOME/sensor-data/sn35/operator-marker.txt")" = sn35-marker && echo rollback-data-survived',
				wait: 30,
			},
			expectSuccess('Verify acquisition data survived code rollback'),
		),
		cancelAction(),
	]);
	expect(latest(runResult.results, 'bash')).toContain('rollback-data-survived');
	const observation = latest(runResult.results, 'observe');
	const ref = manifestRef(observation);
	await verifyStopped(runtime.node, readyPort(lastReady(runResult.results)));
	return {
		commit,
		observation,
		ref,
		source: latest(runResult.results, 'connect'),
		cited: citationFound(runResult.messages, ref),
	};
}

async function observeFrame(workspace: Workspace, runtime: RuntimeAssets, digest: string) {
	const runResult = await runToolRoom(workspace, OWNER, [
		dynamicAction(
			'bash',
			() => ({
				command: launchCommand(runtime.node),
				name: 'sensor-frame',
				wait: 1,
				timeout: 86400,
			}),
			verifyReady,
		),
		connectAction(),
		action('observe', { sensor: 'bench/bench-camera' }),
		citationAction('The frame is retained.'),
		dynamicAction(
			'bash',
			(prior) => {
				const observation = latest(prior, 'observe');
				const path = /Frame at \S+: (\/\S+)/.exec(observation)?.[1];
				if (path === undefined) throw new Error('The frame export path is missing.');
				return { command: `printf 'changed export bytes\\n' > '${path}'`, wait: 30 };
			},
			expectSuccess('Edit the observation export'),
		),
		dynamicAction('restore', (prior) => ({
			ref: manifestRef(latest(prior, 'observe')),
			path: '~/restored/frame-manifest.json',
		})),
		cancelAction(),
	]);
	const observation = latest(runResult.results, 'observe');
	const ref = manifestRef(observation);
	await verifyStopped(runtime.node, readyPort(lastReady(runResult.results)));
	const fileRefRun = await runToolRoom(workspace, OWNER, [
		action(
			'bash',
			{
				command: `${shellQuote(runtime.node)} --input-type=module -e ${shellQuote("import fs from 'node:fs'; const m=JSON.parse(fs.readFileSync('./restored/frame-manifest.json','utf8')); console.log('FILE_REF='+m.files[0].ref)")}`,
				wait: 30,
			},
			expectSuccess('Read the retained frame manifest'),
		),
	]);
	const fileRef = /FILE_REF=(ambion:\/\/\S+)/.exec(latest(fileRefRun.results, 'bash'))?.[1];
	if (fileRef === undefined) throw new Error('The retained frame has no snapshot ref.');
	const restored = await runToolRoom(workspace, OWNER, [
		action('restore', { ref: fileRef, path: '~/restored/frame.png' }),
		action(
			'bash',
			{
				command: `${shellQuote(runtime.node)} --input-type=module -e ${shellQuote(`import fs from 'node:fs'; import crypto from 'node:crypto'; if(crypto.createHash('sha256').update(fs.readFileSync('./restored/frame.png')).digest('hex')!=='${digest}') process.exit(1); console.log('snapshot-bytes-unchanged')`)}`,
				wait: 30,
			},
			expectSuccess('Verify restored frame snapshot bytes'),
		),
	]);
	expect(latest(restored.results, 'bash')).toContain('snapshot-bytes-unchanged');
	return {
		ref,
		fileRef,
		port: readyPort(lastReady(runResult.results)),
		cited: citationFound(runResult.messages, ref),
		checksum: digest,
	};
}

async function restoreAcrossAccounts(
	refs: { a: string; b: string; rollback: string; frame: string; crash: string; file: string },
	digest: string,
	aCommit: string,
	bCommit: string,
	runtime: RuntimeAssets,
): Promise<void> {
	const rig = await openLifecycleWorkspace();
	try {
		const restored = await runToolRoom(rig.workspace, READER, [
			action(
				'bash',
				{
					command:
						'if test -r /home/analyst/sensor-server/server.mjs; then echo owner-home-readable; exit 1; else echo separate-home; fi',
					wait: 30,
				},
				expectSuccess('Verify the reviewer cannot read the analyst home'),
			),
			action('restore', { ref: refs.a, path: '~/restored/a.json' }),
			action('restore', { ref: refs.b, path: '~/restored/b.json' }),
			action('restore', { ref: refs.rollback, path: '~/restored/rollback.json' }),
			action('restore', { ref: refs.frame, path: '~/restored/frame-manifest.json' }),
			action('restore', { ref: refs.crash, path: '~/restored/crash.json' }),
			action('restore', { ref: refs.file, path: '~/restored/frame.png' }),
			action(
				'bash',
				{
					command: `${shellQuote(runtime.node)} --input-type=module -e ${shellQuote(
						[
							"import fs from 'node:fs'; import crypto from 'node:crypto';",
							"const a=JSON.parse(fs.readFileSync('./restored/a.json','utf8')),b=JSON.parse(fs.readFileSync('./restored/b.json','utf8')),r=JSON.parse(fs.readFileSync('./restored/rollback.json','utf8')),d=JSON.parse(fs.readFileSync('./restored/crash.json','utf8'));",
							`if(a.source.commit!=='${aCommit}'||b.source.commit!=='${bCommit}'||r.source.commit!=='${aCommit}'||a.source.dirty!==false||b.source.dirty!==false||r.source.dirty!==false||d.source.commit!=='${aCommit}'||d.source.branch!=='sn35-dirty'||d.source.dirty!==true) throw new Error('restored launch provenance mismatch');`,
							"if(a.observations[0].at!=='2025-01-02T03:04:05.000Z'||a.observations[0].parts[0].values[1]!==22.25||b.observations[0].parts[0].values[1]!==24||r.observations[0].parts[0].values[1]!==22.25||d.observations[0].parts[0].values[1]!==22.5) throw new Error('restored observations mismatch');",
							`if(crypto.createHash('sha256').update(fs.readFileSync('./restored/frame.png')).digest('hex')!=='${digest}') throw new Error('restored frame digest mismatch'); console.log('restored-evidence-verified');`,
						].join('\n'),
					)}`,
					wait: 30,
				},
				expectSuccess('Verify restored manifests, measurements, and frame bytes'),
			),
		]);
		expect(restored.results.find((result) => result.tool === 'bash')?.text).toContain(
			'separate-home',
		);
		expect(latest(restored.results, 'bash')).toContain('restored-evidence-verified');
	} finally {
		await disposeWorkspace(rig);
	}
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

async function disposeWorkspace(rig: LifecycleWorkspace): Promise<void> {
	if (rig.disposed) return;
	rig.disposed = true;
	await rig.workspace.dispose();
	await rig.bash.dispose?.();
	await rig.git.dispose?.();
}

function connectAction() {
	return dynamicAction(
		'connect',
		(results) => {
			const ready = lastReady(results);
			return { name: 'bench', process: processHandle(ready), port: readyPort(ready) };
		},
		(text, prior) => {
			const handle = processHandle(lastReady(prior));
			if (!text.includes(`Connected bench on `) || !text.includes(`to process ${handle}.`)) {
				throw new Error(`The running sensor process was not connected: ${text}`);
			}
		},
	);
}

function citationAction(text: string) {
	return dynamicAction('say', (results) => ({
		text,
		refs: [manifestRef(latest(results, 'observe'))],
	}));
}

function cancelAction() {
	return dynamicAction(
		'cancel',
		(results) => ({ handle: processHandle(lastReady(results)) }),
		(text, prior) => expectCancelled(processHandle(lastReady(prior)))(text, prior),
	);
}

function verifyReady(text: string): void {
	const handle = processHandle(text);
	readyPort(text);
	if (!new RegExp(`^\\[Process ${handle}(?: \\([^)]+\\))? is running\\.`, 'm').test(text)) {
		throw new Error(`The sensor server did not remain running after readiness: ${text}`);
	}
}

function citationFound(
	messages: readonly { kind: string; refs?: readonly string[] }[],
	ref: string,
): boolean {
	return messages.some((message) => message.kind === 'said' && message.refs?.includes(ref));
}

function lastReady(results: readonly { tool: string; text: string }[]): string {
	const ready = [...results]
		.reverse()
		.find((result) => result.tool === 'bash' && result.text.includes('READY '));
	if (ready === undefined) throw new Error('No server process has printed its READY line.');
	return ready.text;
}

async function stageRuntimeAssets(): Promise<RuntimeAssets> {
	const root = await mkdtemp(join(tmpdir(), 'ambion-sn35-runtime-'));
	const workspaceRoot = fileURLToPath(new URL('../../../workspace/', import.meta.url));
	const node = join(root, 'node');
	const workspacePackageRoot = join(root, 'node_modules/@ambionframework/workspace');
	const typebox = join(root, 'node_modules/typebox');
	await chmod(root, 0o755);
	await cp(await realpath(process.execPath), node);
	await chmod(node, 0o755);
	await cp(join(workspaceRoot, 'dist'), join(workspacePackageRoot, 'dist'), {
		recursive: true,
		dereference: true,
	});
	await cp(join(workspaceRoot, 'package.json'), join(workspacePackageRoot, 'package.json'));
	await cp(join(workspaceRoot, 'node_modules/typebox'), typebox, {
		recursive: true,
		dereference: true,
	});
	return {
		root,
		node,
		workspaceDist: join(workspacePackageRoot, 'dist'),
		workspacePackage: join(workspacePackageRoot, 'package.json'),
		typebox,
	};
}

function setupCloneAndBranch(runtime: RuntimeAssets): string {
	return [
		'cd ~/sensor-server',
		'git config user.name "SN35 Acceptance"',
		'git config user.email sn35@example.invalid',
		'git switch -c lifecycle',
		'mkdir -p node_modules/@ambionframework/workspace node_modules',
		`cp -R ${shellQuote(runtime.workspaceDist)} node_modules/@ambionframework/workspace/dist`,
		`cp ${shellQuote(runtime.workspacePackage)} node_modules/@ambionframework/workspace/package.json`,
		`cp -R ${shellQuote(runtime.typebox)} node_modules/typebox`,
	].join(' && ');
}

function launchCommand(node: string): string {
	return `cd ~/sensor-server && AMBION_SENSOR_DATA_DIR="$HOME/sensor-data/sn35" PORT=0 ${shellQuote(node)} server.mjs`;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
