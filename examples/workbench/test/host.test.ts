import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join as joinPath } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { byAgent, callTool, quiet, say } from '@ambionframework/ambion/testing';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { scenarios } from '../src/scenarios.ts';
import type { Workbench } from '../src/workbench.ts';
import {
	freshDirectory,
	idleStream,
	openHost,
	respondingStream,
	scriptedKinds,
} from './hosting.ts';

const PLAN = 'LED plan: 330 ohm series resistor at 10 mA.\n';

function scriptedResponse(agent: string, request: number, closing: boolean) {
	if (closing)
		return fauxAssistantMessage([fauxToolCall('say', { text: 'Summary: the bench answered.' })], {
			stopReason: 'toolUse',
		});
	if (agent === 'assistant' && request === 1)
		return fauxAssistantMessage(
			[fauxToolCall('say', { to: 'design', text: 'Please choose the resistor.' })],
			{ stopReason: 'toolUse' },
		);
	if (agent === 'assistant' && request === 2)
		return fauxAssistantMessage([fauxToolCall('read', { path: '/library/led-5mm.md' })], {
			stopReason: 'toolUse',
		});
	if (agent === 'assistant' && request === 3)
		return fauxAssistantMessage(
			[fauxToolCall('say', { to: 'design', text: 'Thanks, that is clear.' })],
			{ stopReason: 'toolUse' },
		);
	return fauxAssistantMessage('quiet', { stopReason: 'stop' });
}

/** The design seat runs on the Claude executor. A script drives it, with no key. */
const designScript = byAgent({
	design: (_step, _seat, request) => {
		if (request === 1) return callTool('write', { path: 'shared/plan.md', content: PLAN });
		if (request === 2) return say('Resistor chosen.', 'assistant');
		return quiet();
	},
});

/** A host whose assistant asks the design seat, which writes a plan, then a summary closes the exchange. */
const open = (directory?: string) =>
	openHost({
		directory,
		stream: respondingStream(scriptedResponse),
		executions: scriptedKinds(designScript),
	});

async function messagesOf(workbench: Workbench, room: string) {
	return (await workbench.read(room, 0)).messages;
}

/**
 * The exchange runs several activations over real SQLite and directory
 * I/O. Alone it takes about 300 ms. A loaded runner takes it past 1 s, so
 * the wait allows 5 s and returns as soon as the summary lands.
 */
async function untilSummary(workbench: Workbench, room: string) {
	await vi.waitFor(
		async () =>
			expect((await messagesOf(workbench, room)).some((m) => m.kind === 'summary')).toBe(true),
		{ timeout: 5_000, interval: 10 },
	);
}

async function readsTrace(workbench: Workbench) {
	const view = await workbench.read('bringup', 0);
	const id = view.exchanges.flatMap((exchange) => exchange.activations)[0]?.id ?? '';
	const read = await workbench.activation('bringup', id);
	expect(read?.activation).toBe(id);
	expect(read?.passes.length).toBeGreaterThan(0);
	const types = (read?.passes ?? []).flatMap((pass) => pass.steps).map((step) => step.type);
	expect(types).toContain('tool_call');
	expect(types.at(-1)).toBe('end');
	expect(await workbench.activation('bringup', 'not-an-id')).toBeUndefined();
	await expect(workbench.activation('nowhere', id)).rejects.toThrow(/Unknown room/);
}

describe('Workbench host', () => {
	it('runs an exchange to a summary, keeps it across a stop and a restart, and does not seed again', async () => {
		const directory = await freshDirectory();
		let workbench = await open(directory);
		expect(workbench.people.map((person) => person.name)).toEqual(['mira', 'theo', 'sol']);
		expect((await workbench.rooms()).map((room) => [room.name, room.status])).toEqual([
			['bringup', 'running'],
			['sensing', 'running'],
			['power', 'running'],
			['firmware', 'running'],
		]);
		await workbench.visit('bringup', 'mira');
		await workbench.send('bringup', 'mira', 'summary-1', 'Pick the LED resistor.');
		await untilSummary(workbench, 'bringup');
		const plan = '/home/design/shared/plan.md';
		expect((await workbench.file(plan)).text).toBe(PLAN);
		await readsTrace(workbench);

		const before = await messagesOf(workbench, 'bringup');
		expect((await workbench.control('bringup', 'stop')).status).toBe('stopped');
		const history = await messagesOf(workbench, 'bringup');
		expect(history).toEqual(expect.arrayContaining(before as unknown[]));
		expect(history.some((message) => message.kind === 'left')).toBe(true);
		await workbench.close();

		workbench = await open(directory);
		expect((await workbench.rooms()).map((room) => [room.name, room.status])).toEqual([
			['bringup', 'stopped'],
			['sensing', 'running'],
			['power', 'running'],
			['firmware', 'running'],
		]);
		expect((await workbench.file(plan)).text).toBe(PLAN);
		expect((await workbench.control('bringup', 'resume')).status).toBe('running');
	}, 20_000);

	it('opens each scenario with its seats and its assistant, and records its row on the canvas', async () => {
		const directory = await freshDirectory();
		const workbench = await open(directory);
		for (const scenario of scenarios) {
			const view = await workbench.read(scenario.name, 0);
			const seated = view.participants.filter((seat) => seat.kind === 'agent');
			expect(seated.map((seat) => seat.name)).toEqual(
				expect.arrayContaining(Object.keys(scenario.seats)),
			);
			expect(view).toMatchObject({ goal: scenario.goal, pattern: scenario.pattern });
		}
		const created = await workbench.create('motors', 'Drive a small motor.');
		expect(created.participants.map((seat) => seat.name)).toEqual(
			expect.arrayContaining(['assistant', 'design']),
		);
		const database = new DatabaseSync(joinPath(directory, 'rooms.db'));
		onTestFinished(() => database.close());
		const rows = database
			.prepare('SELECT name, depth, state, start FROM canvas_rooms ORDER BY position')
			.all() as { name: string; depth: number; state: string; start: string }[];
		expect(rows.map((row) => [row.name, row.depth, row.state])).toEqual([
			...scenarios.map((scenario) => [scenario.name, 0, 'running']),
			['motors', 0, 'running'],
		]);
		expect(JSON.parse(rows[0]?.start ?? '{}')).toMatchObject({
			kind: 'root',
			assistant: 'assistant',
			seats: scenarios[0]?.seats,
		});
	});

	it('creates a room, and refuses a duplicate and a bad name or goal', async () => {
		const workbench = await openHost();
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
			['a'.repeat(49), 'x'],
			['motors\n', 'x'],
			['empty-goal', '   '],
			['long-goal', 'x'.repeat(2_001)],
		] as const)
			await expect(workbench.create(name, goal)).rejects.toThrow(/room name|room goal/);
		expect((await workbench.rooms()).map((room) => room.name)).toContain('motors');
	});

	it('requires presence to send, attributes deliveries, retries by key, and keeps rooms independent', async () => {
		const workbench = await open();
		const before = await messagesOf(workbench, 'bringup');
		await workbench.leave('bringup', 'sol');
		expect(await messagesOf(workbench, 'bringup')).toEqual(before);
		await expect(workbench.visit('bringup', 'nobody')).rejects.toThrow(/Unknown person/);
		await expect(workbench.visit('nowhere', 'mira')).rejects.toThrow(/Unknown room/);
		await expect(workbench.send('bringup', 'mira', 'k0', 'Hello?')).rejects.toThrow(
			/Enter this room/,
		);

		await workbench.visit('bringup', 'mira');
		await workbench.visit('sensing', 'theo');
		await workbench.send('bringup', 'mira', 'k1', 'Which resistor?');
		await workbench.send('bringup', 'mira', 'k1', 'Which resistor?');
		await workbench.send('sensing', 'theo', 'k2', 'Which pins?');
		await workbench.leave('bringup', 'mira');
		await expect(workbench.send('bringup', 'mira', 'k1', 'Which resistor?')).rejects.toThrow(
			/Enter this room/,
		);
		await workbench.visit('bringup', 'mira');
		await workbench.send('bringup', 'mira', 'k1', 'Which resistor?');

		const bringup = await messagesOf(workbench, 'bringup');
		const sensing = await messagesOf(workbench, 'sensing');
		expect(bringup.filter((message) => 'key' in message && message.key === 'k1')).toHaveLength(1);
		expect(bringup.filter((message) => message.kind === 'arrived')).toHaveLength(2);
		expect(bringup).toEqual(
			expect.arrayContaining([expect.objectContaining({ from: 'mira', text: 'Which resistor?' })]),
		);
		expect(sensing).toEqual(
			expect.arrayContaining([expect.objectContaining({ from: 'theo', text: 'Which pins?' })]),
		);
		expect(bringup.some((message) => 'from' in message && message.from === 'theo')).toBe(false);
		expect(sensing.some((message) => 'from' in message && message.from === 'mira')).toBe(false);
	});

	it('tells the person when a room mirror does not attach, and keeps the room running', async () => {
		const directory = await freshDirectory();
		// A file where the mirror needs the rooms directory makes the attach fail.
		await mkdir(joinPath(directory, 'workspace'), { recursive: true });
		await writeFile(joinPath(directory, 'workspace/rooms'), 'not a directory');
		const workbench = await open(directory);

		const view = await workbench.read('bringup', 0);
		expect(view.status).toBe('running');
		expect(view.activity.map((item) => [item.type, item.text])).toContainEqual([
			'error',
			expect.stringContaining('The room mirror failed'),
		]);
	});

	it('lists the seeded library, previews a SQLite file, hides shell devices, and refuses unsafe paths', async () => {
		const directory = await freshDirectory();
		const workbench = await openHost({ directory });
		const root = joinPath(directory, 'workspace');
		await writeFile(joinPath(root, 'plain.txt'), 'safe');
		await mkdir(joinPath(root, 'dev'), { recursive: true });
		await writeFile(joinPath(root, 'dev/null'), '');
		await symlink('/etc/hosts', joinPath(root, 'escape.txt'));
		const database = new DatabaseSync(joinPath(root, 'shared/data.db'));
		database.exec(
			'CREATE TABLE readings (id INTEGER PRIMARY KEY, note TEXT); INSERT INTO readings (note) VALUES (\'near\'), (NULL); CREATE TABLE "odd name" (a);',
		);
		database.close();
		await writeFile(joinPath(root, 'shared/fake.db'), 'not a database');

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

	it('previews a lab table by its lab URI, and lists a requested operation until an answer names it', async () => {
		const directory = await freshDirectory();
		const workbench = await openHost({ directory });
		expect(await workbench.labTables()).toEqual(
			expect.arrayContaining(['projects', 'runs', 'results', 'operations']),
		);
		const preview = await workbench.labTable('lab:///projects');
		expect(preview.path).toBe('lab:///projects');
		expect(preview.tables?.map((table) => table.name)).toEqual(['projects']);
		expect(preview.text).toContain('# projects');
		await expect(workbench.labTable('lab:///nothing')).rejects.toThrow(/No such lab table/);
		await expect(workbench.labTable('/etc/hosts')).rejects.toThrow(/Use lab:/);
		await expect(workbench.labTable('lab:///sqlite_master')).rejects.toThrow(/No such lab table/);

		expect(await workbench.approvals('bringup')).toEqual([]);
		const lab = new DatabaseSync(joinPath(directory, 'lab.db'));
		const insert = lab.prepare(
			'INSERT INTO operations (instrument, setpoint, outcome, request_id, room, exchange_person, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
		);
		insert.run('led-current', 30, 'requested', null, 'bringup', 'mira', '2026-01-01T00:00:00Z');
		insert.run('bench-supply', 9, 'requested', null, 'sensing', 'theo', '2026-01-01T00:00:01Z');
		expect(await workbench.approvals('bringup')).toEqual([
			{
				id: 1,
				instrument: 'led-current',
				setpoint: 30,
				unit: 'mA',
				person: 'mira',
				at: '2026-01-01T00:00:00Z',
			},
		]);
		expect((await workbench.approvals('sensing')).map((approval) => approval.person)).toEqual([
			'theo',
		]);
		insert.run('led-current', 30, 'approved', 1, 'bringup', 'mira', '2026-01-01T00:00:02Z');
		lab.close();
		expect(await workbench.approvals('bringup')).toEqual([]);
		await expect(workbench.approvals('nowhere')).rejects.toThrow(/Unknown room/);
	});

	it('cancels an open exchange and keeps the room available', async () => {
		const workbench = await openHost({ stream: idleStream });
		await workbench.visit('bringup', 'mira');
		await workbench.send('bringup', 'mira', 'pending-1', 'Wait for work.');
		expect((await workbench.read('bringup', 0)).exchange).toBeDefined();
		const cancelled = await workbench.control('bringup', 'cancel');
		expect(cancelled.exchange).toBeUndefined();
		expect(cancelled.status).toBe('running');
		expect(cancelled.exchanges).toContainEqual(
			expect.objectContaining({ status: 'closed', summary: { kind: 'silent' } }),
		);
	});

	it('lists a say that waits to return, and dismisses it once', async () => {
		const workbench = await openHost({
			stream: respondingStream((agent, request, closing) => {
				if (closing || agent !== 'assistant' || request !== 1)
					return fauxAssistantMessage('quiet', { stopReason: 'stop' });
				const later = { text: 'Check the bench supply.', delaySeconds: 600 };
				return fauxAssistantMessage([fauxToolCall('schedule', later)], { stopReason: 'toolUse' });
			}),
		});
		await workbench.visit('bringup', 'mira');
		await workbench.send('bringup', 'mira', 'later-1', 'Check the supply later.');
		const waiting = await vi.waitFor(async () => {
			const [say] = (await workbench.read('bringup', 0)).scheduled;
			if (!say) throw new Error('No say waits yet.');
			return say;
		});
		expect(waiting).toMatchObject({ seat: 'assistant' });
		expect(await workbench.dismiss('bringup', waiting.seq)).toBe(true);
		expect(await workbench.dismiss('bringup', waiting.seq)).toBe(false);
		expect((await workbench.read('bringup', 0)).scheduled).toEqual([]);
		expect((await messagesOf(workbench, 'bringup')).at(-1)).toMatchObject({
			kind: 'dismissed',
			message: waiting.seq,
		});
	});

	it('tells the watchers of one room when it records something, until each watch ends, across a stop and a resume', async () => {
		const workbench = await openHost();
		const counts = { ended: 0, bringup: 0, sensing: 0 };
		const end = workbench.watch('bringup', () => {
			counts.ended += 1;
		});
		workbench.watch('bringup', () => {
			counts.bringup += 1;
		});
		workbench.watch('sensing', () => {
			counts.sensing += 1;
		});
		expect(() => workbench.watch('nowhere', () => {})).toThrow(/Unknown room/);
		await workbench.visit('sensing', 'theo');
		await vi.waitFor(() => expect(counts.sensing).toBeGreaterThan(0));
		expect(counts.bringup).toBe(0);

		await workbench.visit('bringup', 'mira');
		await vi.waitFor(() => expect(counts.ended).toBeGreaterThan(0));
		end();
		const ended = counts.ended;
		await workbench.control('bringup', 'stop');
		await workbench.control('bringup', 'resume');
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
		const settled = counts.bringup;
		await workbench.visit('bringup', 'mira');
		await vi.waitFor(() => expect(counts.bringup).toBeGreaterThan(settled));
		expect(counts.ended).toBe(ended);
	}, 20_000);

	it('lists the processes that an agent starts with bash, reads an output, and cancels a running one', async () => {
		// The assistant starts a short process that ends in its window, then a long one that it leaves running.
		const stream = respondingStream((agent, request, closing) => {
			const start = (command: string, name: string, wait: number) =>
				fauxAssistantMessage([fauxToolCall('bash', { command, name, wait })], {
					stopReason: 'toolUse',
				});
			if (agent !== 'assistant' || closing) return fauxAssistantMessage('quiet');
			if (request === 1) return start('echo hello from the bench', 'greet', 5);
			if (request === 2) return start('sleep 60', 'soak', 0);
			return fauxAssistantMessage('quiet');
		});
		const workbench = await openHost({ stream });
		let events = 0;
		const end = workbench.watchProcesses(() => {
			events += 1;
		});
		expect(await workbench.processes()).toEqual([]);
		await workbench.visit('bringup', 'mira');
		await workbench.send('bringup', 'mira', 'ps-1', 'Start the soak.');
		await vi.waitFor(async () => expect(await workbench.processes()).toHaveLength(2), {
			timeout: 5_000,
		});
		// The running process comes first, then the newest start.
		const [soak, greet] = await workbench.processes();
		expect(soak).toMatchObject({ name: 'soak', agent: 'assistant', state: 'running' });
		expect(greet).toMatchObject({ name: 'greet', state: 'exited', exitCode: 0 });
		expect(await workbench.processOutput(greet?.handle ?? '', 'assistant')).toEqual({
			handle: greet?.handle,
			text: 'hello from the bench\n',
			size: 21,
			truncated: false,
		});
		await expect(workbench.processOutput('bash-000000000000', 'assistant')).rejects.toThrow(
			/No process/,
		);

		const cancelled = await workbench.cancelProcess(soak?.handle ?? '');
		expect(cancelled.state).toBe('cancelled');
		expect((await workbench.processes()).map((process) => process.state)).toEqual([
			'cancelled',
			'exited',
		]);
		// One start and one end for each process.
		await vi.waitFor(() => expect(events).toBe(4));
		end();
	}, 20_000);
});
