/**
 * The resource owner and its lifecycle: the neutral contract over a backend
 * with no Pi types, the queue that direct use and bound tools share, and
 * disposal that drains active work, revokes queued work, and stays terminal.
 */
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import { memoryBackend } from '../../just-bash/src/index.ts';
import { openWorkspace } from '../src/index.ts';
import { openResource, type ResourceBackend, type ResourceEnv } from '../src/resource.ts';
import { wrapped } from './support/backends.ts';

const alpha = { name: 'alpha' };
const beta = { name: 'beta' };
const closed = /no longer available/i;

describe('the neutral resource contract', () => {
	it('drives an owner over a backend with no Pi types, cleans up after each operation, and disposes once', async () => {
		const events: string[] = [];
		const backend: ResourceBackend<ResourceEnv & { note: string }> = {
			connect: async (who) => ({
				note: `hello ${who.name}`,
				cleanup: async () => void events.push('cleanup'),
			}),
			dispose: async () => void events.push('dispose'),
		};
		const resource = openResource({ name: 'fake', backend });
		await expect(resource.use(alpha, (env) => env.note)).resolves.toBe('hello alpha');
		await expect(
			resource.use(alpha, () => {
				throw new Error('boom');
			}),
		).rejects.toThrow('boom');
		expect(events).toEqual(['cleanup', 'cleanup']);
		await resource.dispose();
		await resource.dispose();
		await expect(resource.use(alpha, () => 'late')).rejects.toThrow(closed);
		expect(events).toEqual(['cleanup', 'cleanup', 'dispose']);
	});

	it('keeps lifecycle ownership separate from Ambion tools', async () => {
		const inner = memoryBackend();
		const resource = openResource({
			name: 'resource-only',
			backend: { connect: (agent, signal) => inner.connect(agent, signal) },
		});
		expect(resource).not.toHaveProperty('tools');
		await expect(resource.use(alpha, (env) => env.cwd)).resolves.toBe('/home/alpha');
		await resource.dispose();
	});
});

describe('workspace lifecycle', () => {
	it('drains and cleans active work before disposal, joins concurrent dispose calls, then stays terminal', async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let cleaned = 0;
		let disposes = 0;
		const workspace = openWorkspace({
			name: 'lifecycle',
			backend: {
				bash: wrapped((inner) => ({
					connect: async (agent, signal) => {
						const env = await inner.connect(agent, signal);
						env.cleanup = async () => void cleaned++;
						return env;
					},
					dispose: async () => void disposes++,
				})),
			},
		});
		const active = workspace.use(alpha, async () => {
			started.resolve();
			await release.promise;
		});
		await started.promise;
		const disposing = [workspace.dispose(), workspace.dispose()];
		await expect(workspace.use(beta, () => 'late')).rejects.toThrow(closed);
		expect(disposes).toBe(0);
		release.resolve();
		await Promise.all([active, ...disposing]);
		expect({ cleaned, disposes }).toEqual({ cleaned: 1, disposes: 1 });
		await expect(workspace.use(alpha, () => 'resurrected')).rejects.toThrow(closed);
		await expect(workspace.dispose()).resolves.toBeUndefined();
		expect(disposes).toBe(1);
	});

	it('shares queue and revocation between direct use and bound tools', async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let toolCalls = 0;
		const workspace = openWorkspace({
			name: 'shared-owner',
			backend: {
				bash: wrapped(() => ({
					tools: [
						{
							name: 'inspect',
							label: 'Inspect',
							description: 'Inspect the workspace.',
							parameters: Type.Object({}),
							execute: async () => {
								toolCalls += 1;
								return { content: [{ type: 'text' as const, text: 'called' }], details: {} };
							},
						},
					],
				})),
			},
		});
		const active = workspace.use(alpha, async () => {
			started.resolve();
			await release.promise;
		});
		await started.promise;
		const bound = workspace.tools().tools.find((tool) => tool.name === 'inspect');
		if (bound === undefined) throw new Error('The bound tool is missing.');
		const queued = bound.invoke(
			{},
			{ agent: { name: 'beta', identity: 'beta' }, callId: 'queued' },
		);
		const disposing = workspace.dispose();
		expect(toolCalls).toBe(0);
		release.resolve();
		await Promise.all([active, disposing]);
		await expect(queued).rejects.toThrow(closed);
		expect(toolCalls).toBe(0);
	});

	it('revokes pending and queued calls while an active call connects, and cleans the one env', async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let cleaned = 0;
		const workspace = openWorkspace({
			name: 'revoke',
			backend: {
				bash: wrapped((inner) => ({
					connect: async (agent) => {
						started.resolve();
						await release.promise;
						const env = await inner.connect(agent);
						env.cleanup = async () => void cleaned++;
						return env;
					},
				})),
			},
		});
		const active = workspace.use(alpha, () => 'done');
		await started.promise;
		const queued = workspace.use(beta, () => 'queued');
		const disposing = workspace.dispose();
		release.resolve();
		await expect(active).rejects.toThrow(closed);
		await expect(queued).rejects.toThrow(closed);
		await disposing;
		expect(cleaned).toBe(1);
	});

	it('checks an aborted queued call before connecting it', async () => {
		const release = Promise.withResolvers<void>();
		let connects = 0;
		const workspace = openWorkspace({
			name: 'queued-abort',
			backend: {
				bash: wrapped((inner) => ({
					connect: async (agent, signal) => {
						connects += 1;
						if (connects === 1) await release.promise;
						if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
						return inner.connect(agent, signal);
					},
				})),
			},
		});
		const active = workspace.use(alpha, () => 'active');
		const controller = new AbortController();
		const queued = workspace.use(beta, () => 'queued', controller.signal);
		controller.abort();
		release.resolve();
		await expect(active).resolves.toBe('active');
		await expect(queued).rejects.toThrow(/abort/i);
		expect(connects).toBe(1);
		await workspace.dispose();
	});
});
