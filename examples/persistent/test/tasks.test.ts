import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskView } from '@ambionframework/ambion';
import { afterEach, describe, expect, it } from 'vitest';
import { openDemo } from '../src/server.ts';
import { type TaskStreamControl, taskStream } from './task-stream.ts';

interface Demo {
	demo: Awaited<ReturnType<typeof openDemo>>;
	base: string;
	directory: string;
}

const demos: Demo[] = [];

async function launch(control: TaskStreamControl, directory: string): Promise<Demo> {
	const demo = await openDemo(directory, 'start', control.stream);
	await new Promise<void>((resolve, reject) => {
		demo.server.once('error', reject);
		demo.server.listen(0, '127.0.0.1', () => resolve());
	});
	const address = demo.server.address();
	if (!address || typeof address === 'string')
		throw new Error('The test server did not bind a port.');
	const result = { demo, base: `http://127.0.0.1:${address.port}`, directory };
	demos.push(result);
	return result;
}

async function request(base: string, path: string, init: RequestInit = {}) {
	const response = await fetch(`${base}${path}`, {
		...init,
		headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
	});
	const text = await response.text();
	let body: unknown = {};
	if (text) {
		try {
			body = JSON.parse(text) as unknown;
		} catch {
			body = text;
		}
	}
	return { response, body };
}

function json(body: unknown): RequestInit {
	return { method: 'POST', body: JSON.stringify(body) };
}

async function freshDirectory(): Promise<string> {
	const parent = await mkdtemp(join(tmpdir(), 'ambion-persistent-tasks-'));
	return join(parent, 'demo');
}

async function eventually<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const value = await read();
		if (ready(value)) return value;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error('The Task did not reach the expected state.');
}

afterEach(async () => {
	for (const { demo, directory } of demos.splice(0)) {
		await demo.close().catch(() => undefined);
		await rm(directory, { recursive: true, force: true });
	}
});

describe('persistent Task relay', () => {
	it('keeps a background Task open while the owner answers another human message', async () => {
		const directory = await freshDirectory();
		const control = taskStream({ workerDelayMs: 200 });
		const { base } = await launch(control, directory);
		await request(base, '/rooms/delivery/humans/alice', { method: 'PUT' });
		await request(
			base,
			'/rooms/delivery/humans/alice',
			json({ key: 'task-start', text: 'Please start a background task.' }),
		);
		const parent = await eventually(
			async () => (await request(base, '/rooms/delivery')).body,
			(body) =>
				typeof body === 'object' &&
				body !== null &&
				'tasks' in body &&
				Array.isArray(body.tasks) &&
				body.tasks.length === 1,
		);
		const task = (parent as { tasks: TaskView[] }).tasks[0];
		if (task === undefined) throw new Error('The parent did not return its Task.');
		expect(task.status).toBe('open');
		const endpoint = await request(base, `/rooms/delivery/tasks/${task.id}`);
		expect(endpoint.response.status).toBe(200);
		expect(endpoint.body).toMatchObject({
			task: { id: task.id, status: 'open' },
			room: { name: task.workingRoom },
		});

		await request(
			base,
			'/rooms/delivery/humans/alice',
			json({ key: 'task-followup', text: 'While the background task runs, what is its status?' }),
		);
		const messages = await eventually(
			async () => (await request(base, '/rooms/delivery/messages?since=0')).body,
			(body) =>
				Array.isArray(body) &&
				body.some(
					(message) =>
						typeof message === 'object' &&
						message !== null &&
						'text' in message &&
						String(message.text).includes('background Task is still running'),
				),
		);
		expect(messages).toEqual(expect.any(Array));
		const completed = await eventually(
			async () => (await request(base, `/rooms/delivery/tasks/${task.id}`)).body,
			(body) =>
				typeof body === 'object' &&
				body !== null &&
				'task' in body &&
				(body.task as TaskView).status === 'succeeded',
		);
		expect(completed).toMatchObject({ task: { id: task.id, status: 'succeeded' } });
	});

	it('reads a terminal failed Task and rejects the child as a parent', async () => {
		const directory = await freshDirectory();
		const control = taskStream({ workerDelayMs: 20, workerStatus: 'failed' });
		const { base } = await launch(control, directory);
		await request(base, '/rooms/delivery/humans/alice', { method: 'PUT' });
		await request(
			base,
			'/rooms/delivery/humans/alice',
			json({ key: 'task-fail', text: 'Start a background task that must fail.' }),
		);
		const parent = await eventually(
			async () => (await request(base, '/rooms/delivery')).body,
			(body) =>
				typeof body === 'object' &&
				body !== null &&
				'tasks' in body &&
				Array.isArray(body.tasks) &&
				body.tasks.length === 1,
		);
		const task = (parent as { tasks: TaskView[] }).tasks[0];
		if (task === undefined) throw new Error('The parent did not return its Task.');
		const failed = await eventually(
			async () => (await request(base, `/rooms/delivery/tasks/${task.id}`)).body,
			(body) =>
				typeof body === 'object' &&
				body !== null &&
				'task' in body &&
				(body.task as TaskView).status === 'failed',
		);
		expect(failed).toMatchObject({ task: { id: task.id, status: 'failed' } });
		const child = await request(base, `/rooms/${task.workingRoom}/tasks/${task.id}`);
		expect(child.response.status).toBe(404);
	});
});
