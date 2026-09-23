/**
 * The workspace audit log: what one entry records for a call that returns,
 * fails, or is cut, and how `openAuditLog` rotates the file and falls back
 * to a short notice when the full entry will not serialize or will not fit.
 * The entry a call through a running room writes is in `workspace.test.ts`.
 */
import type { ExecutionEnv } from '@earendil-works/pi-agent-core';
import { BACKGROUND_CONTEXT, err, FileError } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import { memoryBackend } from '../../just-bash/src/index.ts';
import { DEFAULT_AUDIT_LOG, openAuditLog } from '../src/audit.ts';
import type { BashBackend, WorkspaceEnv } from '../src/backend.ts';
import { openWorkspace, type Workspace } from '../src/index.ts';
import { callAs, invokeText, toolOf, wrapped } from './support/backends.ts';

const ctx = BACKGROUND_CONTEXT;
const scribe = { name: 'scribe' };

/** The signature and the shortest valid `IHDR` header: enough for image detection to see a PNG. */
const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

const audited = (bash: BashBackend = memoryBackend()) =>
	openWorkspace({ name: 'audited', backend: { bash }, audit: {} });

async function readLines(env: ExecutionEnv, path: string): Promise<Record<string, unknown>[]> {
	const text = await env.readTextFile(path, ctx);
	if (!text.ok) throw new Error(text.error.message);
	return text.value
		.split('\n')
		.filter((entry) => entry.length > 0)
		.map((entry) => JSON.parse(entry) as Record<string, unknown>);
}

const entriesOf = (site: Workspace) => site.use(scribe, (env) => readLines(env, DEFAULT_AUDIT_LOG));

/**
 * An env of a fresh memory backend, for `openAuditLog` alone. Its first
 * `failures` appends fail as a full filesystem refuses them.
 */
async function bareEnv(failures = 0): Promise<WorkspaceEnv> {
	const env = await memoryBackend().connect(scribe);
	const append = env.appendFile.bind(env);
	let left = failures;
	env.appendFile = async (path, content, context) => {
		left -= 1;
		if (left >= 0) return err(new FileError('invalid', 'ENOSPC: no room for this entry', path));
		return append(path, content, context);
	};
	return env;
}

async function listNames(env: WorkspaceEnv, path: string): Promise<string[]> {
	const listed = await env.listDir(path, ctx);
	if (!listed.ok) throw new Error(listed.error.message);
	return listed.value.map((file) => file.name).sort();
}

const entryFor = (callId: string) => ({
	time: new Date().toISOString(),
	room: 'lobby',
	agent: 'scribe',
	tool: 'noop',
	callId,
	arguments: {},
});

describe('the workspace audit log', () => {
	it('records the room, agent, tool, arguments and result of each call, and names it in guidance for the read tool', async () => {
		const site = audited();
		const guidance = site.tools().guidance ?? '';
		expect(guidance).toContain(DEFAULT_AUDIT_LOG);
		expect(guidance).toMatch(/read it/i);
		expect(guidance).toContain('the room, the agent, the tool');
		expect(guidance).toContain('activation');

		const write = toolOf(site, 'write');
		await write.invoke(
			{ path: 'notes.txt', content: 'hello\n' },
			callAs('scribe', {
				room: 'lobby',
				activation: 'message:4:scribe:1',
				exchange: { owner: 'andrei', from: 4 },
			}),
		);
		await write.invoke(
			{ path: 'notes.txt', content: 'hi\n' },
			callAs('scribe', { callId: 'call-2' }),
		);
		const read = await invokeText(
			toolOf(site, 'read'),
			{ path: DEFAULT_AUDIT_LOG },
			callAs('auditor', { room: 'lobby' }),
		);
		expect(read).toContain('"tool":"write"');

		const [full, roomless] = await entriesOf(site);
		expect(full).toMatchObject({
			room: 'lobby',
			agent: 'scribe',
			tool: 'write',
			callId: 'call-1',
			activation: 'message:4:scribe:1',
			exchange: { owner: 'andrei', from: 4 },
			arguments: { path: 'notes.txt', content: 'hello\n' },
		});
		expect(full).toHaveProperty('result');
		expect(full).not.toHaveProperty('error');
		expect(roomless).toMatchObject({ room: '', callId: 'call-2' });
		expect(roomless).not.toHaveProperty('activation');
		expect(roomless).not.toHaveProperty('exchange');
		await site.dispose();
	});

	it('reads an image file as an image content part, and keeps only its byte count in the audit log', async () => {
		const site = audited();
		await site.use(scribe, (env) => env.writeFile('/home/scribe/photo.png', PNG, ctx));
		const result = await toolOf(site, 'read').invoke(
			{ path: 'photo.png' },
			callAs('scribe', { room: 'lobby' }),
		);
		if (typeof result === 'string') throw new Error('read must return a structured result.');
		const image = result.content.find((part) => part.type === 'image');
		if (image?.type !== 'image') throw new Error('read did not return an image part.');
		expect(image.mimeType).toBe('image/png');
		expect(image.data.length).toBeGreaterThan(0);

		const [entry] = await entriesOf(site);
		const logged = entry?.result as { content: { type: string; data?: string; bytes?: number }[] };
		const loggedImage = logged.content.find((part) => part.type === 'image');
		expect(loggedImage).toMatchObject({ type: 'image', mimeType: 'image/png' });
		expect(loggedImage?.data).toBeUndefined();
		expect(loggedImage?.bytes).toBeGreaterThan(0);
		expect(JSON.stringify(entry)).not.toContain(image.data);
		await site.dispose();
	});

	it('records an error, and still throws it to the caller, for a call that fails and for a call the caller cuts mid-flight', async () => {
		const started = Promise.withResolvers<void>();
		const tool = (name: string, execute: (...args: never[]) => Promise<never>) => ({
			name,
			label: name,
			description: `The ${name} tool.`,
			parameters: Type.Object({}),
			execute,
		});
		const site = audited(
			wrapped(() => ({
				tools: [
					tool('explode', async () => {
						throw new Error('kaboom');
					}),
					tool(
						'slow',
						async (
							_id: string,
							_params: unknown,
							_onUpdate: unknown,
							_toolContext: unknown,
							_invocation: unknown,
							context: { abortSignal?: AbortSignal },
						) => {
							started.resolve();
							return new Promise<never>((_resolve, reject) => {
								const cut = () => reject(new Error('cut mid-flight'));
								if (context.abortSignal?.aborted) cut();
								context.abortSignal?.addEventListener('abort', cut, { once: true });
							});
						},
					),
				],
			})),
		);
		await expect(
			toolOf(site, 'explode').invoke({}, callAs('scribe', { callId: 'call-2', room: 'lobby' })),
		).rejects.toThrow('kaboom');
		const controller = new AbortController();
		const cut = toolOf(site, 'slow').invoke(
			{},
			callAs('scribe', { callId: 'call-cut', room: 'lobby', signal: controller.signal }),
		);
		// The call must be running, past the precondition check of use(), before the abort.
		await started.promise;
		controller.abort();
		await expect(cut).rejects.toThrow('cut mid-flight');

		const entries = await entriesOf(site);
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({
			room: 'lobby',
			agent: 'scribe',
			tool: 'explode',
			error: { name: 'Error', message: 'kaboom' },
		});
		expect(entries[0]).not.toHaveProperty('result');
		expect(entries[1]).toMatchObject({ tool: 'slow', error: { message: 'cut mid-flight' } });
		await site.dispose();
	});
});

describe('openAuditLog', () => {
	it('accumulates into one file, then rotates the whole file once it passes maxBytes', async () => {
		const env = await bareEnv();
		const oneLine = `${JSON.stringify(entryFor('one'))}\n`;
		const log = openAuditLog({ path: '/workspace/audit.jsonl', maxBytes: oneLine.length + 5 });

		await log.record(env, entryFor('one'), ctx);
		expect(await readLines(env, log.path)).toHaveLength(1);
		expect(await listNames(env, '/workspace')).toEqual(['audit.jsonl']);

		await log.record(env, entryFor('two'), ctx);
		const afterSecond = await listNames(env, '/workspace');
		const [rotated, ...more] = afterSecond.filter((entry) => entry.startsWith('audit.jsonl.'));
		expect(more).toEqual([]);
		expect(afterSecond).not.toContain('audit.jsonl');
		expect(await readLines(env, `/workspace/${rotated}`)).toHaveLength(2);

		await log.record(env, entryFor('three'), ctx);
		expect(await readLines(env, log.path)).toHaveLength(1);
	});

	it('falls back to a short notice when an entry will not serialize', async () => {
		const env = await bareEnv();
		const log = openAuditLog({ path: '/workspace/audit.jsonl' });
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		await log.record(env, { ...entryFor('bad'), arguments: circular }, ctx);
		const entries = await readLines(env, log.path);
		expect(entries[0]).toMatchObject({ callId: 'bad', error: { name: 'SerializationError' } });
	});

	it('falls back to a short notice, and keeps the call, when the full entry will not fit', async () => {
		const env = await bareEnv(1);
		const errors: Error[] = [];
		const log = openAuditLog({
			path: '/workspace/audit.jsonl',
			onError: (error) => errors.push(error),
		});
		await log.record(env, { ...entryFor('big'), arguments: { content: 'x'.repeat(1000) } }, ctx);
		expect(errors).toHaveLength(0);
		const [entry] = await readLines(env, log.path);
		expect(entry).toMatchObject({ callId: 'big', error: { name: 'RecordTooLarge' } });
		expect(entry).not.toHaveProperty('arguments');
	});

	it('reports to onError, and never throws, even from a throwing onError, when the notice does not fit either', async () => {
		const errors: Error[] = [];
		const reporting = await bareEnv(2);
		const path = '/workspace/audit.jsonl';
		const log = openAuditLog({ path, onError: (error) => errors.push(error) });
		await expect(log.record(reporting, entryFor('one'), ctx)).resolves.toBeUndefined();
		expect(errors).toHaveLength(1);
		expect(await reporting.exists(path, ctx)).toEqual({ ok: true, value: false });

		const throwing = openAuditLog({
			path,
			onError: () => {
				throw new Error('a broken onError callback');
			},
		});
		await expect(throwing.record(await bareEnv(2), entryFor('one'), ctx)).resolves.toBeUndefined();
	});
});
