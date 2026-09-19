import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CreateRuntimeOptions } from '@ambionframework/ambion';
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
} from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'vitest';
import { openWorkbench, type Workbench } from '../src/workbench.ts';

const opened: { workbench: Workbench; directory: string }[] = [];

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
			{ stopReason: 'toolUse' },
		);
	if (agent === 'design' && call === 2)
		return fauxAssistantMessage(
			[fauxToolCall('say', { to: 'assistant', text: 'Resistor chosen.' })],
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

async function open(directory: string, stream = makeStream()) {
	const workbench = await openWorkbench({ directory, stream });
	opened.push({ workbench, directory });
	return workbench;
}

const freshDirectory = () => mkdtemp(joinPath(tmpdir(), 'ambion-workbench-host-'));

async function messagesOf(workbench: Workbench, room: string) {
	return (await workbench.read(room, 0)).messages;
}

async function untilSummary(workbench: Workbench, room: string) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const messages = await messagesOf(workbench, room);
		if (messages.some((message) => message.kind === 'summary')) return messages;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	return messagesOf(workbench, room);
}

afterEach(async () => {
	for (const { workbench, directory } of opened.splice(0)) {
		await workbench.close().catch(() => undefined);
		await rm(directory, { recursive: true, force: true });
	}
});

describe('Workbench host', () => {
	it('lists the people and the three sample rooms, and resumes them without seeding again', async () => {
		const parent = await freshDirectory();
		const directory = joinPath(parent, 'run');
		const first = await open(directory);
		expect(first.people.map((person) => person.name)).toEqual(['mira', 'theo', 'sol']);
		expect((await first.rooms()).map((room) => [room.name, room.status])).toEqual([
			['bringup', 'running'],
			['sensing', 'running'],
			['power', 'running'],
		]);
		await first.close();
		const again = await open(directory);
		expect((await again.rooms()).map((room) => room.name)).toEqual(['bringup', 'sensing', 'power']);
	});

	it('creates a room, and refuses a duplicate and a bad name or goal', async () => {
		const workbench = await open(joinPath(await freshDirectory(), 'run'));
		const created = await workbench.create('motors', '  Drive a small motor.  ');
		expect(created).toMatchObject({
			name: 'motors',
			status: 'running',
			goal: 'Drive a small motor.',
		});
		await expect(workbench.create('motors', 'Again.')).rejects.toThrow(/already exists/);
		for (const [name, goal] of [
			['Bad Name', 'x'],
			['9lives', 'x'],
			['empty-goal', '   '],
			['long-goal', 'x'.repeat(2_001)],
		] as const)
			await expect(workbench.create(name, goal)).rejects.toThrow(/room name|room goal/);
		expect((await workbench.rooms()).map((room) => room.name)).toContain('motors');
	});

	it('attributes deliveries, retries by key, and keeps rooms independent', async () => {
		const workbench = await open(joinPath(await freshDirectory(), 'run'));
		await workbench.join('bringup', 'mira');
		await workbench.join('sensing', 'theo');
		await workbench.send('bringup', 'mira', 'bringup-1', 'Which resistor?');
		await workbench.send('bringup', 'mira', 'bringup-1', 'Which resistor?');
		await workbench.send('sensing', 'theo', 'sensing-1', 'Which pins?');
		const bringup = await messagesOf(workbench, 'bringup');
		const sensing = await messagesOf(workbench, 'sensing');
		expect(
			bringup.filter((message) => 'key' in message && message.key === 'bringup-1'),
		).toHaveLength(1);
		expect(bringup).toEqual(
			expect.arrayContaining([expect.objectContaining({ from: 'mira', text: 'Which resistor?' })]),
		);
		expect(sensing).toEqual(
			expect.arrayContaining([expect.objectContaining({ from: 'theo', text: 'Which pins?' })]),
		);
		expect(bringup.some((message) => 'from' in message && message.from === 'theo')).toBe(false);
		expect(sensing.some((message) => 'from' in message && message.from === 'mira')).toBe(false);
	});

	it('requires a person to be present before sending, also after leaving', async () => {
		const workbench = await open(joinPath(await freshDirectory(), 'run'));
		await expect(workbench.send('bringup', 'mira', 'k0', 'Hello?')).rejects.toThrow(
			/Enter this room/,
		);
		await workbench.join('bringup', 'mira');
		await workbench.send('bringup', 'mira', 'k1', 'Keep this delivery.');
		await workbench.leave('bringup', 'mira');
		await expect(workbench.send('bringup', 'mira', 'k1', 'Keep this delivery.')).rejects.toThrow(
			/Enter this room/,
		);
		await workbench.join('bringup', 'mira');
		await workbench.send('bringup', 'mira', 'k1', 'Keep this delivery.');
		const messages = await messagesOf(workbench, 'bringup');
		expect(messages.filter((message) => 'key' in message && message.key === 'k1')).toHaveLength(1);
		expect(messages.filter((message) => message.kind === 'arrived')).toHaveLength(2);
	});

	it('does not record a departure for a person who never entered, and rejects an unknown person', async () => {
		const workbench = await open(joinPath(await freshDirectory(), 'run'));
		const before = await messagesOf(workbench, 'bringup');
		await workbench.leave('bringup', 'sol');
		expect(await messagesOf(workbench, 'bringup')).toEqual(before);
		await expect(workbench.join('bringup', 'nobody')).rejects.toThrow(/Unknown person/);
		await expect(workbench.join('nowhere', 'mira')).rejects.toThrow(/Unknown room/);
	});

	it('stops, keeps its history, and stays stopped across a restart until resumed', async () => {
		const parent = await freshDirectory();
		const directory = joinPath(parent, 'run');
		let workbench = await open(directory);
		await workbench.join('bringup', 'mira');
		await workbench.send('bringup', 'mira', 'stop-1', 'Persist this.');
		const before = await messagesOf(workbench, 'bringup');
		const stopped = await workbench.control('bringup', 'stop');
		expect(stopped.status).toBe('stopped');
		const history = await messagesOf(workbench, 'bringup');
		expect(history).toEqual(expect.arrayContaining(before as unknown[]));
		expect(history.some((message) => message.kind === 'left')).toBe(true);
		await workbench.close();
		workbench = await open(directory);
		const restarted = await workbench.rooms();
		expect(restarted.find((room) => room.name === 'bringup')?.status).toBe('stopped');
		expect(restarted.find((room) => room.name === 'power')?.status).toBe('running');
		const resumed = await workbench.control('bringup', 'resume');
		expect(resumed.status).toBe('running');
	}, 20_000);

	it('lists the seeded library, hides shell devices, and refuses unsafe file paths', async () => {
		const directory = joinPath(await freshDirectory(), 'run');
		const workbench = await open(directory);
		const root = joinPath(directory, 'workspace');
		await writeFile(joinPath(root, 'plain.txt'), 'safe');
		await mkdir(joinPath(root, 'dev'), { recursive: true });
		await writeFile(joinPath(root, 'dev/null'), '');
		await symlink('/etc/hosts', joinPath(root, 'escape.txt'));
		const paths = (await workbench.files()).map((file) => file.path);
		expect(paths).toEqual(
			expect.arrayContaining(['/plain.txt', '/library/led-5mm.md', '/shared/kit.md']),
		);
		expect(paths).not.toContain('/dev/null');
		expect((await workbench.file('/library/led-5mm.md')).text).toContain('forward voltage');
		expect((await workbench.file('/plain.txt')).text).toBe('safe');
		await expect(workbench.file('/escape.txt')).rejects.toThrow(/symbolic links/);
		await expect(workbench.file('/../rooms.db')).rejects.toThrow(/absolute workspace file path/);
		await expect(workbench.file('/missing.md')).rejects.toThrow(/File not found/);
	});

	it('publishes a summary, records a specialist artifact, and keeps it after restart', async () => {
		const parent = await freshDirectory();
		const directory = joinPath(parent, 'run');
		let workbench = await open(directory);
		await workbench.join('bringup', 'mira');
		await workbench.send('bringup', 'mira', 'summary-1', 'Pick the LED resistor.');
		const messages = await untilSummary(workbench, 'bringup');
		expect(messages.some((message) => message.kind === 'summary')).toBe(true);
		const path = '/home/design/shared/plan.md';
		expect((await workbench.file(path)).text).toBe(PLAN);
		await workbench.close();
		workbench = await open(directory);
		expect((await workbench.file(path)).text).toBe(PLAN);
	}, 20_000);

	it('previews a SQLite database as tables, and refuses a file that is not one', async () => {
		const directory = joinPath(await freshDirectory(), 'run');
		const workbench = await open(directory);
		const root = joinPath(directory, 'workspace');
		const database = new DatabaseSync(joinPath(root, 'shared/data.db'));
		database.exec(
			'CREATE TABLE readings (id INTEGER PRIMARY KEY, note TEXT); INSERT INTO readings (note) VALUES (\'near\'), (NULL); CREATE TABLE "odd name" (a);',
		);
		database.close();
		await writeFile(joinPath(root, 'shared/fake.db'), 'not a database');
		const preview = await workbench.file('/shared/data.db');
		expect(preview.tables).toEqual([
			{ name: 'odd name', columns: ['a'], rows: [], count: 0 },
			{
				name: 'readings',
				columns: ['id', 'note'],
				rows: [
					['1', 'near'],
					['2', 'NULL'],
				],
				count: 2,
			},
		]);
		expect(preview.text).toContain('# readings (2 rows)');
		await expect(workbench.file('/shared/fake.db')).rejects.toThrow(/not a SQLite database/);
	});

	it('aborts an open exchange and keeps the room available', async () => {
		const workbench = await open(joinPath(await freshDirectory(), 'run'), () =>
			createAssistantMessageEventStream(),
		);
		await workbench.join('bringup', 'mira');
		await workbench.send('bringup', 'mira', 'pending-1', 'Wait for work.');
		expect((await workbench.read('bringup', 0)).exchange).toBeDefined();
		const aborted = await workbench.control('bringup', 'abort');
		expect(aborted.exchange).toBeUndefined();
		expect(aborted.status).toBe('running');
		expect(aborted.exchanges).toContainEqual(
			expect.objectContaining({ status: 'closed', summary: { status: 'silent' } }),
		);
	});
});
