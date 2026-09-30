import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSensorClient } from '@ambionframework/workspace/sensors';
import { describe, expect, it, onTestFinished } from 'vitest';
import { labRepositories } from '../src/repositories.ts';
import {
	runTemplateSensorConformance,
	templateSensorFixture,
} from './support/sensor-conformance.ts';

const template = fileURLToPath(new URL('../templates/sensor-server/', import.meta.url));

describe('the sensor server template', () => {
	// Allow three npm tests (each capped at 30s), Git operations, and server startup.
	it('is registered, forkable, and survives a customized Git push and fresh clone', async () => {
		const repositories = labRepositories(':memory:');
		onTestFinished(() => repositories.dispose?.());
		const git = await repositories.connect({ name: 'sensor-template-test' });
		const listed = await git.list('templates');
		const sensorTemplate = listed.find((repository) => repository.id === 'templates/sensor-server');
		expect(sensorTemplate?.description).toContain('sensor server');

		const fork = await git.fork('templates/sensor-server', 'sensor-server');
		expect(fork.ok).toBe(true);
		if (!fork.ok) throw new Error(`The sensor template could not be forked: ${fork.reason}`);
		const head = await git.resolve(fork.repository.id, { branch: fork.repository.defaultBranch });
		expect(head).toBeDefined();
		const commit = await git.show(fork.repository.id, head ?? '');
		expect(commit?.changes.map((change) => change.path)).toEqual(
			expect.arrayContaining(['server.mjs', 'package.json', 'test/server.test.mjs']),
		);

		const root = await mkdtemp(join(tmpdir(), 'ambion-sensor-lifecycle-'));
		onTestFinished(() => rm(root, { recursive: true, force: true }));
		const checkout = join(root, 'checkout');
		const remote = join(root, 'sensor-server.git');
		const fresh = join(root, 'fresh');
		await cp(template, checkout, {
			recursive: true,
			filter: (path) => !path.split(sep).some((part) => part === '.git' || part === 'node_modules'),
		});
		await linkDependencies(checkout);
		gitCommand(root, ['init', '--bare', remote]);
		gitCommand(checkout, ['init', '-b', 'main']);
		gitCommand(checkout, ['config', 'user.name', 'Sensor Template Test']);
		gitCommand(checkout, ['config', 'user.email', 'sensor-template@example.invalid']);
		gitCommand(checkout, ['remote', 'add', 'origin', remote]);
		gitCommand(checkout, ['add', '.']);
		gitCommand(checkout, ['commit', '-m', 'Fork sensor server template']);
		gitCommand(checkout, ['push', '-u', 'origin', 'main']);
		gitCommand(checkout, ['switch', '-c', 'calibrated']);

		const serverFile = join(checkout, 'server.mjs');
		const source = await readFile(serverFile, 'utf8');
		const broken = source.replace("kind: 'series',", "kind: 'invalid-series',");
		expect(broken).not.toBe(source);
		await writeFile(serverFile, broken);
		const rejected = npmTest(checkout);
		expect(rejected.status).not.toBe(0);
		expect(rejected.output).toContain('fixture fails the SN1 observation schema');

		const customized = broken
			.replace("kind: 'invalid-series',", "kind: 'series',")
			.replace('values: [21.5, 21.6, 21.4]', 'values: [21.5, 22.25, 21.4]');
		expect(customized).not.toBe(broken);
		await writeFile(serverFile, customized);
		const accepted = npmTest(checkout);
		expect(accepted.status, accepted.output).toBe(0);

		gitCommand(checkout, ['add', 'server.mjs']);
		gitCommand(checkout, ['commit', '-m', 'Calibrate room temperature fixture']);
		gitCommand(checkout, ['push', '-u', 'origin', 'calibrated']);
		const savedCommit = gitCommand(checkout, ['rev-parse', 'HEAD']);
		gitCommand(root, ['clone', '--branch', 'calibrated', remote, fresh]);
		await linkDependencies(fresh);
		const recloned = npmTest(fresh);
		expect(recloned.status, recloned.output).toBe(0);
		expect(gitCommand(fresh, ['rev-parse', 'HEAD'])).toBe(savedCommit);

		const server = await start(fresh, join(root, 'sensor-data'));
		onTestFinished(() => server.stop());
		const index = await server.client.index();
		expect(index.source).toMatchObject({
			repository: 'agent/sensors',
			commit: savedCommit,
			branch: 'calibrated',
			dirty: false,
		});
		const result = await server.client.observe('room-temperature');
		const series = result.observations[0]?.parts[0];
		expect(series?.kind).toBe('series');
		if (series?.kind !== 'series')
			throw new Error('The calibrated fixture is not a numeric series.');
		expect(series.values).toEqual([21.5, 22.25, 21.4]);
		const frameBytes = await readFile(join(fresh, 'fixtures', 'frame.png'));
		const frameDigest = createHash('sha256').update(frameBytes).digest('hex');
		await runTemplateSensorConformance(
			`http://127.0.0.1:${server.port}`,
			templateSensorFixture(frameDigest, frameBytes, [21.5, 22.25, 21.4]),
		);
		const camera = await server.client.observe('bench-camera');
		expect(camera.observations[0]?.at).toBe('2025-01-02T03:04:06.000Z');
		const frame = camera.observations[0]?.parts[0];
		expect(frame?.kind).toBe('frame');
		if (frame?.kind !== 'frame') throw new Error('The camera fixture is not a frame.');
		const image = await server.client.file(frame.file);
		expect(image.mediaType).toBe('image/png');
		expect([...image.bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
		const notes = await server.client.observe('operator-notes');
		expect(notes.observations[0]).toEqual({
			at: '2025-01-02T03:04:07.000Z',
			parts: [{ kind: 'text', text: 'Fixture run: the indicator is green.' }],
		});
	}, 120_000);
});

function gitCommand(cwd: string, args: string[]): string {
	const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
	if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
	return result.stdout.trim();
}

function npmTest(cwd: string): { status: number | null; output: string } {
	const result = spawnSync('npm', ['test'], { cwd, encoding: 'utf8', timeout: 30_000 });
	const diagnostics = [
		result.stdout,
		result.stderr,
		result.error === undefined ? undefined : `spawnSync error: ${result.error.message}`,
		result.signal === null ? undefined : `signal: ${result.signal}`,
	]
		.filter((part) => part !== undefined)
		.join('');
	return { status: result.status, output: diagnostics };
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
			// Keep looking up from a generated declaration or JavaScript file.
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
			AMBION_SENSOR_REPOSITORY: 'agent/sensors',
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
