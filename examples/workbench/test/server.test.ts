import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import type { CreateRuntimeOptions } from '@ambionframework/ambion';
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
} from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'vitest';
import { openWorkbench } from '../src/server.ts';

type Workbench = Awaited<ReturnType<typeof openWorkbench>>;
type ResponseBody = Record<string, unknown> | unknown[] | string;

const workbenches: { workbench: Workbench; directory: string }[] = [];

const PLAN = 'LED plan: 330 ohm series resistor at 10 mA.\n';

function scriptedResponse(agent: string, call: number, closing: boolean) {
	if (closing)
		return fauxAssistantMessage([fauxToolCall('say', { text: 'Summary: the bench answered.' })], {
			stopReason: 'toolUse',
		});
	if (agent === 'assistant' && call === 1)
		return fauxAssistantMessage(
			[fauxToolCall('say', { to: 'design', text: 'Please choose the resistor.' })],
			{ stopReason: 'toolUse' },
		);
	if (agent === 'assistant' && call === 2)
		return fauxAssistantMessage([fauxToolCall('read', { path: '/library/led-5mm.md' })], {
			stopReason: 'toolUse',
		});
	if (agent === 'assistant' && call === 3)
		return fauxAssistantMessage(
			[fauxToolCall('say', { to: 'design', text: 'Thanks, that is clear.' })],
			{ stopReason: 'toolUse' },
		);
	if (agent === 'design' && call === 1)
		return fauxAssistantMessage(
			[fauxToolCall('write', { path: 'shared/plan.md', content: PLAN })],
			{
				stopReason: 'toolUse',
			},
		);
	if (agent === 'design' && call === 2)
		return fauxAssistantMessage(
			[fauxToolCall('say', { to: 'assistant', text: 'Resistor chosen.' })],
			{
				stopReason: 'toolUse',
			},
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
	const workbench = await openWorkbench(directory, mode, customStream);
	await new Promise<void>((resolve, reject) => {
		workbench.server.once('error', reject);
		workbench.server.listen(0, '127.0.0.1', () => resolve());
	});
	const address = workbench.server.address();
	if (!address || typeof address === 'string')
		throw new Error('The test server did not bind a port.');
	workbenches.push({ workbench, directory });
	return { workbench, base: `http://127.0.0.1:${address.port}` };
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

async function waitForSummary(base: string) {
	let result = await request(base, '/rooms/bringup/messages?since=0');
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if ((result.body as { kind?: string }[]).some((message) => message.kind === 'summary'))
			return result;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
		result = await request(base, '/rooms/bringup/messages?since=0');
	}
	return result;
}

function json(method: string, body: unknown): RequestInit {
	return { method, body: JSON.stringify(body) };
}

async function freshDirectory() {
	return mkdtemp(joinPath(tmpdir(), 'ambion-workbench-http-'));
}

afterEach(async () => {
	for (const { workbench, directory } of workbenches.splice(0)) {
		await workbench.close().catch(() => undefined);
		await rm(directory, { recursive: true, force: true });
	}
});

describe('Workbench host', () => {
	it('serves the people, the rooms, and the branded page', async () => {
		const directory = await freshDirectory();
		const { base } = await launch('start', joinPath(directory, 'run'));
		const people = await request(base, '/people');
		const rooms = await request(base, '/rooms');
		const page = await request(base, '/');
		const css = await request(base, '/brand/tokens/ambion.css');
		expect(people.response.status).toBe(200);
		expect(people.body).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: 'mira', identity: expect.stringContaining('mira') }),
				expect.objectContaining({ name: 'theo', identity: expect.stringContaining('theo') }),
				expect.objectContaining({ name: 'sol', identity: expect.stringContaining('sol') }),
			]),
		);
		expect((rooms.body as { name: string }[]).map((room) => room.name)).toEqual([
			'bringup',
			'sensing',
			'power',
		]);
		expect(page.response.status).toBe(200);
		expect(String(page.body)).toContain('Workbench');
		expect(css.response.status).toBe(200);
		expect(String(css.body)).toContain('--ambion-teal');
	});

	it('validates room creation and makes concurrent duplicates conflict', async () => {
		const directory = await freshDirectory();
		const { base } = await launch('start', joinPath(directory, 'run'));
		const [first, second] = await Promise.all([
			request(base, '/rooms', json('POST', { name: 'motors', goal: 'Drive a small motor.' })),
			request(base, '/rooms', json('POST', { name: 'motors', goal: 'Drive a small motor.' })),
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
		const { base } = await launch('start', joinPath(directory, 'run'));
		expect(
			(await request(base, '/rooms/bringup/humans/mira', { method: 'PUT' })).response.status,
		).toBe(200);
		expect(
			(await request(base, '/rooms/sensing/humans/theo', { method: 'PUT' })).response.status,
		).toBe(200);
		const first = await request(
			base,
			'/rooms/bringup/humans/mira',
			json('POST', { key: 'bringup-1', text: 'Which resistor?' }),
		);
		const retry = await request(
			base,
			'/rooms/bringup/humans/mira',
			json('POST', { key: 'bringup-1', text: 'Which resistor?' }),
		);
		const other = await request(
			base,
			'/rooms/sensing/humans/theo',
			json('POST', { key: 'sensing-1', text: 'Which pins?' }),
		);
		const bringup = await request(base, '/rooms/bringup/messages?since=0');
		const sensing = await request(base, '/rooms/sensing/messages?since=0');
		expect(first.response.status).toBe(202);
		expect(retry.response.status).toBe(202);
		expect((retry.body as { from: number }).from).toBe((first.body as { from: number }).from);
		expect(other.response.status).toBe(202);
		expect(bringup.body as { from?: string; text?: string }[]).toEqual(
			expect.arrayContaining([expect.objectContaining({ from: 'mira', text: 'Which resistor?' })]),
		);
		expect(sensing.body as { from?: string; text?: string }[]).toEqual(
			expect.arrayContaining([expect.objectContaining({ from: 'theo', text: 'Which pins?' })]),
		);
		expect((bringup.body as { from?: string }[]).some((message) => message.from === 'theo')).toBe(
			false,
		);
		expect((sensing.body as { from?: string }[]).some((message) => message.from === 'mira')).toBe(
			false,
		);
	});

	it('requires reentry before retrying an accepted delivery after departure', async () => {
		const directory = await freshDirectory();
		const { base } = await launch('start', joinPath(directory, 'run'));
		const path = '/rooms/bringup/humans/mira';
		const delivery = { key: 'departed-retry', text: 'Keep this delivery.' };
		await request(base, path, { method: 'PUT' });
		const first = await request(base, path, json('POST', delivery));
		expect(first.response.status).toBe(202);
		await request(base, path, { method: 'DELETE' });
		const absent = await request(base, path, json('POST', delivery));
		expect(absent.response.status).toBe(409);
		await request(base, path, { method: 'PUT' });
		const retry = await request(base, path, json('POST', delivery));
		expect(retry.response.status).toBe(202);
		expect(retry.body).toEqual(first.body);
		const after = await request(base, '/rooms/bringup/messages');
		expect((after.body as { key?: string }[]).filter((m) => m.key === delivery.key)).toHaveLength(
			1,
		);
	});

	it('stops, reads history, and stays stopped across a host restart until resumed', async () => {
		const parent = await freshDirectory();
		const directory = joinPath(parent, 'run');
		let host = await launch('start', directory);
		expect(
			(await request(host.base, '/rooms/bringup/humans/mira', { method: 'PUT' })).response.status,
		).toBe(200);
		const sent = await request(
			host.base,
			'/rooms/bringup/humans/mira',
			json('POST', { key: 'stop-1', text: 'Persist this.' }),
		);
		const before = await request(host.base, '/rooms/bringup/messages?since=0');
		const stopped = await request(host.base, '/rooms/bringup/stop', { method: 'POST' });
		const stoppedHistory = await request(host.base, '/rooms/bringup/messages?since=0');
		expect(sent.response.status).toBe(202);
		expect(stopped.response.status).toBe(200);
		expect((stopped.body as { status: string }).status).toBe('stopped');
		expect(stoppedHistory.body).toEqual(expect.arrayContaining(before.body as unknown[]));
		await host.workbench.close();
		host = await launch('resume', directory);
		const afterRestart = await request(host.base, '/rooms');
		expect(
			(afterRestart.body as { name: string; status: string }[]).find(
				(room) => room.name === 'bringup',
			)?.status,
		).toBe('stopped');
		const resumed = await request(host.base, '/rooms/bringup/resume', { method: 'POST' });
		expect(resumed.response.status).toBe(200);
		expect((resumed.body as { status: string }).status).toBe('running');
	}, 20_000);

	it('lists the seeded library, hides shell devices, and rejects unsafe file paths', async () => {
		const parent = await freshDirectory();
		const directory = joinPath(parent, 'run');
		const { base } = await launch('start', directory);
		const workspace = await request(base, '/workspace');
		const root = (workspace.body as { root: string }).root;
		await writeFile(joinPath(root, 'plain.txt'), 'safe');
		await mkdir(joinPath(root, 'dev'), { recursive: true });
		await writeFile(joinPath(root, 'dev/null'), '');
		const listing = await request(base, '/workspace');
		const paths = (listing.body as { files: { path: string }[] }).files.map((file) => file.path);
		expect(paths).toContain('/plain.txt');
		expect(paths).toContain('/library/led-5mm.md');
		expect(paths).toContain('/shared/kit.md');
		expect(paths).not.toContain('/dev/null');
		await symlink('/etc/hosts', joinPath(root, 'escape.txt'));
		const led = await request(base, '/file?path=%2Flibrary%2Fled-5mm.md');
		const escaped = await request(base, '/file?path=%2Fescape.txt');
		const traversal = await request(base, '/file?path=%2F..%2Frooms.db');
		expect(led.response.status).toBe(200);
		expect((led.body as { text: string }).text).toContain('forward voltage');
		expect(escaped.response.status).toBe(400);
		expect(traversal.response.status).toBe(400);
	});

	it('publishes a summary, records a specialist artifact, and keeps it after restart', async () => {
		const parent = await freshDirectory();
		const directory = joinPath(parent, 'run');
		let host = await launch('start', directory);
		expect(
			(await request(host.base, '/rooms/bringup/humans/mira', { method: 'PUT' })).response.status,
		).toBe(200);
		const sent = await request(
			host.base,
			'/rooms/bringup/humans/mira',
			json('POST', { key: 'summary-1', text: 'Pick the LED resistor.' }),
		);
		const discussion = await request(
			host.base,
			`/rooms/bringup/exchanges/${(sent.body as { from: number }).from}`,
		);
		const messages = await waitForSummary(host.base);
		const filePath = encodeURIComponent('/home/design/shared/plan.md');
		const fileBeforeRestart = await request(host.base, `/file?path=${filePath}`);
		expect(discussion.response.status).toBe(200);
		expect(
			(messages.body as { kind: string }[]).some((message) => message.kind === 'summary'),
		).toBe(true);
		expect(fileBeforeRestart.response.status).toBe(200);
		expect((fileBeforeRestart.body as { text: string }).text).toBe(PLAN);
		await host.workbench.close();
		host = await launch('resume', directory);
		const fileAfterRestart = await request(host.base, `/file?path=${filePath}`);
		expect(fileAfterRestart.response.status).toBe(200);
		expect((fileAfterRestart.body as { text: string }).text).toBe(PLAN);
	}, 20_000);

	it('keeps a long exchange request independent from people and abort', async () => {
		const pendingStream: CreateRuntimeOptions['stream'] = () => createAssistantMessageEventStream();
		const directory = await freshDirectory();
		const { base } = await launch('start', joinPath(directory, 'run'), pendingStream);
		expect(
			(await request(base, '/rooms/bringup/humans/mira', { method: 'PUT' })).response.status,
		).toBe(200);
		const sent = await request(
			base,
			'/rooms/bringup/humans/mira',
			json('POST', { key: 'pending-1', text: 'Wait for work.' }),
		);
		const controller = new AbortController();
		const waiting = fetch(
			`${base}/rooms/bringup/exchanges/${(sent.body as { from: number }).from}`,
			{
				signal: controller.signal,
			},
		);
		const exchange = await waiting;
		const aborted = await request(base, '/rooms/bringup/abort', { method: 'POST' });
		controller.abort();
		const status = await request(base, '/rooms/bringup');
		expect(exchange.status).toBe(200);
		expect(aborted.response.status).toBe(200);
		expect((aborted.body as { exchange?: unknown }).exchange).toBeUndefined();
		expect((aborted.body as { exchanges: unknown[] }).exchanges).toContainEqual(
			expect.objectContaining({
				from: (sent.body as { from: number }).from,
				status: 'closed',
				summary: { status: 'silent' },
			}),
		);
		expect(status.response.status).toBe(200);
		expect((status.body as { exchange?: unknown }).exchange).toBeUndefined();
	});
});
