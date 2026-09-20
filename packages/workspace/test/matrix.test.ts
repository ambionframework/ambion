/**
 * The room on two workspace backends, on every storage. One agent works in
 * memory, one works on disk, and one has no workspace at all; the room
 * destroys the first workspace while its activation runs.
 *
 * The scenario runs here because the backends do. `@ambionframework/ambion`
 * holds the rest of the matrix, and the storages and the harness come from
 * its own test support.
 */

import { isSpoken, startRoom } from '@ambionframework/ambion';
import { describe, expect, it } from 'vitest';
import { collect, deferred } from '../../ambion/test/support/room.ts';
import {
	agent,
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
import { openWorkspace } from '../src/index.ts';
import { backends } from './support/backends.ts';

const twoWorkspaces: Scenario = {
	name: 'two workspaces on two backends, and one destroyed mid-activation',
	async run({ runtime, name }) {
		const [memoryBackend, directoryBackend] = await Promise.all(backends.map((b) => b.open()));
		if (!memoryBackend || !directoryBackend) throw new Error('two backends are expected');
		const memoryDrive = openWorkspace({
			name: `${name}-memory`,
			backend: memoryBackend.backend,
		});
		const directoryDrive = openWorkspace({
			name: `${name}-directory`,
			backend: directoryBackend.backend,
		});
		const alpha = agent('alpha', 'Works in memory.', { bundles: [memoryDrive.tools()] });
		const beta = agent('beta', 'Works on disk.', { bundles: [directoryDrive.tools()] });
		const gamma = agent('gamma', 'Has no workspace.');
		const destroyed = deferred();
		const alphaResults: string[] = [];
		const betaResults: string[] = [];
		const session = await startRoom({
			name,
			runtime,
			agents: [alpha, beta, gamma],
			stream: scripted(
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
						expect(toolNames(context)).toEqual(['say', 'seat', 'unseat']);
						return quiet();
					},
				}),
			),
		});
		const events = collect(session);
		const visit = await session.visit(priya);
		const exchange = await visit.send({ text: 'go' });
		// alpha has written; destroy its workspace while its activation runs
		await new Promise<void>((resolve) => {
			const off = session.subscribe((event) => {
				if (event.type !== 'tool_execution_end' || event.agent !== 'alpha') return;
				off();
				resolve();
			});
		});
		await memoryDrive.destroy();
		destroyed.resolve();
		await exchange.waitForClose();
		await exchange.waitForSummary();

		expect(alphaResults.some((r) => r.includes('no longer available'))).toBe(true);
		expect(betaResults.some((r) => r.includes('two'))).toBe(true);
		const said = (await session.read()).messages.filter(isSpoken).map((m) => m.text);
		expect(said).toContain('alpha done');
		expect(said).toContain('beta done');
		await finish(session, events, runtime);
		await directoryDrive.destroy();
		await Promise.all([memoryBackend.dispose(), directoryBackend.dispose()]);
	},
};

describe.each(storages)('the workspace scenario on $name', (storage) => {
	it(twoWorkspaces.name, () => runScenario(storage, twoWorkspaces, `workspace-${storage.name}`));
});
