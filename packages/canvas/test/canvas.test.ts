import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AmbionError, createRuntime, readRoom, startRoom } from '@ambionframework/ambion';
import { scripted, settled } from '@ambionframework/ambion/testing';
import { sqliteJournals } from '@ambionframework/journal';
import { memoryBackend } from '@ambionframework/just-bash';
import { openWorkspace, type Workspace } from '@ambionframework/workspace';
import { describe, expect, it } from 'vitest';
import { type CanvasEvent, type CanvasRoom, openCanvas, sqliteCanvas } from '../src/index.ts';
import {
	ada,
	bob,
	breakoutRow,
	cy,
	helper,
	host,
	live,
	membersOf,
	statesOf,
} from './support/host.ts';
import { sqlOver } from './support/sql.ts';

const everyone = [ada, bob, cy, helper];

const refusal = (promise: Promise<unknown>) =>
	expect(promise).rejects.toMatchObject({ name: 'AmbionError', code: 'refused' });

const rootRow = (name: string, start: CanvasRoom['start'] = { kind: 'root' }): CanvasRoom => ({
	name,
	goal: `Goal of ${name}.`,
	depth: 0,
	state: 'running',
	start,
});

describe('resume', () => {
	it('starts a row that has no journal from its row, and gives each room its own definitions', async () => {
		const { canvas, store, storage } = host();
		await store.insert(rootRow('site'));
		await store.insert(rootRow('docs', { kind: 'root', agents: ['bob'] }));
		await store.insert(breakoutRow('site-a', 'site'));
		expect((await readRoom('site', { runtime: createRuntime({ storage }) })).initialized).toBe(
			false,
		);
		await canvas.resume({ agents: everyone });
		expect(await membersOf(live(canvas, 'site'))).toEqual({
			seated: ['ada', 'bob', 'cy', 'helper'],
			reserve: [],
		});
		expect(await membersOf(live(canvas, 'docs'))).toEqual({ seated: ['bob'], reserve: [] });
		const breakout = live(canvas, 'site-a');
		const read = await breakout.read({ messages: false });
		expect(read.participants).toMatchObject([{ name: 'cy', attention: 'broadcast' }]);
		expect(read.reserve).toEqual([]);
		expect(read.goal).toBe('Work for site-a.');
	});

	it('resumes a row that has a journal with the definitions of its row, and no other in the reserve', async () => {
		const first = host();
		await first.canvas.resume({ agents: everyone });
		await first.canvas.open({ name: 'site', goal: 'Plan.', agents: ['ada'] });
		await first.canvas.close();
		const second = host({ store: first.store, storage: first.storage });
		await second.canvas.resume({ agents: everyone });
		expect(await membersOf(live(second.canvas, 'site'))).toEqual({
			seated: ['ada'],
			reserve: [],
		});
		expect(second.errors).toEqual([]);
	});

	it('takes the definitions once, and refuses a name that two definitions hold', async () => {
		const { canvas } = host();
		await refusal(canvas.resume({ agents: [ada, ada] }));
		const again = host();
		await again.canvas.resume({ agents: everyone });
		await refusal(again.canvas.resume({ agents: everyone }));
	});

	it('starts a breakout room only under a live parent', async () => {
		const { canvas, store } = host();
		await store.insert(rootRow('site'));
		await store.setState('site', 'stopped');
		await store.insert(breakoutRow('site-a', 'site'));
		await canvas.resume({ agents: everyone });
		expect(canvas.rooms().map((row) => row.name)).toEqual(['site', 'site-a']);
		expect(canvas.room('site')).toBeUndefined();
		expect(canvas.room('site-a')).toBeUndefined();
	});

	it('leaves no later room running when close comes during resume, and reports no failure', async () => {
		const { canvas, store, runtime, errors } = host();
		await store.insert(rootRow('one'));
		await store.insert(rootRow('two'));
		canvas.subscribe((event) => {
			if (event.type === 'started' && event.room === 'one') void canvas.close();
		});
		await canvas.resume({ agents: everyone });
		await canvas.close();
		expect([canvas.room('one'), canvas.room('two')]).toEqual([undefined, undefined]);
		expect(errors).toEqual([]);
		for (const name of ['one', 'two'])
			await startRoom({ name, agents: [ada], runtime }).then((room) => room.stop());
		expect(await statesOf(store)).toEqual({ one: 'running', two: 'running' });
	});

	it('reports a failed start, and keeps the row running', async () => {
		const { canvas, store, errors } = host();
		await store.insert(rootRow('bad', { kind: 'root', assistant: 'ghost' }));
		await store.insert(rootRow('good'));
		await canvas.resume({ agents: everyone });
		expect(errors).toMatchObject([{ room: 'bad', operation: 'resume' }]);
		expect(canvas.room('bad')).toBeUndefined();
		expect(canvas.room('good')).toBeDefined();
		expect(await statesOf(store)).toEqual({ bad: 'running', good: 'running' });
	});
});

describe('open', () => {
	it('inserts a root row, starts it, and hears opened and started', async () => {
		const { canvas, store } = host();
		const events: CanvasEvent[] = [];
		canvas.subscribe((event) => void events.push(event));
		await canvas.resume({ agents: everyone });
		const room = await canvas.open({ name: 'site', goal: 'Plan.', agents: ['ada'] });
		expect(canvas.room('site')).toBe(room);
		expect(await store.list()).toEqual([
			{
				name: 'site',
				goal: 'Plan.',
				depth: 0,
				state: 'running',
				start: { kind: 'root', agents: ['ada'] },
			},
		]);
		expect(canvas.rooms()).toEqual(await store.list());
		expect(events.map((event) => event.type)).toEqual(['opened', 'started']);
		expect(events[0]).toMatchObject({ room: { name: 'site' } });
	});

	it('refuses before resume, a bad name, an unresolved name, and a breakout name', async () => {
		const { canvas, store } = host();
		await refusal(canvas.open({ name: 'site', goal: 'Plan.' }));
		await canvas.resume({ agents: everyone });
		await store.insert(breakoutRow('site-a', 'site'));
		const bad = [
			{ name: 'Bad Name' },
			{ name: 'one', agents: ['ghost'] },
			{ name: 'one', assistant: 'ghost' },
		];
		for (const options of bad) await refusal(canvas.open({ goal: 'Plan.', ...options }));
		await refusal(canvas.open({ name: 'site-a', goal: 'Plan.' }));
		expect((await store.list()).map((row) => row.name)).toEqual(['site-a']);
	});

	it('returns the handle of a root row, and ignores the other options', async () => {
		const { canvas, store } = host();
		await canvas.resume({ agents: everyone });
		const room = await canvas.open({ name: 'site', goal: 'Plan.', agents: ['ada'] });
		expect(await canvas.open({ name: 'site', goal: 'Other.', agents: ['bob'] })).toBe(room);
		await canvas.stop('site');
		const again = await canvas.open({ name: 'site', goal: 'Other.', agents: ['bob'] });
		expect(await membersOf(again)).toEqual({ seated: ['ada'], reserve: [] });
		expect((await store.list()).map((row) => [row.goal, row.state])).toEqual([
			['Plan.', 'running'],
		]);
	});

	it('resolves the assistant and the summary writer at each start', async () => {
		const first = host();
		await first.canvas.resume({ agents: everyone });
		const room = await first.canvas.open({
			name: 'site',
			goal: 'Plan.',
			agents: ['ada', 'helper'],
			assistant: 'helper',
			summaryWriter: 'helper',
		});
		expect((await membersOf(room)).seated).toEqual(['helper', 'ada']);
		await first.canvas.close();
		const small = { store: first.store, storage: first.storage };
		const second = host(small);
		await second.canvas.resume({ agents: [ada, helper] });
		expect(second.errors).toEqual([]);
		expect(second.canvas.room('site')).toBeDefined();
		const third = host(small);
		await third.canvas.resume({ agents: [ada] });
		expect(third.errors).toMatchObject([{ room: 'site', operation: 'resume' }]);
	});

	it('reports a start that fails, and keeps the row running', async () => {
		const { canvas, store, errors } = host();
		await canvas.resume({ agents: everyone });
		await expect(
			canvas.open({ name: 'site', goal: 'Plan.', seats: { zed: 'broadcast' } }),
		).rejects.toBeInstanceOf(AmbionError);
		expect(errors).toMatchObject([{ room: 'site', operation: 'open' }]);
		expect(await statesOf(store)).toEqual({ site: 'running' });
		expect(canvas.room('site')).toBeUndefined();
	});

	it('runs the calls on one room name one at a time', async () => {
		const { canvas, store } = host();
		await canvas.resume({ agents: everyone });
		const [first, second] = await Promise.all([
			canvas.open({ name: 'site', goal: 'Plan.' }),
			canvas.open({ name: 'site', goal: 'Plan.' }),
		]);
		expect(second).toBe(first);
		await Promise.all([canvas.stop('site'), canvas.start('site')]);
		expect(canvas.room('site')).toBeDefined();
		expect(await statesOf(store)).toEqual({ site: 'running' });
	});
});

describe('start and stop', () => {
	async function withBreakouts() {
		const context = host();
		await context.store.insert(rootRow('site'));
		await context.store.insert(breakoutRow('site-a', 'site'));
		await context.store.insert(breakoutRow('site-b', 'site'));
		await context.canvas.resume({ agents: everyone });
		return context;
	}

	it('stops a root with its breakout rooms, changes the root row alone, and starts both again', async () => {
		const { canvas, store, errors } = await withBreakouts();
		const events: CanvasEvent[] = [];
		canvas.subscribe((event) => void events.push(event));
		await canvas.stop('site');
		expect(await statesOf(store)).toEqual({
			site: 'stopped',
			'site-a': 'running',
			'site-b': 'running',
		});
		expect(canvas.room('site') ?? canvas.room('site-a') ?? canvas.room('site-b')).toBeUndefined();
		expect(events.map((event) => event.type)).toEqual(['stopped', 'stopped', 'stopped']);
		await refusal(canvas.start('site-a'));
		await canvas.start('site');
		expect(['site', 'site-a', 'site-b'].map((name) => canvas.room(name) !== undefined)).toEqual([
			true,
			true,
			true,
		]);
		expect(await statesOf(store)).toEqual({
			site: 'running',
			'site-a': 'running',
			'site-b': 'running',
		});
		expect(errors).toEqual([]);
	});

	it('stops and starts one breakout room under a live parent', async () => {
		const { canvas, store } = await withBreakouts();
		await canvas.stop('site-a');
		expect(await statesOf(store)).toMatchObject({ site: 'running', 'site-a': 'stopped' });
		expect(canvas.room('site')).toBeDefined();
		expect(canvas.room('site-a')).toBeUndefined();
		await canvas.start('site-a');
		expect(canvas.room('site-a')).toBeDefined();
		expect(await statesOf(store)).toMatchObject({ 'site-a': 'running' });
	});

	it('refuses an unknown room', async () => {
		const { canvas } = await withBreakouts();
		await refusal(canvas.start('ghost'));
		await refusal(canvas.stop('ghost'));
	});

	it('keeps each row running at close, and records stopped at stop', async () => {
		const first = host();
		await first.canvas.resume({ agents: everyone });
		await first.canvas.open({ name: 'site', goal: 'Plan.' });
		await first.canvas.open({ name: 'docs', goal: 'Write.' });
		await first.canvas.stop('docs');
		await first.canvas.close();
		expect(await statesOf(first.store)).toEqual({ site: 'running', docs: 'stopped' });
		expect(first.canvas.room('site')).toBeUndefined();
		await refusal(first.canvas.open({ name: 'more', goal: 'More.' }));
		await refusal(first.canvas.start('docs'));
		await refusal(first.canvas.stop('site'));
		await first.canvas.close();
		const second = host({ store: first.store, storage: first.storage });
		await second.canvas.resume({ agents: everyone });
		expect(second.canvas.room('site')).toBeDefined();
		expect(second.canvas.room('docs')).toBeUndefined();
	});
});

describe('archive', () => {
	it('records the close, stops the room, and returns the recorded close again', async () => {
		const { canvas, store } = host();
		await store.insert(rootRow('site'));
		await store.insert(breakoutRow('site-a', 'site'));
		await canvas.resume({ agents: everyone });
		const events: CanvasEvent[] = [];
		canvas.subscribe((event) => void events.push(event));
		await refusal(canvas.archive('site', { result: 'done' }));
		const close = { result: 'failed', note: 'Out of scope.' } as const;
		expect(await canvas.archive('site-a', close)).toEqual(close);
		expect(await canvas.archive('site-a', { result: 'done' })).toEqual(close);
		expect(canvas.room('site-a')).toBeUndefined();
		expect(canvas.rooms().find((row) => row.name === 'site-a')).toMatchObject({
			state: 'archived',
			close,
		});
		expect(events).toEqual([
			{ type: 'stopped', room: 'site-a' },
			{ type: 'archived', room: 'site-a', close },
		]);
		await refusal(canvas.start('site-a'));
		await canvas.stop('site');
		await canvas.start('site');
		expect(canvas.room('site-a')).toBeUndefined();
	});

	it('records the close of a stopped row, and stops nothing', async () => {
		const { canvas, store } = host();
		await store.insert(rootRow('site'));
		await store.insert(breakoutRow('site-a', 'site'));
		await canvas.resume({ agents: everyone });
		await canvas.stop('site-a');
		await canvas.archive('site-a', { result: 'done' });
		expect(await statesOf(store)).toMatchObject({ 'site-a': 'archived' });
		await refusal(canvas.stop('site-a'));
	});
});

describe('the mirror', () => {
	const workspace = () =>
		openWorkspace({ name: 'lab', backend: { bash: memoryBackend() }, rooms: true });

	it('attaches after each start, and stops the room before its mirror', async () => {
		const drive = workspace();
		const order: string[] = [];
		const watched: Workspace = {
			...drive,
			mirror: async (room, options) => {
				const mirror = await drive.mirror(room, options);
				order.push(`attach ${room.name}`);
				return {
					...mirror,
					stop: async () => {
						const outcome = await room.post({ text: 'late' }).then(
							() => 'room running',
							(error: unknown) => (error instanceof AmbionError ? error.code : 'other'),
						);
						order.push(`mirror stop sees ${outcome}`);
						await mirror.stop();
					},
				};
			},
		};
		const { canvas, errors } = host({ workspace: watched });
		await canvas.resume({ agents: everyone });
		await canvas.open({ name: 'site', goal: 'Plan.' });
		await canvas.stop('site');
		expect(order).toEqual(['attach site', 'mirror stop sees room_stopped']);
		await canvas.start('site');
		expect(order.at(-1)).toBe('attach site');
		expect(errors).toEqual([]);
	});

	it('reports a failed mirror stop, and the stop reaches the caller', async () => {
		const drive = workspace();
		const broken: Workspace = {
			...drive,
			mirror: async (room, options) => ({
				...(await drive.mirror(room, options)),
				stop: () => Promise.reject(new Error('no stop')),
			}),
		};
		const { canvas, errors } = host({ workspace: broken });
		await canvas.resume({ agents: everyone });
		await canvas.open({ name: 'site', goal: 'Plan.' });
		await canvas.stop('site');
		expect(errors).toMatchObject([{ room: 'site', operation: 'mirror' }]);
		expect(canvas.room('site')).toBeUndefined();
	});

	it('reports a failed attach, and the room runs', async () => {
		const failing: Workspace = {
			...workspace(),
			mirror: () => Promise.reject(new Error('no mirror')),
		};
		const { canvas, errors } = host({ workspace: failing });
		await canvas.resume({ agents: everyone });
		const room = await canvas.open({ name: 'site', goal: 'Plan.' });
		expect(errors).toMatchObject([{ room: 'site', operation: 'mirror' }]);
		expect(canvas.room('site')).toBe(room);
		await room.post({ text: 'Hello.' });
		await settled(room);
	});
});

describe('on SQLite', () => {
	it('resumes the rooms of a closed host from the same database', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'canvas-host-'));
		try {
			const file = join(dir, 'host.db');
			const run = async () => {
				const database = new DatabaseSync(file);
				const sql = sqlOver(database);
				const runtime = createRuntime({
					storage: sqliteJournals(sql),
					execution: scripted(() => []),
				});
				const canvas = openCanvas({
					name: 'lab',
					runtime,
					store: sqliteCanvas(sql),
				});
				await canvas.resume({ agents: everyone });
				return { canvas, database };
			};
			const first = await run();
			const room = await first.canvas.open({ name: 'site', goal: 'Plan.', agents: ['ada'] });
			await (await room.visit({ name: 'pat', identity: 'Pat.' })).send({ text: 'Hello.' });
			await settled(room);
			await first.canvas.close();
			first.database.close();
			const second = await run();
			const resumed = live(second.canvas, 'site');
			expect(await membersOf(resumed)).toEqual({ seated: ['ada'], reserve: [] });
			expect((await resumed.read()).messages.length).toBeGreaterThan(0);
			expect(second.canvas.rooms()).toMatchObject([{ name: 'site', state: 'running' }]);
			await second.canvas.close();
			second.database.close();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
