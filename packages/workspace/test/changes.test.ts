import { defineAgent, startRoom } from '@ambionframework/ambion';
import { pi, piExecution } from '@ambionframework/pi';
import type { ExecutionEnv } from '@earendil-works/pi-agent-core';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import { Bash, InMemoryFs } from 'just-bash';
import { describe, expect, it } from 'vitest';
import { enter, roomName as name } from '../../ambion/test/support/room.ts';
import { byAgent, callTool, quiet, scripted, speak } from '../../ambion/test/support/scripted.ts';
import { BashEnv } from '../src/bash-env.ts';
import { DEFAULT_CHANGE_LOG, openChangeLog, select, type WorkspaceChange } from '../src/changes.ts';
import { memoryBackend, openWorkspace, type WorkspaceBackend } from '../src/index.ts';
import { justBashChangedPaths } from '../src/just-bash.ts';
import { type Backend, backends } from './support/backends.ts';

const agentOf = (agentName: string) => ({ name: agentName, identity: `${agentName} identity` });
const ctx = BACKGROUND_CONTEXT;

function bareEnv(): BashEnv {
	const fs = new InMemoryFs();
	const home = '/home/scribe';
	return new BashEnv(new Bash({ fs, cwd: home, env: { HOME: home } }), home);
}

function changeFor(tag: string, exchange?: { owner: string; from: number }): WorkspaceChange {
	return {
		time: new Date().toISOString(),
		room: 'lobby',
		agent: 'scribe',
		tool: 'write',
		...(exchange === undefined ? {} : { exchange }),
		paths: [`/home/scribe/${tag}.txt`],
	};
}

describe('justBashChangedPaths', () => {
	const scribe = agentOf('scribe');

	it('names the resolved path of a write or an edit', () => {
		expect(justBashChangedPaths(scribe, 'write', { path: 'a.txt' })).toEqual([
			'/home/scribe/a.txt',
		]);
		expect(justBashChangedPaths(scribe, 'edit', { path: 'sub/b.txt' })).toEqual([
			'/home/scribe/sub/b.txt',
		]);
	});

	it('expands a home prefix the way the filesystem does', () => {
		expect(justBashChangedPaths(scribe, 'write', { path: '~/a.txt' })).toEqual([
			'/home/scribe/a.txt',
		]);
		expect(justBashChangedPaths(scribe, 'edit', { path: '~' })).toEqual(['/home/scribe']);
	});

	it('passes an absolute path through', () => {
		expect(justBashChangedPaths(scribe, 'write', { path: '/shared/c.txt' })).toEqual([
			'/shared/c.txt',
		]);
	});

	it('names nothing for read, bash, sql, or a call with no path', () => {
		for (const tool of ['read', 'bash', 'sql']) {
			expect(justBashChangedPaths(scribe, tool, { path: 'a.txt' })).toEqual([]);
		}
		expect(justBashChangedPaths(scribe, 'write', {})).toEqual([]);
		expect(justBashChangedPaths(scribe, 'write', null)).toEqual([]);
	});
});

describe('select', () => {
	it('keeps entries of the exchange and drops entries with none', () => {
		const entries = [
			changeFor('a', { owner: 'andrei', from: 1 }),
			changeFor('b', { owner: 'andrei', from: 5 }),
			changeFor('c', { owner: 'priya', from: 1 }),
			changeFor('d'),
		];
		const chosen = select(entries, { exchange: { owner: 'andrei', from: 1 } });
		expect(chosen.map((entry) => entry.paths[0])).toEqual(['/home/scribe/a.txt']);
	});
});

describe('openChangeLog', () => {
	it('records one JSON line per change and reads them back', async () => {
		const env = bareEnv();
		const log = openChangeLog();
		expect(log.path).toBe(DEFAULT_CHANGE_LOG);
		await log.record(env, changeFor('one'), ctx);
		await log.record(env, changeFor('two'), ctx);
		const read = await log.read(env, ctx);
		expect(read.map((entry) => entry.paths[0])).toEqual([
			'/home/scribe/one.txt',
			'/home/scribe/two.txt',
		]);
	});

	it('reads across rotated files, oldest first', async () => {
		const env = bareEnv();
		const oneLine = `${JSON.stringify(changeFor('one'))}\n`;
		const log = openChangeLog({ maxBytes: oneLine.length + 5 });
		for (const tag of ['one', 'two', 'three']) await log.record(env, changeFor(tag), ctx);
		const read = await log.read(env, ctx);
		expect(read.map((entry) => entry.paths[0])).toEqual([
			'/home/scribe/one.txt',
			'/home/scribe/two.txt',
			'/home/scribe/three.txt',
		]);
	});

	it('returns nothing when no file exists', async () => {
		expect(await openChangeLog().read(bareEnv(), ctx)).toEqual([]);
	});

	it('rejects a relative path', () => {
		expect(() => openChangeLog({ path: 'changes.jsonl' })).toThrow(/absolute/i);
	});

	it('reports a write failure to onError and never throws', async () => {
		const errors: Error[] = [];
		const failing = {
			createDir: async () => ({ ok: true, value: undefined }),
			appendFile: async () => ({ ok: false, error: new Error('disk full') }),
		} as unknown as ExecutionEnv;
		const log = openChangeLog({ onError: (error) => errors.push(error) });
		await expect(log.record(failing, changeFor('x'), ctx)).resolves.toBeUndefined();
		expect(errors.map((error) => error.message)).toEqual(['disk full']);
	});
});

describe('workspace.changes', () => {
	const invokeOf = (site: ReturnType<typeof openWorkspace>, tool: string) => {
		const found = site.tools().tools.find((candidate) => candidate.name === tool);
		if (found === undefined) throw new Error(`The ${tool} tool is missing.`);
		return found;
	};

	it('carries the activation and the exchange of each change', async () => {
		const site = openWorkspace({ name: name('changes'), backend: memoryBackend(), changes: {} });
		const exchange = { owner: 'andrei', from: 4 };
		await invokeOf(site, 'write').invoke(
			{ path: 'a.txt', content: 'x\n' },
			{ agent: agentOf('scribe'), callId: 'c1', room: 'lobby', activation: 'act-1', exchange },
		);
		// Outside any exchange: recorded, but never matched.
		await invokeOf(site, 'write').invoke(
			{ path: 'b.txt', content: 'y\n' },
			{ agent: agentOf('scribe'), callId: 'c2', room: 'lobby' },
		);
		const found = await site.changes({ exchange });
		expect(found).toHaveLength(1);
		expect(found[0]).toMatchObject({
			room: 'lobby',
			agent: 'scribe',
			tool: 'write',
			activation: 'act-1',
			exchange,
			paths: ['/home/scribe/a.txt'],
		});
		await site.dispose();
	});

	it('returns nothing when the workspace keeps no change log', async () => {
		const site = openWorkspace({ name: name('no-changes'), backend: memoryBackend() });
		await invokeOf(site, 'write').invoke(
			{ path: 'a.txt', content: 'x\n' },
			{ agent: agentOf('scribe'), callId: 'c1', exchange: { owner: 'andrei', from: 4 } },
		);
		expect(await site.changes({ exchange: { owner: 'andrei', from: 4 } })).toEqual([]);
		await site.dispose();
	});

	it('records no change for a call that fails, while audit still records it', async () => {
		const inner = memoryBackend();
		const failing: WorkspaceBackend = {
			...inner,
			tools: [
				{
					name: 'write',
					label: 'write',
					description: 'fails',
					parameters: { type: 'object', properties: {} } as never,
					execute: async () => {
						throw new Error('ENOSPC');
					},
				},
			],
		};
		const site = openWorkspace({
			name: name('failing'),
			backend: failing,
			changes: {},
			audit: {},
		});
		const exchange = { owner: 'andrei', from: 2 };
		await expect(
			invokeOfFirst(site).invoke(
				{ path: 'a.txt' },
				{ agent: agentOf('scribe'), callId: 'c1', exchange },
			),
		).rejects.toThrow('ENOSPC');
		expect(await site.changes({ exchange })).toEqual([]);
		await site.dispose();
	});

	function invokeOfFirst(site: ReturnType<typeof openWorkspace>) {
		const first = site.tools().tools[0];
		if (first === undefined) throw new Error('The tool is missing.');
		return first;
	}
});

async function runRoom(backend: Backend) {
	const { backend: files, dispose } = await backend.open();
	const site = openWorkspace({ name: name('changed'), backend: files, changes: {} });
	const worker = defineAgent({
		name: 'worker',
		identity: 'Writes notes.',
		executor: pi({ instructions: 'write', model: 'scripted/worker', bundles: [site.tools()] }),
	});
	let target = 'first';
	const written = new Set<string>();
	const spoken = new Set<string>();
	const session = await startRoom({
		name: name('changes-room'),
		agents: [worker],
		execution: piExecution({
			stream: scripted(
				byAgent({
					worker: () => {
						for (const n of [1, 2]) {
							const file = `${target}-${n}.txt`;
							if (written.has(file)) continue;
							written.add(file);
							return callTool('write', { path: file, content: `${file}\n` });
						}
						if (spoken.has(target)) return quiet();
						spoken.add(target);
						return speak(`${target} done`);
					},
				}),
			),
		}),
	});
	return { site, session, dispose, setTarget: (next: string) => (target = next) };
}

describe.each(backends)('changes through a running room on the $name backend', (backend) => {
	it('answers what changed during one exchange and excludes the next', async () => {
		const { site, session, dispose, setTarget } = await runRoom(backend);
		const visit = await enter(session);
		const first = await visit.send({ text: 'first' });
		await first.waitForClose();
		setTarget('second');
		const second = await visit.send({ text: 'second' });
		await second.waitForClose();
		await session.stop();

		const inFirst = await site.changes({ exchange: { owner: first.owner, from: first.from } });
		const paths = inFirst.flatMap((entry) => entry.paths);
		expect(paths).toEqual(['/home/worker/first-1.txt', '/home/worker/first-2.txt']);
		expect(inFirst.every((entry) => entry.agent === 'worker' && entry.tool === 'write')).toBe(true);
		expect(inFirst.every((entry) => typeof entry.activation === 'string')).toBe(true);

		const inSecond = await site.changes({ exchange: { owner: second.owner, from: second.from } });
		expect(inSecond.flatMap((entry) => entry.paths)).toEqual([
			'/home/worker/second-1.txt',
			'/home/worker/second-2.txt',
		]);
		await site.dispose();
		await dispose();
	});

	it('separates the exchanges of two people by owner', async () => {
		const { site, session, dispose } = await runRoom(backend);
		const visit = await enter(session);
		const first = await visit.send({ text: 'first' });
		await first.waitForClose();
		await session.stop();
		const other = await site.changes({ exchange: { owner: 'priya', from: first.from } });
		expect(other).toEqual([]);
		await site.dispose();
		await dispose();
	});
});
