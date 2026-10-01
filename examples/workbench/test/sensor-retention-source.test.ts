import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { directoryBackend } from '@ambionframework/just-bash';
import { BACKGROUND_CONTEXT } from '@ambionframework/workspace';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { BashBackend, WorkspaceEnv } from '../../../packages/workspace/src/backend.ts';
import type { ObjectEnv } from '../../../packages/workspace/src/object-backend.ts';
import { fileObjectBackend } from '../../../packages/workspace/src/object-files.ts';
import { openResource } from '../../../packages/workspace/src/resource.ts';
import { retainSensorObservation } from '../../../packages/workspace/src/sensor-retention.ts';
import { createSensorClient } from '../../../packages/workspace/src/sensors.ts';
import type { SnapshotStore } from '../../../packages/workspace/src/snapshots.ts';
import { createRestoreTool } from '../../../packages/workspace/src/snapshots.ts';
import { callAs } from '../../../packages/workspace/test/support/backends.ts';

const template = fileURLToPath(new URL('../templates/sensor-server/', import.meta.url));
const host = { name: 'workspace-host' };

describe('sensor evidence retention with Git launch provenance', () => {
	it('retains a dirty launch and restores its observation after later commits and server shutdown', async () => {
		const root = await mkdtemp(join(tmpdir(), 'ambion-retention-source-'));
		onTestFinished(() => rm(root, { recursive: true, force: true }));
		const checkout = join(root, 'sensor-server');
		const dataPath = join(root, 'sensor-data');
		const snapshotPath = join(root, 'snapshot-files');
		await cp(template, checkout, {
			recursive: true,
			filter: (path) => !path.split(sep).some((part) => part === '.git' || part === 'node_modules'),
		});
		await linkDependencies(checkout);
		git(checkout, ['init', '-b', 'main']);
		git(checkout, ['config', 'user.name', 'Sensor Retention Test']);
		git(checkout, ['config', 'user.email', 'sensor-retention@example.invalid']);
		git(checkout, ['add', '.']);
		git(checkout, ['commit', '-m', 'Initial sensor template']);
		const launchCommit = git(checkout, ['rev-parse', 'HEAD']);

		const serverFile = join(checkout, 'server.mjs');
		const templateSource = await readFile(serverFile, 'utf8');
		const dirtySource = templateSource.replace(
			'Fixture run: the indicator is green.',
			'Fixture run: the indicator is green; retention captured this dirty launch.',
		);
		expect(dirtySource).not.toBe(templateSource);
		await writeFile(serverFile, dirtySource);

		const server = await start(checkout, dataPath);
		onTestFinished(() => server.stop());
		const index = await server.client.index();
		expect(index.source).toEqual({
			repository: 'lab/sensor-fixture',
			commit: launchCommit,
			branch: 'main',
			dirty: true,
		});
		const request = { api: 1 as const };
		const response = await server.client.observe('bench-camera', request);
		expect(response).toEqual({
			api: 1,
			observations: [
				{
					at: '2025-01-02T03:04:06.000Z',
					parts: [
						{
							kind: 'frame',
							file: expect.any(String),
							mediaType: 'image/png',
						},
					],
				},
			],
		});
		const part = response.observations[0]?.parts[0];
		if (part?.kind !== 'frame') throw new Error('Expected a camera frame observation.');
		const image = await server.client.file(part.file);
		const imageBytes = new Uint8Array(image.bytes);
		const digest = createHash('sha256').update(imageBytes).digest('hex');
		expect(part.file).toBe(digest);
		expect(image.mediaType).toBe('image/png');
		const notes = await server.client.observe('operator-notes');
		expect(notes.observations).toEqual([
			{
				at: '2025-01-02T03:04:07.000Z',
				parts: [
					{
						kind: 'text',
						text: 'Fixture run: the indicator is green; retention captured this dirty launch.',
					},
				],
			},
		]);

		const storeFixture = await createStore(snapshotPath);
		onTestFinished(() => storeFixture.dispose());
		const retained = await retainSensorObservation(
			storeFixture.store,
			{ name: 'observer' },
			{
				sensor: 'bench-one/bench-camera',
				process: 'bash-111111111111',
				connection: { name: 'bench-one', owner: 'sensor-owner', port: server.port },
				request,
				source: index.source,
			},
			response,
			new Map([[digest, imageBytes]]),
		);
		expect(retained.manifest.source).toEqual(index.source);
		await server.stop();

		const laterSource = dirtySource.replace(
			'the indicator is green; retention captured this dirty launch.',
			'the indicator is green; committed after retention.',
		);
		await writeFile(serverFile, laterSource);
		git(checkout, ['add', 'server.mjs']);
		git(checkout, ['commit', '-m', 'Commit sensor fixture change after launch']);
		const laterCommit = git(checkout, ['rev-parse', 'HEAD']);
		expect(laterCommit).not.toBe(launchCommit);
		expect(git(checkout, ['status', '--porcelain'])).toBe('');

		const restored = await createRestoreTool(storeFixture.store).invoke(
			{ ref: retained.manifestRef },
			callAs('reviewer'),
		);
		const manifestPath = (restored as { details: { path: string } }).details.path;
		const manifestBytes = await storeFixture.store.bash({ name: 'reviewer' }, async (env) => {
			const read = await env.readBinaryFile(manifestPath, BACKGROUND_CONTEXT);
			if (!read.ok) throw read.error;
			return read.value;
		});
		const manifest = JSON.parse(
			new TextDecoder().decode(manifestBytes),
		) as typeof retained.manifest;
		expect(manifest).toMatchObject({
			api: 1,
			sensor: 'bench-one/bench-camera',
			process: 'bash-111111111111',
			connection: { name: 'bench-one', owner: 'sensor-owner', port: server.port },
			request,
			source: index.source,
			observations: response.observations,
			files: [{ digest }],
		});
		expect(manifest.observations).toEqual(response.observations);
		expect(manifest.observations).toContainEqual({
			at: '2025-01-02T03:04:06.000Z',
			parts: [{ kind: 'frame', file: digest, mediaType: 'image/png' }],
		});
		expect(manifest.source).toEqual({
			repository: 'lab/sensor-fixture',
			commit: launchCommit,
			branch: 'main',
			dirty: true,
		});
		const retainedFile = manifest.files[0];
		if (!retainedFile) throw new Error('The retained manifest has no frame file.');
		const restoredFile = await createRestoreTool(storeFixture.store).invoke(
			{ ref: retainedFile.ref },
			callAs('reviewer'),
		);
		const imagePath = (restoredFile as { details: { path: string } }).details.path;
		const restoredBytes = await storeFixture.store.bash({ name: 'reviewer' }, async (env) => {
			const read = await env.readBinaryFile(imagePath, BACKGROUND_CONTEXT);
			if (!read.ok) throw read.error;
			return read.value;
		});
		expect([...restoredBytes]).toEqual([...imageBytes]);
		expect(createHash('sha256').update(restoredBytes).digest('hex')).toBe(digest);
	});
});

function git(cwd: string, args: string[]): string {
	const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
	if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
	return result.stdout.trim();
}

async function packageRoot(file: string, expectedName: string): Promise<string> {
	let directory = dirname(file);
	while (directory !== dirname(directory)) {
		try {
			const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
				name?: string;
			};
			if (manifest.name === expectedName) return realpath(directory);
		} catch {
			// Keep walking from generated declarations and JavaScript files.
		}
		directory = dirname(directory);
	}
	throw new Error(`Could not find package ${expectedName}.`);
}

async function linkDependencies(project: string): Promise<void> {
	const workspaceFile = fileURLToPath(import.meta.resolve('@ambionframework/workspace/sensors'));
	const typeboxFile = fileURLToPath(import.meta.resolve('typebox/value'));
	const workspaceRoot = await packageRoot(workspaceFile, '@ambionframework/workspace');
	const typeboxRoot = await packageRoot(typeboxFile, 'typebox');
	const modules = join(project, 'node_modules');
	const scope = join(modules, '@ambionframework');
	await mkdir(scope, { recursive: true });
	await symlink(workspaceRoot, join(scope, 'workspace'), 'dir');
	await symlink(typeboxRoot, join(modules, 'typebox'), 'dir');
}

async function start(cwd: string, dataPath: string) {
	const child = spawn(process.execPath, ['server.mjs'], {
		cwd,
		env: {
			...process.env,
			AMBION_SENSOR_DATA_DIR: dataPath,
			AMBION_SENSOR_REPOSITORY: 'lab/sensor-fixture',
			PORT: '0',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let output = '';
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', (part: string) => (output += part));
	child.stderr.on('data', (part: string) => (output += part));
	const port = await new Promise<number>((resolvePort, reject) => {
		const timeout = setTimeout(
			() => reject(new Error(`Sensor server did not start: ${output}`)),
			5000,
		);
		child.stdout.on('data', (part: string) => {
			const match = part.match(/READY http:\/\/127\.0\.0\.1:(\d+)/);
			if (match?.[1] !== undefined) {
				clearTimeout(timeout);
				resolvePort(Number(match[1]));
			}
		});
		child.once('exit', (code) => {
			clearTimeout(timeout);
			reject(new Error(`Sensor server exited with ${code}: ${output}`));
		});
	}).catch(async (error: unknown) => {
		if (child.exitCode === null) {
			child.kill('SIGTERM');
			await new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
		}
		throw error;
	});
	return {
		port,
		client: createSensorClient(`http://127.0.0.1:${port}`),
		async stop() {
			if (child.exitCode !== null) return;
			child.kill('SIGTERM');
			await new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
		},
	};
}

async function createStore(root: string): Promise<{
	store: SnapshotStore;
	dispose(): Promise<void>;
}> {
	await mkdir(root, { recursive: true });
	const disk = directoryBackend(root);
	const backend: BashBackend = {
		...disk,
		connect: (agent, signal) => disk.connect(agent, signal),
	};
	const bash = openResource<WorkspaceEnv>({ name: 'source-retention-bash', backend });
	const objects = openResource<ObjectEnv>({
		name: 'source-retention-objects',
		backend: fileObjectBackend({ bash: bash.use, host, root: '/snapshots' }),
	});
	return {
		store: {
			workspace: 'sensor-source-retention',
			mirrorAgent: host,
			bash: bash.use,
			objects: objects.use,
		},
		async dispose() {
			await objects.dispose();
			await bash.dispose();
		},
	};
}
