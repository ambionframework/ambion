import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_AUDIT_LOG } from '../src/audit.ts';
import type { BashBackend, WorkspaceEnv, WorkspaceLayout } from '../src/backend.ts';
import { BACKGROUND_CONTEXT, openWorkspace } from '../src/index.ts';
import { directoryBackend, memoryBackend } from '../src/just-bash.ts';
import { openResource, type ResourceBackend, type WorkspaceAgent } from '../src/resource.ts';

const agent = (name: string): WorkspaceAgent => ({ name });

/** The just-bash backends' own layout: `/workspace/audit.jsonl` and `/rooms`. */
const layout: WorkspaceLayout = {
	audit: DEFAULT_AUDIT_LOG,
	rooms: '/rooms',
};

describe('workspace lifecycle', () => {
	it('drains active work before disposal, then stays terminal', async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let disposes = 0;
		const inner = memoryBackend();
		const backend: BashBackend = {
			tools: [],
			connect: (caller, signal) => inner.connect(caller, signal),
			dispose: async () => {
				disposes += 1;
			},
			layout,
		};
		const workspace = openWorkspace({
			name: 'lifecycle-dispose-drain',
			backend: { bash: backend },
		});

		const active = workspace.use(agent('alpha'), async () => {
			started.resolve();
			await release.promise;
		});
		await started.promise;
		const disposing = workspace.dispose();

		await expect(workspace.use(agent('beta'), () => 'late')).rejects.toThrow(
			/no longer available/i,
		);
		expect(disposes).toBe(0);
		release.resolve();
		await Promise.all([active, disposing]);

		expect(disposes).toBe(1);
		await expect(workspace.use(agent('alpha'), () => 'resurrected')).rejects.toThrow(
			/no longer available/i,
		);
		await expect(workspace.dispose()).resolves.toBeUndefined();
	});

	it('joins concurrent dispose calls and disposes once', async () => {
		const disposeStarted = Promise.withResolvers<void>();
		const releaseDispose = Promise.withResolvers<void>();
		let disposes = 0;
		const inner = memoryBackend();
		const backend: BashBackend = {
			tools: [],
			connect: (caller, signal) => inner.connect(caller, signal),
			dispose: async () => {
				disposes += 1;
				disposeStarted.resolve();
				await releaseDispose.promise;
			},
			layout,
		};
		const workspace = openWorkspace({ name: 'lifecycle-dispose-join', backend: { bash: backend } });

		const firstDispose = workspace.dispose();
		await disposeStarted.promise;
		const secondDispose = workspace.dispose();

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
				backend: { bash: directoryBackend(root) },
			});
			await workspace.use(agent('writer'), async (env) => {
				const result = await env.writeFile('persisted.txt', 'keep me\n', BACKGROUND_CONTEXT);
				if (!result.ok) throw result.error;
			});

			await workspace.dispose();
			expect(await readFile(join(root, 'home', 'writer', 'persisted.txt'), 'utf8')).toBe(
				'keep me\n',
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it('keeps lifecycle ownership separate from Ambion tools', async () => {
		const inner = memoryBackend();
		const backend: ResourceBackend<WorkspaceEnv> = {
			connect: (agent, signal) => inner.connect(agent, signal),
		};
		const resource = openResource({ name: 'resource-only', backend });

		expect(resource).not.toHaveProperty('tools');
		await expect(resource.use(agent('alpha'), (env) => env.cwd)).resolves.toBe('/home/alpha');
		await resource.dispose();
	});
});
