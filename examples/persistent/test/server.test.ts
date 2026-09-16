import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import type { CreateRuntimeOptions } from '@ambionframework/ambion';
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
} from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'vitest';
import { openDemo } from '../src/server.ts';

type Demo = Awaited<ReturnType<typeof openDemo>>;
type ResponseBody = Record<string, unknown> | unknown[] | string;

const demos: { demo: Demo; directory: string }[] = [];

function scriptedResponse(agent: string, call: number, closing: boolean) {
	if (closing)
		return fauxAssistantMessage([fauxToolCall('say', { text: 'Summary: the room answered.' })], {
			stopReason: 'toolUse',
		});
	if (agent === 'assistant' && call === 1)
		return fauxAssistantMessage(
			[fauxToolCall('say', { to: 'builder', text: 'Please inspect the workspace.' })],
			{ stopReason: 'toolUse' },
		);
	if (agent === 'assistant' && call === 2)
		return fauxAssistantMessage([fauxToolCall('read', { path: '/home/builder/shared/demo.txt' })], {
			stopReason: 'toolUse',
		});
	if (agent === 'assistant' && call === 3)
		return fauxAssistantMessage(
			[fauxToolCall('say', { to: 'builder', text: 'I read the workspace file.' })],
			{ stopReason: 'toolUse' },
		);
	if (agent === 'builder' && call === 1)
		return fauxAssistantMessage(
			[fauxToolCall('write', { path: 'shared/demo.txt', content: 'written by builder\n' })],
			{ stopReason: 'toolUse' },
		);
	if (agent === 'builder' && call === 2)
		return fauxAssistantMessage(
			[fauxToolCall('say', { to: 'assistant', text: 'Workspace checked.' })],
			{ stopReason: 'toolUse' },
		);
	return fauxAssistantMessage('quiet', { stopReason: 'stop' });
}

const makeStream = (): CreateRuntimeOptions['stream'] => {
	const calls = new Map<string, number>();
	return (_model, context, options) => {
		const output = createAssistantMessageEventStream();
		const closing = context.systemPrompt?.includes('The exchange is over.') ?? false;
		const agent = context.systemPrompt?.match(/You are '([^']+)'/)?.[1] ?? 'assistant';
		const call = (calls.get(agent) ?? 0) + 1;
		calls.set(agent, call);
		const response = scriptedResponse(agent, call, closing);
		queueMicrotask(() => {
			if (options?.signal?.aborted) {
				output.push({
					type: 'error',
					reason: 'aborted',
					error: fauxAssistantMessage('', { stopReason: 'aborted', errorMessage: 'aborted' }),
				});
				return;
			}
			output.push({ type: 'start', partial: response });
			output.push({
				type: 'done',
				reason: response.stopReason as 'stop' | 'toolUse',
				message: response,
			});
		});
		return output;
	};
};

async function launch(mode: 'start' | 'resume', directory: string, customStream = makeStream()) {
	const demo = await openDemo(directory, mode, customStream);
	await new Promise<void>((resolve, reject) => {
		demo.server.once('error', reject);
		demo.server.listen(0, '127.0.0.1', () => resolve());
	});
	const address = demo.server.address();
	if (!address || typeof address === 'string')
		throw new Error('The test server did not bind a port.');
	demos.push({ demo, directory });
	return { demo, base: `http://127.0.0.1:${address.port}` };
}

async function request(base: string, path: string, init: RequestInit = {}) {
	const response = await fetch(`${base}${path}`, {
		...init,
		headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
	});
	const text = await response.text();
	let body: ResponseBody = {};
	if (text) {
		try {
			body = JSON.parse(text) as ResponseBody;
		} catch {
			body = text;
		}
	}
	return { response, body };
}

function json(method: string, body: unknown): RequestInit {
	return { method, body: JSON.stringify(body) };
}

async function freshDirectory() {
	return mkdtemp(joinPath(tmpdir(), 'ambion-persistent-http-'));
}

afterEach(async () => {
	for (const { demo, directory } of demos.splice(0)) {
		await demo.close().catch(() => undefined);
		await rm(directory, { recursive: true, force: true });
	}
});

describe('persistent browser host', () => {
	it('exposes people identities and four isolated rooms', async () => {
		const directory = await freshDirectory();
		const { base } = await launch('start', joinPath(directory, 'demo'));
		const people = await request(base, '/people');
		const rooms = await request(base, '/rooms');
		const page = await request(base, '/');
		expect(people.response.status).toBe(200);
		expect(people.body).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: 'alice', identity: expect.stringContaining('alice') }),
				expect.objectContaining({ name: 'bob', identity: expect.stringContaining('bob') }),
				expect.objectContaining({ name: 'cara', identity: expect.stringContaining('cara') }),
			]),
		);
		expect(rooms.response.status).toBe(200);
		expect((rooms.body as { name: string }[]).map((room) => room.name)).toEqual([
			'design',
			'delivery',
			'launch',
			'triage',
		]);
		expect(page.response.status).toBe(200);
		expect(String(page.body)).toContain('persistent rooms');
	});

	it('validates room creation and makes concurrent duplicates conflict', async () => {
		const directory = await freshDirectory();
		const { base } = await launch('start', joinPath(directory, 'demo'));
		const [first, second] = await Promise.all([
			request(base, '/rooms', json('POST', { name: 'research', goal: 'Compare approaches.' })),
			request(base, '/rooms', json('POST', { name: 'research', goal: 'Compare approaches.' })),
		]);
		expect([first.response.status, second.response.status].sort()).toEqual([201, 409]);
		for (const invalid of [
			{ name: 'Bad Name', goal: 'x' },
			{ name: 'empty-goal', goal: '   ' },
			{ name: 'missing-goal' },
		]) {
			const result = await request(base, '/rooms', json('POST', invalid));
			expect(result.response.status).toBe(400);
		}
	});

	it('attributes human deliveries, retries by key, and keeps rooms independent', async () => {
		const directory = await freshDirectory();
		const { base } = await launch('start', joinPath(directory, 'demo'));
		expect(
			(await request(base, '/rooms/design/humans/alice', { method: 'PUT' })).response.status,
		).toBe(200);
		expect(
			(await request(base, '/rooms/delivery/humans/bob', { method: 'PUT' })).response.status,
		).toBe(200);
		const first = await request(
			base,
			'/rooms/design/humans/alice',
			json('POST', { key: 'design-1', text: 'Design question.' }),
		);
		const retry = await request(
			base,
			'/rooms/design/humans/alice',
			json('POST', { key: 'design-1', text: 'Design question.' }),
		);
		const other = await request(
			base,
			'/rooms/delivery/humans/bob',
			json('POST', { key: 'delivery-1', text: 'Delivery question.' }),
		);
		const design = await request(base, '/rooms/design/messages?since=0');
		const delivery = await request(base, '/rooms/delivery/messages?since=0');
		expect(first.response.status).toBe(202);
		expect(retry.response.status).toBe(202);
		expect((retry.body as { from: number }).from).toBe((first.body as { from: number }).from);
		expect(other.response.status).toBe(202);
		expect(design.body as { from?: string; text?: string }[]).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ from: 'alice', text: 'Design question.' }),
			]),
		);
		expect(delivery.body as { from?: string; text?: string }[]).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ from: 'bob', text: 'Delivery question.' }),
			]),
		);
		expect((design.body as { from?: string }[]).some((message) => message.from === 'bob')).toBe(
			false,
		);
		expect((delivery.body as { from?: string }[]).some((message) => message.from === 'alice')).toBe(
			false,
		);
	});

	it('stops, reads history, and stays stopped across a host restart until resumed', async () => {
		const parent = await freshDirectory();
		const directory = joinPath(parent, 'demo');
		let host = await launch('start', directory);
		expect(
			(await request(host.base, '/rooms/design/humans/alice', { method: 'PUT' })).response.status,
		).toBe(200);
		const sent = await request(
			host.base,
			'/rooms/design/humans/alice',
			json('POST', { key: 'stop-1', text: 'Persist this.' }),
		);
		const before = await request(host.base, '/rooms/design/messages?since=0');
		const stopped = await request(host.base, '/rooms/design/stop', { method: 'POST' });
		const stoppedHistory = await request(host.base, '/rooms/design/messages?since=0');
		expect(sent.response.status).toBe(202);
		expect(stopped.response.status).toBe(200);
		expect((stopped.body as { status: string }).status).toBe('stopped');
		expect(stoppedHistory.response.status).toBe(200);
		expect(stoppedHistory.body).toEqual(expect.arrayContaining(before.body as unknown[]));
		expect(
			(stoppedHistory.body as { kind: string }[]).some((message) => message.kind === 'left'),
		).toBe(true);
		await host.demo.close();
		host = await launch('resume', directory);
		const afterRestart = await request(host.base, '/rooms');
		expect(
			(afterRestart.body as { name: string; status: string }[]).find(
				(room) => room.name === 'design',
			)?.status,
		).toBe('stopped');
		const resumed = await request(host.base, '/rooms/design/resume', { method: 'POST' });
		expect(resumed.response.status).toBe(200);
		expect((resumed.body as { status: string }).status).toBe('running');
	});

	it('does not fabricate arrival on an absent leave and rejects unsafe file paths', async () => {
		const parent = await freshDirectory();
		const directory = joinPath(parent, 'demo');
		const { base } = await launch('start', directory);
		const initial = await request(base, '/rooms/design/messages?since=0');
		expect(initial.body).toEqual([]);
		const absentLeave = await request(base, '/rooms/design/humans/alice', { method: 'DELETE' });
		const afterAbsentLeave = await request(base, '/rooms/design/messages?since=0');
		expect(absentLeave.response.status).toBe(200);
		expect(afterAbsentLeave.body).toEqual(initial.body);
		expect(
			(await request(base, '/rooms/design/humans/alice', { method: 'PUT' })).response.status,
		).toBe(200);
		const leave = await request(base, '/rooms/design/humans/alice', { method: 'DELETE' });
		const afterLeave = await request(base, '/rooms/design/messages?since=0');
		const delayed = await request(
			base,
			'/rooms/design/humans/alice',
			json('POST', { key: 'after-leave', text: 'Must rejoin explicitly.' }),
		);
		const after = await request(base, '/rooms/design/messages?since=0');
		const workspace = await request(base, '/workspace');
		const root = (workspace.body as { root: string }).root;
		await writeFile(joinPath(root, 'plain.txt'), 'safe');
		await symlink('/etc/hosts', joinPath(root, 'escape.txt'));
		const plain = await request(base, '/file?path=%2Fplain.txt');
		const escaped = await request(base, '/file?path=%2Fescape.txt');
		const traversal = await request(base, '/file?path=%2F..%2Frooms.db');
		expect(leave.response.status).toBe(200);
		expect(delayed.response.status).toBe(409);
		expect(after.body).toEqual(afterLeave.body);
		expect(
			(after.body as { kind: string }[]).filter((message) => message.kind === 'arrived'),
		).toHaveLength(1);
		expect(plain.response.status).toBe(200);
		expect((plain.body as { text: string }).text).toBe('safe');
		expect(escaped.response.status).toBe(400);
		expect(traversal.response.status).toBe(400);
	});

	it('publishes a configured summary and persists the shared workspace after restart', async () => {
		const parent = await freshDirectory();
		const directory = joinPath(parent, 'demo');
		let host = await launch('start', directory);
		expect(
			(await request(host.base, '/rooms/delivery/humans/alice', { method: 'PUT' })).response.status,
		).toBe(200);
		const sent = await request(
			host.base,
			'/rooms/delivery/humans/alice',
			json('POST', { key: 'summary-1', text: 'Please check the workspace.' }),
		);
		const discussion = await request(
			host.base,
			`/rooms/delivery/exchanges/${(sent.body as { from: number }).from}`,
		);
		const messages = await request(host.base, '/rooms/delivery/messages?since=0');
		const workspace = await request(host.base, '/workspace');
		const filePath = encodeURIComponent('/home/builder/shared/demo.txt');
		const fileBeforeRestart = await request(host.base, `/file?path=${filePath}`);
		const otherRoomHistory = await request(host.base, '/rooms/design/messages?since=0');
		const sharedWorkspace = await request(host.base, '/workspace');
		expect(discussion.response.status).toBe(200);
		expect(
			(messages.body as { kind: string }[]).some((message) => message.kind === 'summary'),
		).toBe(true);
		expect(
			(workspace.body as { files: { path: string }[] }).files.some((file) =>
				file.path.includes('demo.txt'),
			),
		).toBe(true);
		expect(fileBeforeRestart.response.status).toBe(200);
		expect((fileBeforeRestart.body as { text: string }).text).toBe('written by builder\n');
		expect(otherRoomHistory.response.status).toBe(200);
		expect(
			(sharedWorkspace.body as { files: { path: string }[] }).files.some((file) =>
				file.path.includes('demo.txt'),
			),
		).toBe(true);
		await host.demo.close();
		host = await launch('resume', directory);
		const files = await request(host.base, '/workspace');
		const fileAfterRestart = await request(host.base, `/file?path=${filePath}`);
		expect(
			(files.body as { files: { path: string }[] }).files.some((file) =>
				file.path.includes('demo.txt'),
			),
		).toBe(true);
		expect(fileAfterRestart.response.status).toBe(200);
		expect((fileAfterRestart.body as { text: string }).text).toBe('written by builder\n');
	});

	it('keeps a long exchange request independent from people and abort', async () => {
		const pendingStream: CreateRuntimeOptions['stream'] = () => createAssistantMessageEventStream();
		const directory = await freshDirectory();
		const { base } = await launch('start', joinPath(directory, 'demo'), pendingStream);
		expect(
			(await request(base, '/rooms/design/humans/alice', { method: 'PUT' })).response.status,
		).toBe(200);
		const sent = await request(
			base,
			'/rooms/design/humans/alice',
			json('POST', { key: 'pending-1', text: 'Wait for work.' }),
		);
		const controller = new AbortController();
		const waiting = fetch(
			`${base}/rooms/design/exchanges/${(sent.body as { from: number }).from}`,
			{ signal: controller.signal },
		);
		const people = await request(base, '/people');
		const aborted = await request(base, '/rooms/design/abort', { method: 'POST' });
		controller.abort();
		await expect(waiting).rejects.toThrow();
		expect(people.response.status).toBe(200);
		expect(aborted.response.status).toBe(202);
	});
});
