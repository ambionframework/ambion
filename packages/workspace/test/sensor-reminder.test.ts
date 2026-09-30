import { describe, expect, it, onTestFinished } from 'vitest';
import { quiet, speak } from '../../ambion/test/support/scripted.ts';
import { openWorkspace } from '../src/index.ts';
import { callAs, toolOf, wrapped } from './support/backends.ts';
import { agent, run } from './support/room.ts';
import { connectionRig, index as fixtureIndex } from './support/sensor-connections.ts';

describe('sensor discovery in the activation reminder', () => {
	it('shows captured qualified names to another agent and marks ended processes unavailable', async () => {
		const firstServer = await connectionRig();
		const secondServer = await connectionRig();
		let failOwnerStatus = false;
		onTestFinished(async () => {
			await firstServer.close();
			await secondServer.close();
		});
		const workspace = openWorkspace({
			name: 'sensor-reminder',
			backend: {
				bash: wrapped((inner) => ({
					ports: {
						hostname: 'configured-workstation',
						async open(_agent, port) {
							const url = port === 43127 ? firstServer.url : secondServer.url;
							return { url, async close() {} };
						},
					},
					connect(agent, signal, services) {
						if (failOwnerStatus && agent.name === 'owner')
							return Promise.reject(new Error('owner process status failed'));
						return inner.connect(agent, signal, services);
					},
				})),
			},
		});
		onTestFinished(() => workspace.dispose());
		const processResult = await toolOf(workspace, 'bash').invoke(
			{ command: 'sleep 60', name: 'sensor-host', wait: 0 },
			callAs('owner'),
		);
		if (typeof processResult === 'string') throw new Error('bash returned no process details.');
		const firstProcess = (processResult.details as { process: { handle: string } }).process;
		const secondResult = await toolOf(workspace, 'bash').invoke(
			{ command: 'sleep 100', name: 'second-sensor-host', wait: 0 },
			callAs('owner'),
		);
		if (typeof secondResult === 'string') throw new Error('bash returned no process details.');
		const secondProcess = (secondResult.details as { process: { handle: string } }).process;
		await toolOf(workspace, 'connect').invoke(
			{ name: 'bench-one', process: firstProcess.handle, port: 43127 },
			callAs('owner'),
		);
		await toolOf(workspace, 'connect').invoke(
			{ name: 'bench-two', process: secondProcess.handle, port: 43128 },
			callAs('owner'),
		);
		await toolOf(workspace, 'bash').invoke(
			{ command: 'sleep 60', name: 'reader-job', wait: 0 },
			callAs('reader'),
		);

		const remind = workspace.tools().remind;
		if (remind === undefined) throw new Error('The workspace bundle must remind.');
		const before = await remind(
			{ agent: 'reader', room: 'lab', activation: 'a1' },
			new AbortController().signal,
		);
		expect(before).toContain('Your background processes in the workspace:');
		expect(before).toContain(': sleep 60');
		expect(before).toContain('bench-one/bench: Bench fixture.');
		expect(before).toContain('bench-two/bench: Bench fixture.');
		expect(before).toContain('configured-workstation');
		expect(before).toContain('remote port 43127');
		expect(before).toContain('remote port 43128');
		expect(before).not.toContain('/home/owner');
		expect(before).not.toContain('sleep 100');
		expect(before).not.toContain(firstServer.url);
		expect(before).not.toContain(secondServer.url);
		expect(before).not.toContain('sleep 60\n- bench-one');
		expect(firstServer.indexRequests).toHaveLength(1);
		expect(secondServer.indexRequests).toHaveLength(1);

		secondServer.setIndex({
			...fixtureIndex,
			sensors: [{ name: 'pressure', description: 'Updated pressure.', spans: false }],
		});
		const stale = await remind(
			{ agent: 'reader', room: 'lab', activation: 'a1b' },
			new AbortController().signal,
		);
		expect(stale).toContain('bench-two/bench: Bench fixture.');
		expect(secondServer.indexRequests).toHaveLength(1);
		await toolOf(workspace, 'connect').invoke(
			{ name: 'bench-two', process: secondProcess.handle, port: 43128 },
			callAs('owner'),
		);
		const refreshed = await remind(
			{ agent: 'reader', room: 'lab', activation: 'a1c' },
			new AbortController().signal,
		);
		expect(refreshed).toContain('bench-two/pressure: Updated pressure.');
		expect(secondServer.indexRequests).toHaveLength(2);
		failOwnerStatus = true;
		const withStatusFailure = await remind(
			{ agent: 'reader', room: 'lab', activation: 'a1d' },
			new AbortController().signal,
		);
		expect(withStatusFailure).toContain('Your background processes in the workspace:');
		expect(withStatusFailure).toContain(': sleep 60');
		expect(withStatusFailure).toContain('process status unknown');
		expect(withStatusFailure).toContain('bench-two/pressure: Updated pressure.');

		failOwnerStatus = false;
		await workspace.processes.cancel(firstProcess.handle);
		const after = await remind(
			{ agent: 'reader', room: 'lab', activation: 'a2' },
			new AbortController().signal,
		);
		expect(after).toContain('bench-one on configured-workstation');
		expect(after).toContain('process bash-');
		expect(after).toContain('remote port 43127: unavailable');
		expect(after).toContain('bench-two/pressure: Updated pressure.');

		const roomContext: string[] = [];
		await run([agent('observer', { bundles: [workspace.tools()] })], {
			observer: (context, _name, call) => {
				roomContext.push(`${context.systemPrompt ?? ''}\n${JSON.stringify(context.messages)}`);
				return call === 1 ? speak('done') : quiet();
			},
		});
		expect(roomContext.join('\n')).toContain('remote port 43127: unavailable');
	});
});
