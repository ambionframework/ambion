import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineAgent, startRoom } from '@ambionframework/ambion';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import { enter, roomName as name } from '../../ambion/test/support/room.ts';
import { byAgent, callTool, quiet, scripted, speak } from '../../ambion/test/support/scripted.ts';
import { openAuditLog } from '../src/audit.ts';
import { memoryBackend, openWorkspace } from '../src/index.ts';

const workspaceAgent = (name: string) => ({ name, identity: `${name} identity` });

async function tempDir(): Promise<{ dir: string; cleanup(): Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), 'ambion-audit-'));
	return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function lines(path: string): Promise<Record<string, unknown>[]> {
	const text = await readFile(path, 'utf8');
	return text
		.split('\n')
		.filter((entry) => entry.length > 0)
		.map((entry) => JSON.parse(entry) as Record<string, unknown>);
}

function entryFor(callId: string) {
	return {
		time: new Date().toISOString(),
		room: 'lobby',
		agent: 'scribe',
		tool: 'noop',
		callId,
		arguments: {},
	};
}

describe('the workspace audit log', () => {
	it('records the room, agent, tool, arguments and result for a successful call', async () => {
		const { dir, cleanup } = await tempDir();
		const path = join(dir, 'audit.jsonl');
		const site = openWorkspace({ name: 'audited', backend: memoryBackend(), audit: { path } });
		const write = site.tools().tools.find((tool) => tool.name === 'write');
		if (write === undefined) throw new Error('The write tool is missing.');

		await write.invoke(
			{ path: 'notes.txt', content: 'hello\n' },
			{ agent: workspaceAgent('scribe'), callId: 'call-1', room: 'lobby' },
		);

		const entries = await lines(path);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			room: 'lobby',
			agent: 'scribe',
			tool: 'write',
			callId: 'call-1',
			arguments: { path: 'notes.txt', content: 'hello\n' },
		});
		expect(entries[0]).toHaveProperty('result');
		expect(entries[0]).not.toHaveProperty('error');
		await site.destroy();
		await cleanup();
	});

	it('names an empty room when the call carries none', async () => {
		const { dir, cleanup } = await tempDir();
		const path = join(dir, 'audit.jsonl');
		const site = openWorkspace({ name: 'no-room', backend: memoryBackend(), audit: { path } });
		const write = site.tools().tools.find((tool) => tool.name === 'write');
		if (write === undefined) throw new Error('The write tool is missing.');

		await write.invoke(
			{ path: 'notes.txt', content: 'hi\n' },
			{ agent: workspaceAgent('scribe'), callId: 'call-1' },
		);

		const entries = await lines(path);
		expect(entries[0]).toMatchObject({ room: '' });
		await site.destroy();
		await cleanup();
	});

	it('records an error, and still throws it to the caller, when the call fails', async () => {
		const { dir, cleanup } = await tempDir();
		const path = join(dir, 'audit.jsonl');
		const failing = {
			tools: [
				{
					name: 'explode',
					label: 'Explode',
					description: 'Always fails.',
					parameters: Type.Object({}),
					execute: async () => {
						throw new Error('kaboom');
					},
				},
			],
			connect: (agent: { name: string; identity: string }) => memoryBackend().connect(agent),
			destroy: async () => {},
		};
		const site = openWorkspace({ name: 'audited-error', backend: failing, audit: { path } });
		const tool = site.tools().tools[0];
		if (tool === undefined) throw new Error('The custom tool is missing.');

		await expect(
			tool.invoke({}, { agent: workspaceAgent('scribe'), callId: 'call-2', room: 'lobby' }),
		).rejects.toThrow('kaboom');

		const entries = await lines(path);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			room: 'lobby',
			agent: 'scribe',
			tool: 'explode',
			error: { name: 'Error', message: 'kaboom' },
		});
		expect(entries[0]).not.toHaveProperty('result');
		await site.destroy();
		await cleanup();
	});

	it('names the real room, through a running room, on every tool call it makes', async () => {
		const { dir, cleanup } = await tempDir();
		const path = join(dir, 'audit.jsonl');
		const roomId = name('workspace-audit');
		const site = openWorkspace({ name: 'through-room', backend: memoryBackend(), audit: { path } });
		const worker = defineAgent({
			name: 'worker',
			identity: 'Writes one note.',
			instructions: 'write',
			model: 'scripted/worker',
			bundles: [site.tools()],
		});
		const session = await startRoom({
			name: roomId,
			agents: [worker],
			streamFn: scripted(
				byAgent({
					worker: (_context, _who, call) => {
						if (call === 1) return callTool('write', { path: 'notes.txt', content: 'done\n' });
						if (call > 2) return quiet();
						return speak('written');
					},
				}),
			),
		});
		const visit = await enter(session);
		const exchange = await visit.send({ text: 'go' });
		await exchange.waitForClose();
		await session.stop();

		const entries = await lines(path);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ room: roomId, agent: 'worker', tool: 'write' });
		await site.destroy();
		await cleanup();
	});
});

describe('openAuditLog', () => {
	it('accumulates into one file, then rotates the whole file once it passes maxBytes', async () => {
		const { dir, cleanup } = await tempDir();
		const path = join(dir, 'audit.jsonl');
		const oneLine = `${JSON.stringify(entryFor('one'))}\n`;
		const log = openAuditLog({ path, maxBytes: oneLine.length + 5 });

		await log.record(entryFor('one'));
		expect(await lines(path)).toHaveLength(1);
		expect(await readdir(dir)).toEqual(['audit.jsonl']);

		await log.record(entryFor('two'));
		const afterSecond = await readdir(dir);
		const rotated = afterSecond.filter((name) => name.startsWith('audit.jsonl.'));
		expect(rotated).toHaveLength(1);
		expect(afterSecond).not.toContain('audit.jsonl');
		expect(await lines(join(dir, rotated[0] as string))).toHaveLength(2);

		await log.record(entryFor('three'));
		expect(await lines(path)).toHaveLength(1);

		await cleanup();
	});

	it('serializes concurrent records into complete, non-interleaved lines', async () => {
		const { dir, cleanup } = await tempDir();
		const path = join(dir, 'audit.jsonl');
		const log = openAuditLog({ path });

		await Promise.all(
			Array.from({ length: 20 }, (_, index) => log.record(entryFor(`call-${index}`))),
		);

		const entries = await lines(path);
		expect(entries).toHaveLength(20);
		expect(new Set(entries.map((entry) => entry.callId)).size).toBe(20);
		await cleanup();
	});

	it('reports a write failure to onError instead of rejecting', async () => {
		const { dir, cleanup } = await tempDir();
		const blocker = join(dir, 'blocker');
		await writeFile(blocker, 'not a directory');
		const errors: Error[] = [];
		const log = openAuditLog({
			path: join(blocker, 'audit.jsonl'),
			onError: (error) => errors.push(error),
		});

		await expect(log.record(entryFor('one'))).resolves.toBeUndefined();

		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toMatch(/ENOTDIR|ENOENT|EEXIST/);
		await cleanup();
	});

	it('falls back to a short notice when an entry will not serialize', async () => {
		const { dir, cleanup } = await tempDir();
		const path = join(dir, 'audit.jsonl');
		const log = openAuditLog({ path });
		const circular: Record<string, unknown> = {};
		circular.self = circular;

		await log.record({ ...entryFor('bad'), arguments: circular });

		const entries = await lines(path);
		expect(entries[0]).toMatchObject({ callId: 'bad', error: { name: 'SerializationError' } });
		await cleanup();
	});
});
