import { defineAgent, startRoom } from '@ambionframework/ambion';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import { Bash, InMemoryFs } from 'just-bash';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import { enter, roomName as name } from '../../ambion/test/support/room.ts';
import { byAgent, callTool, quiet, scripted, speak } from '../../ambion/test/support/scripted.ts';
import { DEFAULT_AUDIT_LOG, openAuditLog } from '../src/audit.ts';
import { BashEnv } from '../src/bash-env.ts';
import { memoryBackend, openWorkspace } from '../src/index.ts';

const workspaceAgent = (name: string) => ({ name, identity: `${name} identity` });
const ctx = BACKGROUND_CONTEXT;

/** A bare `ExecutionEnv` over its own in-memory filesystem, for testing `openAuditLog` alone. */
function bareEnv(maxTotalBytes?: number): BashEnv {
	const fs = new InMemoryFs(undefined, maxTotalBytes === undefined ? undefined : { maxTotalBytes });
	const home = '/home/scribe';
	return new BashEnv(new Bash({ fs, cwd: home, env: { HOME: home } }), home);
}

async function readLines(env: BashEnv, path: string): Promise<Record<string, unknown>[]> {
	const text = await env.readTextFile(path, ctx);
	if (!text.ok) throw new Error(text.error.message);
	return text.value
		.split('\n')
		.filter((entry) => entry.length > 0)
		.map((entry) => JSON.parse(entry) as Record<string, unknown>);
}

async function listNames(env: BashEnv, path: string): Promise<string[]> {
	const listed = await env.listDir(path, ctx);
	if (!listed.ok) throw new Error(listed.error.message);
	return listed.value.map((file) => file.name).sort();
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
		const site = openWorkspace({ name: name('audited'), backend: memoryBackend(), audit: {} });
		const write = site.tools().tools.find((tool) => tool.name === 'write');
		if (write === undefined) throw new Error('The write tool is missing.');

		await write.invoke(
			{ path: 'notes.txt', content: 'hello\n' },
			{ agent: workspaceAgent('scribe'), callId: 'call-1', room: 'lobby' },
		);

		const entries = await site.use(workspaceAgent('scribe'), (env) =>
			readLines(env as BashEnv, DEFAULT_AUDIT_LOG),
		);
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
	});

	it('is readable through the ordinary read tool, the same as any other file', async () => {
		const site = openWorkspace({ name: name('agent-reads'), backend: memoryBackend(), audit: {} });
		const tools = site.tools().tools;
		const write = tools.find((tool) => tool.name === 'write');
		const read = tools.find((tool) => tool.name === 'read');
		if (write === undefined || read === undefined) throw new Error('A built-in tool is missing.');

		await write.invoke(
			{ path: 'notes.txt', content: 'hello\n' },
			{ agent: workspaceAgent('scribe'), callId: 'call-1', room: 'lobby' },
		);
		const result = await read.invoke(
			{ path: DEFAULT_AUDIT_LOG },
			{ agent: workspaceAgent('auditor'), callId: 'call-2', room: 'lobby' },
		);
		if (typeof result === 'string') throw new Error('read must return a structured result.');
		const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
		expect(text).toContain('"tool":"write"');
		await site.destroy();
	});

	it('tells the calling agent the log exists, in the workspace guidance', () => {
		const site = openWorkspace({ name: name('guidance'), backend: memoryBackend(), audit: {} });
		const guidance = site.tools().guidance ?? '';
		expect(guidance).toContain(DEFAULT_AUDIT_LOG);
		expect(guidance).toMatch(/read it/i);
		expect(guidance).toContain('the room, the agent, the tool');
	});

	it('keeps the backend guidance, and adds nothing, when no audit log is set', () => {
		const site = openWorkspace({ name: name('no-audit'), backend: memoryBackend() });
		const guidance = site.tools().guidance ?? '';
		expect(guidance).not.toContain('audit');
	});

	it('names an empty room when the call carries none', async () => {
		const site = openWorkspace({ name: name('no-room'), backend: memoryBackend(), audit: {} });
		const write = site.tools().tools.find((tool) => tool.name === 'write');
		if (write === undefined) throw new Error('The write tool is missing.');

		await write.invoke(
			{ path: 'notes.txt', content: 'hi\n' },
			{ agent: workspaceAgent('scribe'), callId: 'call-1' },
		);

		const entries = await site.use(workspaceAgent('scribe'), (env) =>
			readLines(env as BashEnv, DEFAULT_AUDIT_LOG),
		);
		expect(entries[0]).toMatchObject({ room: '' });
		await site.destroy();
	});

	it('records an error, and still throws it to the caller, when the call fails', async () => {
		const inner = memoryBackend();
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
			connect: (agent: { name: string; identity: string }) => inner.connect(agent),
			destroy: async () => {},
		};
		const site = openWorkspace({ name: name('audited-error'), backend: failing, audit: {} });
		const tool = site.tools().tools[0];
		if (tool === undefined) throw new Error('The custom tool is missing.');

		await expect(
			tool.invoke({}, { agent: workspaceAgent('scribe'), callId: 'call-2', room: 'lobby' }),
		).rejects.toThrow('kaboom');

		const entries = await site.use(workspaceAgent('scribe'), (env) =>
			readLines(env as BashEnv, DEFAULT_AUDIT_LOG),
		);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			room: 'lobby',
			agent: 'scribe',
			tool: 'explode',
			error: { name: 'Error', message: 'kaboom' },
		});
		expect(entries[0]).not.toHaveProperty('result');
		await site.destroy();
	});

	it('names the real room, through a running room, on every tool call it makes', async () => {
		const roomId = name('workspace-audit');
		const site = openWorkspace({ name: name('through-room'), backend: memoryBackend(), audit: {} });
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

		const entries = await site.use(workspaceAgent('worker'), (env) =>
			readLines(env as BashEnv, DEFAULT_AUDIT_LOG),
		);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ room: roomId, agent: 'worker', tool: 'write' });
		await site.destroy();
	});
});

describe('openAuditLog', () => {
	it('accumulates into one file, then rotates the whole file once it passes maxBytes', async () => {
		const env = bareEnv();
		const oneLine = `${JSON.stringify(entryFor('one'))}\n`;
		const log = openAuditLog({ path: '/workspace/audit.jsonl', maxBytes: oneLine.length + 5 });

		await log.record(env, entryFor('one'), ctx);
		expect(await readLines(env, log.path)).toHaveLength(1);
		expect(await listNames(env, '/workspace')).toEqual(['audit.jsonl']);

		await log.record(env, entryFor('two'), ctx);
		const afterSecond = await listNames(env, '/workspace');
		const rotated = afterSecond.filter((entry) => entry.startsWith('audit.jsonl.'));
		expect(rotated).toHaveLength(1);
		expect(afterSecond).not.toContain('audit.jsonl');
		const rotatedEntries = rotated[0];
		if (rotatedEntries === undefined) throw new Error('No rotated file.');
		expect(await readLines(env, `/workspace/${rotatedEntries}`)).toHaveLength(2);

		await log.record(env, entryFor('three'), ctx);
		expect(await readLines(env, log.path)).toHaveLength(1);
	});

	it('reports a write failure to onError instead of throwing', async () => {
		const env = bareEnv(200);
		const errors: Error[] = [];
		const log = openAuditLog({
			path: '/workspace/audit.jsonl',
			onError: (error) => errors.push(error),
		});

		await expect(log.record(env, entryFor('one'), ctx)).resolves.toBeUndefined();

		expect(errors).toHaveLength(1);
	});

	it('falls back to a short notice when an entry will not serialize', async () => {
		const env = bareEnv();
		const log = openAuditLog({ path: '/workspace/audit.jsonl' });
		const circular: Record<string, unknown> = {};
		circular.self = circular;

		await log.record(env, { ...entryFor('bad'), arguments: circular }, ctx);

		const entries = await readLines(env, log.path);
		expect(entries[0]).toMatchObject({ callId: 'bad', error: { name: 'SerializationError' } });
	});
});
