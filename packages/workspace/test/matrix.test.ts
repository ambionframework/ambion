/**
 * The room on two workspace backends, on every storage. One agent works in
 * memory, one works on disk, and one has no workspace at all; the room
 * destroys the first workspace while its activation runs.
 *
 * The scenario runs here because the backends do. `@ambionframework/ambion`
 * holds the rest of the matrix, and the storages and the harness come from
 * its own test support.
 */

import {
	defineWorkspace,
	destroyWorkspace,
	isSpoken,
	startSession,
	visitSession,
} from '@ambionframework/ambion';
import { describe, expect, it } from 'vitest';
import { collect, deferred } from '../../ambion/test/support/room.ts';
import {
	agent,
	assistant,
	finish,
	priya,
	runScenario,
	type Scenario,
} from '../../ambion/test/support/scenarios.ts';
import {
	byAgent,
	callTool,
	quiet,
	scripted,
	speak,
	toolNames,
	toolResultTexts,
} from '../../ambion/test/support/scripted.ts';
import { storages } from '../../ambion/test/support/storage.ts';
import { backends } from './support/backends.ts';

const twoWorkspaces: Scenario = {
	name: 'two workspaces on two backends, and one destroyed mid-activation',
	async run({ runtime, name }) {
		const [memoryBackend, directoryBackend] = await Promise.all(backends.map((b) => b.open()));
		if (!memoryBackend || !directoryBackend) throw new Error('two backends are expected');
		const memoryDrive = defineWorkspace({
			name: `${name}-memory`,
			backend: memoryBackend.backend,
			runtime,
		});
		const directoryDrive = defineWorkspace({
			name: `${name}-directory`,
			backend: directoryBackend.backend,
			runtime,
		});
		const alpha = agent('alpha', 'Works in memory.', { workspace: memoryDrive });
		const beta = agent('beta', 'Works on disk.', { workspace: directoryDrive });
		const gamma = agent('gamma', 'Has no workspace.');
		const destroyed = deferred();
		const alphaResults: string[] = [];
		const betaResults: string[] = [];
		const session = startSession({
			name,
			runtime,
			assistant,
			agents: [alpha, beta, gamma],
			streamFn: scripted(
				byAgent({
					alpha: async (context, _name, call) => {
						alphaResults.push(...toolResultTexts(context).slice(alphaResults.length));
						if (call === 1)
							return callTool('write', { path: '/home/alpha/note.txt', content: 'one' });
						if (call === 2) {
							await destroyed.promise;
							return callTool('read', { path: '/home/alpha/note.txt' });
						}
						return call === 3 ? speak('alpha done') : quiet();
					},
					beta: (context, _name, call) => {
						betaResults.push(...toolResultTexts(context).slice(betaResults.length));
						if (call === 1) return callTool('bash', { command: 'echo two > /home/beta/note.txt' });
						if (call === 2) return callTool('read', { path: '/home/beta/note.txt' });
						return call === 3 ? speak('beta done') : quiet();
					},
					gamma: (context) => {
						expect(toolNames(context)).toEqual(['say']);
						return quiet();
					},
				}),
			),
		});
		const events = collect(session);
		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'go' });
		// alpha has written; destroy its workspace while its activation runs
		await new Promise<void>((resolve) => {
			const off = session.subscribe((event) => {
				if (event.type !== 'tool_execution_end' || event.agent !== 'alpha') return;
				off();
				resolve();
			});
		});
		await destroyWorkspace(memoryDrive);
		destroyed.resolve();
		await session.quiet();

		expect(alphaResults.some((r) => r.includes('destroyed'))).toBe(true);
		expect(betaResults.some((r) => r.includes('two'))).toBe(true);
		const said = (await session.messages()).filter(isSpoken).map((m) => m.text);
		expect(said).toContain('alpha done');
		expect(said).toContain('beta done');
		await finish(session, events, runtime);
		await destroyWorkspace(directoryDrive);
		await Promise.all([memoryBackend.dispose(), directoryBackend.dispose()]);
	},
};

describe.each(storages)('the workspace scenario on $name', (storage) => {
	it(twoWorkspaces.name, () => runScenario(storage, twoWorkspaces, `workspace-${storage.name}`));
});
