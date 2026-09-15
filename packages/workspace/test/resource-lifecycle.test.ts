import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { directoryBackend, memoryBackend, openWorkspace } from '../src/index.ts';
import type { WorkspaceAgent, WorkspaceBackend } from '../src/resource.ts';

const agent = (name: string): WorkspaceAgent => ({ name, identity: `${name}-identity` });

describe('workspace lifecycle', () => {
	it('joins concurrent destroys, drains active work, and stays terminal', async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let destroys = 0;
		let disposes = 0;
		const inner = memoryBackend();
		const backend: WorkspaceBackend = {
			tools: [],
			connect: (caller, signal) => inner.connect(caller, signal),
			destroy: async () => {
				destroys += 1;
			},
			dispose: async () => {
				disposes += 1;
			},
		};
		const workspace = openWorkspace({ name: 'lifecycle-destroy', backend });

		const active = workspace.use(agent('alpha'), async () => {
			started.resolve();
			await release.promise;
		});
		await started.promise;
		const firstDestroy = workspace.destroy();
		const secondDestroy = workspace.destroy();
		const disposing = workspace.dispose();

		await expect(workspace.use(agent('beta'), () => 'late')).rejects.toThrow(
			/no longer available/i,
		);
		expect(destroys).toBe(0);
		release.resolve();
		await Promise.all([active, firstDestroy, secondDestroy, disposing]);

		expect(destroys).toBe(1);
		expect(disposes).toBe(0);
		await expect(workspace.use(agent('alpha'), () => 'resurrected')).rejects.toThrow(
			/no longer available/i,
		);
		await expect(workspace.destroy()).resolves.toBeUndefined();
		await expect(workspace.dispose()).resolves.toBeUndefined();
	});

	it('makes disposal terminal and rejects destroy while disposal is in progress', async () => {
		const disposeStarted = Promise.withResolvers<void>();
		const releaseDispose = Promise.withResolvers<void>();
		let disposes = 0;
		const inner = memoryBackend();
		const backend: WorkspaceBackend = {
			tools: [],
			connect: (caller, signal) => inner.connect(caller, signal),
			destroy: async () => {},
			dispose: async () => {
				disposes += 1;
				disposeStarted.resolve();
				await releaseDispose.promise;
			},
		};
		const workspace = openWorkspace({ name: 'lifecycle-dispose', backend });

		const firstDispose = workspace.dispose();
		await disposeStarted.promise;
		const secondDispose = workspace.dispose();
		await expect(workspace.destroy()).rejects.toThrow(/disposal is in progress/i);

		releaseDispose.resolve();
		await Promise.all([firstDispose, secondDispose]);
		expect(disposes).toBe(1);
		await expect(workspace.dispose()).resolves.toBeUndefined();
		await expect(workspace.use(agent('alpha'), () => 'resurrected')).rejects.toThrow(
			/no longer available/i,
		);
	});

	it('releases a directory backend on dispose while preserving durable files', async () => {
		const root = await mkdtemp(join(tmpdir(), 'ambion-workspace-lifecycle-'));
		try {
			const workspace = openWorkspace({
				name: 'lifecycle-directory',
				backend: directoryBackend(root),
			});
			await workspace.use(agent('writer'), async (env) => {
				const result = await env.writeFile('persisted.txt', 'keep me\n');
				if (!result.ok) throw result.error;
			});

			await workspace.dispose();
			expect(await readFile(join(root, 'home', 'writer', 'persisted.txt'), 'utf8')).toBe(
				'keep me\n',
			);
			// Disposal releases the owner; destruction is a separate terminal action.
			await expect(workspace.destroy()).rejects.toThrow(/has been disposed/i);
			expect(await readFile(join(root, 'home', 'writer', 'persisted.txt'), 'utf8')).toBe(
				'keep me\n',
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
