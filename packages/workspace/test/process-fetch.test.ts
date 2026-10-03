import { spawnSync } from 'node:child_process';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { memoryBackend } from '../../just-bash/src/index.ts';
import { workstationBackend } from '../../workstation/src/index.ts';
import { startSshServer } from '../../workstation/test/support/server.ts';
import { hasSetsid } from '../../workstation/test/support/setsid.ts';
import { createProcessFetch } from '../src/process-fetch.ts';
import type { Process } from '../src/process-files.ts';
import { openProcessTable } from '../src/processes.ts';
import { openResource } from '../src/resource.ts';
import { earlierProcess } from './support/earlier-process.ts';
import { type ForwardRecord, httpEndpoints, serve } from './support/http-fixture.ts';

/** A process table over a real memory backend, and a forward cache over it. */
function open(fail: Error[] = []) {
	const backend = memoryBackend();
	const bash = openResource({ name: 'fetch', backend });
	const table = openProcessTable({ connect: (agent) => backend.connect(agent), bash: bash.use });
	const forwards: ForwardRecord[] = [];
	const cache = createProcessFetch({ processes: table, endpoints: httpEndpoints(forwards, fail) });
	onTestFinished(async () => {
		await cache.close();
		await table.close();
		await bash.dispose();
	});
	const start = (agent: string, name?: string): Promise<Process> =>
		bash.use({ name: agent }, (env) =>
			table.start({ name: agent }, env, {
				command: 'sleep 300',
				...(name === undefined ? {} : { name }),
				timeout: 600,
				grace: 1,
			}),
		);
	return { table, cache, forwards, start };
}

const text = async (response: Response): Promise<string> => response.text();

describe('the forward cache of fetch', () => {
	it('opens the forward at the first send on the owner session, keeps it, and finds a process by name or by handle', async () => {
		const { cache, forwards, start } = open();
		const camera = await start('ada', 'camera');
		const server = await serve({ '/a': { body: 'one', type: 'text/plain' } }, camera.port);
		onTestFinished(() => server.close());
		expect(forwards).toEqual([]);
		const byName = await cache.resolve('camera');
		expect(byName.handle).toBe(camera.handle);
		expect(await text(await cache.send(byName, '/a'))).toBe('one');
		const byHandle = await cache.resolve(camera.handle);
		expect(await text(await cache.send(byHandle, '/a'))).toBe('one');
		// The forward belongs to the agent that started the process, and one forward serves both reads.
		expect(forwards).toEqual([{ agent: 'ada', port: camera.port, closed: false }]);
		expect(server.requests).toEqual(['/a', '/a']);
	});

	it.each([
		{
			name: 'a name that no running process has',
			ask: 'lathe',
			error:
				/^No running process is named 'lathe'\. A process of an agent that has not acted since the host started is not listed yet\.$/,
		},
		{
			name: 'a handle that no running process has',
			ask: 'bash-0123456789ab',
			error: /^No running process is named 'bash-0123456789ab'\./,
		},
		{
			name: 'a name that two processes of two agents have',
			ask: 'camera',
			error:
				/^Two running processes are named 'camera': bash-[0-9a-f]{12} of ada, bash-[0-9a-f]{12} of bob\. Give the handle\.$/,
		},
	])('refuses $name', async ({ ask, error }) => {
		const { cache, start } = open();
		await start('ada', 'camera');
		await start('bob', 'camera');
		await expect(cache.resolve(ask)).rejects.toThrow(error);
	});

	it('refuses a process that has ended, a process with no port, and a path with no slash', async () => {
		const { table, cache, start } = open();
		const stopped = await start('ada', 'stopped');
		await table.cancel({ name: 'ada' }, stopped.handle);
		await expect(cache.resolve('stopped')).rejects.toThrow("No running process is named 'stopped'");
		const live = await start('ada', 'live');
		await expect(cache.send({ ...live, port: 0 }, '/')).rejects.toThrow('has no port');
		await expect(cache.send(live, 'x')).rejects.toThrow('does not start with a slash');
		// A send to a process that this table saw end opens no forward.
		await expect(cache.send(stopped, '/')).rejects.toThrow(`Process ${stopped.handle} ended.`);
	});

	it('does not keep a forward that failed, so the next send opens it again', async () => {
		const { cache, forwards, start } = open([new Error('forwarding refused')]);
		const process = await start('ada', 'camera');
		const server = await serve({ '/': { body: 'up' } }, process.port);
		onTestFinished(() => server.close());
		await expect(cache.send(process, '/')).rejects.toThrow('forwarding refused');
		expect(forwards).toEqual([]);
		expect(await text(await cache.send(process, '/'))).toBe('up');
		expect(forwards).toHaveLength(1);
	});

	it('closes the forward when its process ends, and every forward at close, and refuses a send after close', async () => {
		const { table, cache, forwards, start } = open();
		const first = await start('ada', 'first');
		const second = await start('ada', 'second');
		for (const process of [first, second]) {
			const server = await serve({ '/': { body: 'up' } }, process.port);
			onTestFinished(() => server.close());
			await cache.send(process, '/');
		}
		expect(forwards.map((forward) => forward.closed)).toEqual([false, false]);
		await table.cancel({ name: 'ada' }, first.handle);
		await vi.waitFor(() =>
			expect(forwards.map((forward) => forward.closed)).toEqual([true, false]),
		);
		await cache.close();
		expect(forwards.map((forward) => forward.closed)).toEqual([true, true]);
		await expect(cache.send(second, '/')).rejects.toThrow('Workspace is no longer available.');
	});

	it('joins the signal of the request to the wait for the forward', async () => {
		const { cache, start } = open();
		const process = await start('ada', 'camera');
		const aborted = AbortSignal.abort(new Error('The call stopped.'));
		await expect(cache.send(process, '/', { signal: aborted })).rejects.toThrow(
			'The call stopped.',
		);
		await expect(cache.resolve('camera', aborted)).rejects.toThrow('The call stopped.');
	});
});

describe.skipIf(!hasSetsid)('a process of an earlier run', () => {
	it('is read after a new table opens, with no event for its start', async () => {
		const started = await startSshServer(['bob']);
		onTestFinished(() => started.stop());
		const port = 24680;
		const { pid } = await earlierProcess(started, 'bob', 'bash-0000000000b1', 1, 'echo term', {
			name: 'camera',
			port,
		});
		onTestFinished(() => void spawnSync('kill', ['-KILL', String(pid)]));
		const backend = workstationBackend(started.options);
		const bash = openResource({ name: 'adopt', backend });
		const table = openProcessTable({ connect: (agent) => backend.connect(agent), bash: bash.use });
		const forwards: ForwardRecord[] = [];
		const cache = createProcessFetch({ processes: table, endpoints: httpEndpoints(forwards) });
		onTestFinished(async () => {
			await cache.close();
			await table.close();
			await bash.dispose();
		});
		const events: string[] = [];
		table.subscribe((event) => events.push(event.type));
		const server = await serve({ '/': { body: 'adopted' } }, port);
		onTestFinished(() => server.close());
		// The host's list covers an agent after the table read its files.
		await expect(cache.resolve('camera')).rejects.toThrow('No running process is named');
		await table.list({ name: 'bob' });
		const adopted = await cache.resolve('camera');
		expect(adopted).toMatchObject({ handle: 'bash-0000000000b1', agent: 'bob', port });
		expect(await text(await cache.send(adopted, '/'))).toBe('adopted');
		expect(forwards).toEqual([{ agent: 'bob', port, closed: false }]);
		expect(events).toEqual([]);
	}, 30_000);
});
