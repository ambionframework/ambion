import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import { labRepositories } from '../src/repositories.ts';

const template = fileURLToPath(new URL('../templates/actuator-controller/', import.meta.url));

describe('the actuator controller template', () => {
	it('is registered and forkable, and its tests guard the stop contract', async () => {
		const repositories = labRepositories(':memory:');
		onTestFinished(() => repositories.dispose?.());
		const git = await repositories.connect({ name: 'actuator-template-test' });
		const listed = await git.list('templates');
		const entry = listed.find((repository) => repository.id === 'templates/actuator-controller');
		expect(entry?.description).toContain('controller for one actuator');

		const fork = await git.fork('templates/actuator-controller', 'bath-control');
		if (!fork.ok) throw new Error(`The actuator template could not be forked: ${fork.reason}`);
		const head = await git.resolve(fork.repository.id, { branch: fork.repository.defaultBranch });
		const commit = await git.show(fork.repository.id, head ?? '');
		expect(commit?.changes.map((change) => change.path)).toEqual(
			expect.arrayContaining([
				'controller.mjs',
				'device.mjs',
				'law.mjs',
				'plant.mjs',
				'finally.mjs',
				'start',
				'config.json',
				'test/controller.test.mjs',
			]),
		);

		const checkout = await mkdtemp(join(tmpdir(), 'ambion-actuator-template-'));
		onTestFinished(() => rm(checkout, { recursive: true, force: true }));
		await cp(template, checkout, {
			recursive: true,
			filter: (path) => !path.split(sep).some((part) => part === 'node_modules'),
		});
		const accepted = npmTest(checkout);
		expect(accepted.status, accepted.output).toBe(0);

		// A controller that forgets its stop handlers dies on SIGTERM, and the tests say so.
		const harness = join(checkout, 'controller.mjs');
		const source = await readFile(harness, 'utf8');
		const broken = source.replace(
			"for (const signal of ['SIGTERM', 'SIGINT'])",
			'for (const signal of [])',
		);
		expect(broken).not.toBe(source);
		await writeFile(harness, broken);
		const rejected = npmTest(checkout);
		expect(rejected.status).not.toBe(0);
		expect(rejected.output).toContain('SIGTERM makes the device safe inside the grace');
	}, 120_000);
});

function npmTest(cwd: string): { status: number | null; output: string } {
	const result = spawnSync('npm', ['test'], { cwd, encoding: 'utf8', timeout: 60_000 });
	return { status: result.status, output: `${result.stdout}${result.stderr}` };
}
