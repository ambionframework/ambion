import { defineAgent, startRoom } from '@ambionframework/ambion';
import { pi, piExecution } from '@ambionframework/pi';
import type { ExecutionEnv, FileInfo } from '@earendil-works/pi-agent-core';
import { BACKGROUND_CONTEXT, err, FileError, ok } from '@earendil-works/pi-agent-core';
import { Bash, InMemoryFs } from 'just-bash';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import { enter, roomName as name } from '../../ambion/test/support/room.ts';
import { byAgent, callTool, quiet, scripted, speak } from '../../ambion/test/support/scripted.ts';
import { DEFAULT_AUDIT_LOG, openAuditLog } from '../src/audit.ts';
import type { WorkspaceLayout } from '../src/backend.ts';
import { BashEnv } from '../src/bash-env.ts';
import { openWorkspace, SHARED_DATABASE } from '../src/index.ts';
import { memoryBackend } from '../src/just-bash.ts';

const workspaceAgent = (name: string) => ({ name });

/** The just-bash backends' own layout: `/workspace/audit.jsonl`, `/workspace/shared.db`, `/rooms`. */
const layout: WorkspaceLayout = {
	audit: DEFAULT_AUDIT_LOG,
	database: SHARED_DATABASE,
	rooms: '/rooms',
};
/** A `ToolContext.agent`, which still carries `identity` in the core type. */
const ctxAgent = (name: string) => ({ name, identity: `${name} identity` });
const ctx = BACKGROUND_CONTEXT;

/** The signature and the shortest valid `IHDR` header: enough for image detection to see a PNG. */
const FAKE_PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

/** A bare `ExecutionEnv` over its own in-memory filesystem, for testing `openAuditLog` alone. */
function bareEnv(): BashEnv {
	const fs = new InMemoryFs();
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

/**
 * A minimal `ExecutionEnv` double, backing only the four members `openAuditLog`
 * calls, over a plain in-process file map. `appendFile` can be told to fail its
 * first N calls, so a test can force the path `append()` takes when the
 * filesystem refuses the full entry but has room for a short fallback.
 */
function fakeEnv(
	options: { failFirstAppends?: number } = {},
): ExecutionEnv & { files: Map<string, string> } {
	const files = new Map<string, string>();
	let appendCalls = 0;
	const failFirstAppends = options.failFirstAppends ?? 0;
	const env = {
		files,
		createDir: async () => ok(undefined),
		appendFile: async (path: string, content: string | Uint8Array) => {
			appendCalls += 1;
			if (appendCalls <= failFirstAppends) {
				return err(new FileError('invalid', 'ENOSPC: no room for this entry', path));
			}
			const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
			files.set(path, (files.get(path) ?? '') + text);
			return ok(undefined);
		},
		fileInfo: async (path: string) => {
			const text = files.get(path);
			if (text === undefined) return err(new FileError('not_found', 'no such file', path));
			const info: FileInfo = {
				name: path,
				path,
				kind: 'file',
				size: text.length,
				mtimeMs: Date.now(),
			};
			return ok(info);
		},
		renameFile: async (source: string, destination: string) => {
			const text = files.get(source);
			if (text === undefined) return err(new FileError('not_found', 'no such file', source));
			files.delete(source);
			files.set(destination, text);
			return ok(undefined);
		},
	};
	return env as unknown as ExecutionEnv & { files: Map<string, string> };
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
			{
				agent: ctxAgent('scribe'),
				callId: 'call-1',
				room: 'lobby',
				activation: 'message:4:scribe:1',
				exchange: { owner: 'andrei', from: 4 },
			},
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
			activation: 'message:4:scribe:1',
			exchange: { owner: 'andrei', from: 4 },
			arguments: { path: 'notes.txt', content: 'hello\n' },
		});
		expect(entries[0]).toHaveProperty('result');
		expect(entries[0]).not.toHaveProperty('error');
		await site.dispose();
	});

	it('is readable through the ordinary read tool, the same as any other file', async () => {
		const site = openWorkspace({ name: name('agent-reads'), backend: memoryBackend(), audit: {} });
		const tools = site.tools().tools;
		const write = tools.find((tool) => tool.name === 'write');
		const read = tools.find((tool) => tool.name === 'read');
		if (write === undefined || read === undefined) throw new Error('A built-in tool is missing.');

		await write.invoke(
			{ path: 'notes.txt', content: 'hello\n' },
			{ agent: ctxAgent('scribe'), callId: 'call-1', room: 'lobby' },
		);
		const result = await read.invoke(
			{ path: DEFAULT_AUDIT_LOG },
			{ agent: ctxAgent('auditor'), callId: 'call-2', room: 'lobby' },
		);
		if (typeof result === 'string') throw new Error('read must return a structured result.');
		const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
		expect(text).toContain('"tool":"write"');
		await site.dispose();
	});

	it('reads an image file as an image content part, and keeps only its byte count in the audit log', async () => {
		const site = openWorkspace({ name: name('image-read'), backend: memoryBackend(), audit: {} });
		const read = site.tools().tools.find((tool) => tool.name === 'read');
		if (read === undefined) throw new Error('The read tool is missing.');
		await site.use(workspaceAgent('scribe'), (env) =>
			(env as BashEnv).writeFile('/home/scribe/photo.png', FAKE_PNG, ctx),
		);

		const result = await read.invoke(
			{ path: 'photo.png' },
			{ agent: ctxAgent('scribe'), callId: 'call-1', room: 'lobby' },
		);
		if (typeof result === 'string') throw new Error('read must return a structured result.');
		const image = result.content.find((part) => part.type === 'image');
		if (image?.type !== 'image') throw new Error('read did not return an image part.');
		expect(image.mimeType).toBe('image/png');
		expect(image.data.length).toBeGreaterThan(0);

		const entries = await site.use(workspaceAgent('scribe'), (env) =>
			readLines(env as BashEnv, DEFAULT_AUDIT_LOG),
		);
		const entry = entries.find((one) => one.tool === 'read');
		if (entry === undefined) throw new Error('No audit entry for the read call.');
		const logged = entry.result as { content: { type: string; data?: string; bytes?: number }[] };
		const loggedImage = logged.content.find((part) => part.type === 'image');
		expect(loggedImage).toMatchObject({ type: 'image', mimeType: 'image/png' });
		expect(loggedImage?.data).toBeUndefined();
		expect(loggedImage?.bytes).toBeGreaterThan(0);
		expect(JSON.stringify(entry)).not.toContain(image.data);
		await site.dispose();
	});

	it('tells the calling agent the log exists, in the workspace guidance', () => {
		const site = openWorkspace({ name: name('guidance'), backend: memoryBackend(), audit: {} });
		const guidance = site.tools().guidance ?? '';
		expect(guidance).toContain(DEFAULT_AUDIT_LOG);
		expect(guidance).toMatch(/read it/i);
		expect(guidance).toContain('the room, the agent, the tool');
		expect(guidance).toContain('activation');
	});

	it('keeps the backend guidance, and adds nothing about audit, when no audit log is set', () => {
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
			{ agent: ctxAgent('scribe'), callId: 'call-1' },
		);

		const entries = await site.use(workspaceAgent('scribe'), (env) =>
			readLines(env as BashEnv, DEFAULT_AUDIT_LOG),
		);
		expect(entries[0]).toMatchObject({ room: '' });
		expect(entries[0]).not.toHaveProperty('activation');
		expect(entries[0]).not.toHaveProperty('exchange');
		await site.dispose();
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
			connect: (agent: { name: string }) => inner.connect(agent),
			layout,
		};
		const site = openWorkspace({ name: name('audited-error'), backend: failing, audit: {} });
		const tool = site.tools().tools.find((one) => one.name === 'explode');
		if (tool === undefined) throw new Error('The custom tool is missing.');

		await expect(
			tool.invoke({}, { agent: ctxAgent('scribe'), callId: 'call-2', room: 'lobby' }),
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
		await site.dispose();
	});

	it('names the real room, through a running room, on every tool call it makes', async () => {
		const roomId = name('workspace-audit');
		const site = openWorkspace({ name: name('through-room'), backend: memoryBackend(), audit: {} });
		const worker = defineAgent({
			name: 'worker',
			identity: 'Writes one note.',
			executor: pi({ instructions: 'write', model: 'scripted/worker', bundles: [site.tools()] }),
		});
		const session = await startRoom({
			name: roomId,
			agents: [worker],
			execution: piExecution({
				stream: scripted(
					byAgent({
						worker: (_context, _who, call) => {
							if (call === 1) return callTool('write', { path: 'notes.txt', content: 'done\n' });
							if (call > 2) return quiet();
							return speak('written');
						},
					}),
				),
			}),
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
		await site.dispose();
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

	it('falls back to a short notice when an entry will not serialize', async () => {
		const env = bareEnv();
		const log = openAuditLog({ path: '/workspace/audit.jsonl' });
		const circular: Record<string, unknown> = {};
		circular.self = circular;

		await log.record(env, { ...entryFor('bad'), arguments: circular }, ctx);

		const entries = await readLines(env, log.path);
		expect(entries[0]).toMatchObject({ callId: 'bad', error: { name: 'SerializationError' } });
	});

	it('rejects a relative path, since it would resolve inside whichever agent home connects first', () => {
		expect(() => openAuditLog({ path: 'audit.jsonl' })).toThrow(/absolute/i);
		expect(() => openAuditLog({ path: '' })).toThrow(/absolute/i);
	});

	it('falls back to a short notice, instead of dropping the call, when the full entry will not fit', async () => {
		const env = fakeEnv({ failFirstAppends: 1 });
		const errors: Error[] = [];
		const log = openAuditLog({
			path: '/workspace/audit.jsonl',
			onError: (error) => errors.push(error),
		});

		await log.record(env, { ...entryFor('big'), arguments: { content: 'x'.repeat(1000) } }, ctx);

		expect(errors).toHaveLength(0);
		const text = env.files.get('/workspace/audit.jsonl') ?? '';
		const [entry] = text
			.split('\n')
			.filter((one) => one.length > 0)
			.map((one) => JSON.parse(one) as Record<string, unknown>);
		expect(entry).toMatchObject({ callId: 'big', error: { name: 'RecordTooLarge' } });
		expect(entry).not.toHaveProperty('arguments');
	});

	it('reports to onError, and never throws, when even the fallback notice does not fit', async () => {
		const env = fakeEnv({ failFirstAppends: 2 });
		const errors: Error[] = [];
		const log = openAuditLog({
			path: '/workspace/audit.jsonl',
			onError: (error) => errors.push(error),
		});

		await expect(log.record(env, entryFor('one'), ctx)).resolves.toBeUndefined();

		expect(errors).toHaveLength(1);
		expect(env.files.has('/workspace/audit.jsonl')).toBe(false);
	});

	it('never lets a throwing onError propagate and replace the tool outcome it is reporting on', async () => {
		const env = fakeEnv({ failFirstAppends: 2 });
		const log = openAuditLog({
			path: '/workspace/audit.jsonl',
			onError: () => {
				throw new Error('a broken onError callback');
			},
		});

		await expect(log.record(env, entryFor('one'), ctx)).resolves.toBeUndefined();
	});
});

describe('recording under an aborted signal', () => {
	it('still records a call the caller cut mid-flight, instead of losing it to the abort', async () => {
		const inner = memoryBackend();
		const started = Promise.withResolvers<void>();
		const slow = {
			tools: [
				{
					name: 'slow',
					label: 'Slow',
					description: 'Waits for the caller to abort, then throws.',
					parameters: Type.Object({}),
					execute: async (
						_toolCallId: string,
						_params: unknown,
						_onUpdate: unknown,
						_toolContext: unknown,
						_invocation: unknown,
						context: { abortSignal?: AbortSignal },
					) => {
						started.resolve();
						return new Promise<never>((_resolve, reject) => {
							if (context.abortSignal?.aborted) {
								reject(new Error('cut mid-flight'));
								return;
							}
							context.abortSignal?.addEventListener(
								'abort',
								() => reject(new Error('cut mid-flight')),
								{ once: true },
							);
						});
					},
				},
			],
			connect: (agent: { name: string }) => inner.connect(agent),
			layout,
		};
		const site = openWorkspace({ name: name('cut-mid-flight'), backend: slow, audit: {} });
		const tool = site.tools().tools.find((one) => one.name === 'slow');
		if (tool === undefined) throw new Error('The custom tool is missing.');
		const controller = new AbortController();

		const call = tool.invoke(
			{},
			{
				agent: ctxAgent('scribe'),
				callId: 'call-cut',
				room: 'lobby',
				signal: controller.signal,
			},
		);
		// The call must actually be running — connected, past use()'s own
		// precondition check — before the abort, or nothing runs to be cut.
		await started.promise;
		controller.abort();
		await expect(call).rejects.toThrow('cut mid-flight');

		const entries = await site.use(workspaceAgent('scribe'), (env) =>
			readLines(env as BashEnv, DEFAULT_AUDIT_LOG),
		);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			tool: 'slow',
			error: { message: 'cut mid-flight' },
		});
		await site.dispose();
	});
});
