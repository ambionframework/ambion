import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { scenarios } from '../src/scenarios.ts';
import { Session } from '../src/session.ts';
import type { ActivationRead, OpenOptions, Workbench } from '../src/workbench.ts';
import { started, view } from './fake-host.ts';
import { freshDirectory, idleStream, openHost } from './hosting.ts';

const LOGGED = new Set<string | symbol>(['join', 'leave', 'send', 'control', 'create']);

/**
 * A session on a real host on scripted models. The host records each call the
 * session makes to change a room, and then runs it.
 */
async function onHost(name: string | null = 'mira', options: Partial<OpenOptions> = {}) {
	const workbench = await openHost(options);
	const calls: string[] = [];
	const host = new Proxy(workbench, {
		get(target, key) {
			const value = Reflect.get(target, key);
			if (typeof value !== 'function' || !LOGGED.has(key)) return value;
			return (...args: unknown[]) => {
				calls.push([String(key), ...args.slice(0, 2)].join(':'));
				return value.apply(target, args);
			};
		},
	});
	let changes = 0;
	const identity = workbench.people.find((person) => person.name === name);
	const session = new Session(host, identity, () => {
		changes += 1;
	});
	await session.start();
	// A watch may read the room while `start` returns, so the first read can land later.
	if (identity) await vi.waitFor(() => expect(session.view).toBeDefined());
	return { workbench, session, calls, changes: () => changes };
}

/** The arrivals, departures, and messages of the people in a room, in journal order. */
async function trail(workbench: Workbench, room: string): Promise<string[]> {
	return (await workbench.read(room, 0)).messages.flatMap((message) => {
		if (message.kind === 'arrived' || message.kind === 'left')
			return [`${message.kind}:${message.subject}`];
		return message.kind === 'said' ? [`said:${message.from}:${message.text}`] : [];
	});
}

describe('Session on the real host', () => {
	it('asks who the person is, then enters the first room, and switches person and room', async () => {
		const { workbench, session, calls, changes } = await onHost(null);
		expect(session.identity).toBeUndefined();
		expect(session.room).toBe('');
		expect(session.notice).toMatch(/Who are you.*mira, theo, sol/);
		expect(changes()).toBeGreaterThan(0);
		await session.submit('Hello?');
		expect(session.notice).toMatch(/Pick a person first/);
		expect(calls).toEqual([]);

		await session.submit('/user theo');
		expect(session.identity?.name).toBe('theo');
		expect(session.notice).toBe('You are theo, firmware engineer.');
		await session.submit('/user mira');
		expect(session.room).toBe('bringup');
		expect(session.entered).toBe(true);
		expect(await trail(workbench, 'bringup')).toEqual([
			'arrived:theo',
			'left:theo',
			'arrived:mira',
		]);

		calls.length = 0;
		await session.submit('/user');
		expect(session.notice).toMatch(/Pick a person: mira, theo, sol/);
		await session.submit('/user nobody');
		expect(session.notice).toMatch(/No person named nobody/);
		await session.submit('/user mira');
		expect(session.notice).toBe('You are already mira.');
		await session.submit('/room nowhere');
		expect(session.notice).toMatch(/No room named nowhere/);
		expect(calls).toEqual([]);

		await session.submit('/room power');
		expect(calls).toEqual(['leave:bringup:mira', 'join:power:mira']);
		expect(session.room).toBe('power');
		await workbench.join('power', 'theo');
		await vi.waitFor(() =>
			expect(session.view?.participants).toContainEqual(
				expect.objectContaining({ name: 'theo', presence: 'present' }),
			),
		);
	});

	it('creates a room with its goal, or asks for the goal, and refuses a bad or taken name', async () => {
		const { workbench, session, calls } = await onHost();
		const goals = async () =>
			Object.fromEntries((await workbench.rooms()).map((room) => [room.name, room.goal]));
		await session.submit('/new motors Drive a small motor');
		expect(session.room).toBe('motors');
		expect(session.notice).toBe('Created motors.');

		await session.submit('/new pumps');
		expect(session.awaitingGoal).toBe('pumps');
		expect(session.waiting).toBe('Goal for pumps');
		expect(await goals()).not.toHaveProperty('pumps');
		await session.submit('Move water');
		expect(session.awaitingGoal).toBeUndefined();
		expect(session.room).toBe('pumps');

		await session.submit('/new fans');
		session.cancelWaiting();
		expect(session.awaitingGoal).toBeUndefined();
		expect(session.notice).toMatch(/Canceled/);
		await session.submit('/new Bad_Name');
		expect(session.notice).toMatch(/lowercase room name/);
		await session.submit('/new bringup');
		expect(session.notice).toBe('bringup already exists.');
		await session.submit('/new');
		expect(session.notice).toMatch(/Name the room/);
		expect(calls.filter((call) => call.startsWith('create'))).toEqual([
			'create:motors:Drive a small motor',
			'create:pumps:Move water',
		]);
		expect(await goals()).toMatchObject({ motors: 'Drive a small motor', pumps: 'Move water' });

		await session.submit('/new valves');
		await workbench.create('valves', 'Taken first.');
		await session.submit('Control the flow');
		expect(session.error).toMatch(/already exists/);
		expect(session.awaitingGoal).toBeUndefined();
	});

	it('sends as the person, enters first when not present, aborts, stops, resumes, and leaves', async () => {
		const { workbench, session, calls } = await onHost('mira', { stream: idleStream });
		await session.submit('/abort');
		expect(session.notice).toBe('Nothing to abort. bringup has no open exchange.');
		await session.submit('Which resistor?');
		await vi.waitFor(() => expect(session.view?.exchange).toBeDefined());
		await session.submit('/abort');
		expect(calls).toContain('control:bringup:abort');
		expect(session.notice).toBe('Aborted the open exchange in bringup.');

		await workbench.leave('bringup', 'mira');
		await session.submit('Are you there?');
		expect(session.error).toBe('Enter this room before sending.');
		session.entered = false;
		calls.length = 0;
		await session.submit('Are you there?');
		expect(calls).toEqual(['join:bringup:mira', 'send:bringup:mira']);
		expect((await trail(workbench, 'bringup')).slice(-2)).toEqual([
			'arrived:mira',
			'said:mira:Are you there?',
		]);

		await session.submit('/stop');
		expect(session.entered).toBe(false);
		await vi.waitFor(() => expect(session.view?.status).toBe('stopped'));
		await session.submit('/stop');
		expect(session.notice).toBe('bringup is already stopped.');
		calls.length = 0;
		await session.submit('Anybody?');
		expect(session.error).toBe('bringup is stopped. Use /resume first.');
		expect(calls).toEqual([]);
		await session.submit('/resume');
		expect(calls).toEqual(['control:bringup:resume', 'join:bringup:mira']);
		expect(session.entered).toBe(true);
		await vi.waitFor(() => expect(session.view?.status).toBe('running'));

		calls.length = 0;
		await session.leave();
		session.entered = false;
		await session.leave();
		expect(calls).toEqual(['leave:bringup:mira']);
		expect((await trail(workbench, 'bringup')).at(-1)).toBe('left:mira');
	});

	it('attaches a local file, cites it on the next message, and drops a staged one on a room switch', async () => {
		const { workbench, session } = await onHost();
		const directory = await freshDirectory();
		const local = join(directory, 'board.png');
		await writeFile(local, 'picture');
		await session.submit('/attach');
		expect(session.notice).toMatch(/Use \/attach/);
		await session.submit(`/attach ${join(directory, 'missing.png')}`);
		expect(session.error).toMatch(/Cannot read .*missing\.png: ENOENT/);
		expect(session.pendingRefs).toEqual([]);

		await session.submit(`/attach ${local}`);
		const [staged] = session.pendingRefs;
		expect(staged?.path).toMatch(/^\/attachments\/\d+-board\.png$/);
		expect(staged?.ref).toBe(`file://${staged?.path}`);
		expect(session.notice).toContain(`Attached ${staged?.path}`);
		await session.submit('Look at this.');
		const sent = (await workbench.read('bringup', 0)).messages.find(
			(message) => message.kind === 'said' && message.text === 'Look at this.',
		);
		expect(sent).toMatchObject({ refs: [staged?.ref] });
		expect(session.pendingRefs).toEqual([]);

		await session.submit(`/attach ${local}`);
		expect(session.pendingRefs).toHaveLength(1);
		await session.switchRoom('power');
		expect(session.pendingRefs).toEqual([]);
	});

	it('opens and narrows the files panel, opens a file by a part of its path, and returns intents', async () => {
		const { workbench, session } = await onHost();
		expect(await session.submit('/files')).toEqual({ type: 'files' });
		const [first, second] = session.browser.matches.map((file) => file.path);
		await vi.waitFor(() => expect(session.browser.file?.path).toBe(first));
		expect(session.browser.open).toBe(true);
		expect(session.browser.file?.text).toBe((await workbench.file(first ?? '')).text);
		session.browser.type('NOTES');
		expect(session.browser.matches.map((file) => file.path)).toEqual(['/shared/notes.md']);
		await vi.waitFor(() => expect(session.browser.file?.path).toBe('/shared/notes.md'));
		session.browser.clear();
		await vi.waitFor(() => expect(session.browser.file?.path).toBe(first));
		session.browser.move(1);
		await vi.waitFor(() => expect(session.browser.file?.path).toBe(second));
		session.browser.type('nothing');
		expect(session.browser.selected).toBeUndefined();
		await vi.waitFor(() => expect(session.browser.file).toBeUndefined());

		for (const argument of ['/library/led-5mm.md', 'library/led-5mm.md', 'led-5']) {
			expect(await session.submit(`/open ${argument}`)).toEqual({ type: 'files' });
			expect(session.browser.selected?.path).toBe('/library/led-5mm.md');
		}
		expect(await session.submit('/open nothing')).toBeUndefined();
		expect(session.notice).toMatch(/No file matches nothing/);
		expect(await session.submit('/open')).toEqual({ type: 'files' });
		expect(await session.submit('/try')).toEqual({ type: 'compose', text: scenarios[0]?.prompt });
		expect(await session.submit('/quit')).toEqual({ type: 'quit' });
		await session.submit('/nope');
		expect(session.notice).toMatch(/Unknown command \/nope/);
	});
});

describe('Session /attach while other work runs', () => {
	it('stages a copy that lands after a room switch into the array the session holds by then, not a stale one', async () => {
		const { host, session } = await started();
		const gate = Promise.withResolvers<void>();
		host.attachGate = gate.promise;
		const attaching = session.submit('/attach board.png');
		await vi.waitFor(() => expect(host.calls).toContain('attach:board.png'));
		await session.switchRoom('power');
		const freshArray = session.pendingRefs;
		gate.resolve();
		await attaching;
		expect(session.pendingRefs).toBe(freshArray);
		expect(session.pendingRefs).toEqual([
			{ path: '/attachments/board.png', ref: 'file:///attachments/board.png' },
		]);
	});

	it('keeps an attach that lands while a send is in flight, for the next message', async () => {
		const { host, session } = await started();
		await session.submit('/attach board.png');
		const gate = Promise.withResolvers<void>();
		host.sendGate = gate.promise;
		const sending = session.submit('Look at this.');
		await vi.waitFor(() => expect(host.calls).toContain('send:bringup:mira:Look at this.'));
		await session.submit('/attach sensor.png');
		gate.resolve();
		await sending;

		expect(host.sentRefs).toEqual([['file:///attachments/board.png']]);
		expect(session.pendingRefs).toEqual([
			{ path: '/attachments/sensor.png', ref: 'file:///attachments/sensor.png' },
		]);
	});
});

describe('Session push updates', () => {
	it('watches only the open room, moves the watch with the room, and ends it on leave', async () => {
		const { host, session } = await started();
		expect(host.listeners('bringup')).toBe(1);
		await session.submit('/room power');
		expect(host.listeners('bringup')).toBe(0);
		expect(host.listeners('power')).toBe(1);
		await session.leave();
		expect(host.listeners('power')).toBe(0);
	});

	it('reads once more, not once per change, when changes land during a read', async () => {
		const { host, session } = await started();
		const gate = Promise.withResolvers<void>();
		host.gate = gate.promise;
		const before = host.readCount;
		for (let change = 0; change < 5; change += 1) host.notify('bringup');
		host.gate = undefined;
		gate.resolve();
		await vi.waitFor(() => expect(host.readCount).toBe(before + 2));
		await new Promise<void>((resolve) => setTimeout(resolve, 30));
		expect(host.readCount).toBe(before + 2);
		expect(session.offline).toBeUndefined();
	});

	it('reads a stopped room on the slow poll, and leaves a running room to the watch', async () => {
		const { host, session } = await started();
		const running = host.readCount;
		await session.poll();
		expect(host.readCount).toBe(running);
		host.table.set('bringup', view('bringup', { status: 'stopped' }));
		await session.refresh();
		const stopped = host.readCount;
		await session.poll();
		expect(host.readCount).toBeGreaterThan(stopped);
	});

	it('reports a failed read from a change, and recovers on the next one', async () => {
		const { host, session } = await started();
		host.table.delete('bringup');
		host.notify('bringup');
		await vi.waitFor(() => expect(session.offline).toMatch(/No room bringup/));
		host.table.set('bringup', view('bringup'));
		host.notify('bringup');
		await vi.waitFor(() => expect(session.offline).toBeUndefined());
	});
});

const AT = '2026-01-01T00:00:00Z';
const closedExchange = (from: number, extra: Record<string, unknown> = {}) => ({
	from,
	through: from + 1,
	status: 'closed',
	owner: 'mira',
	at: AT,
	outcome: { kind: 'complete' },
	summary: { status: 'silent' },
	activations: [
		{
			id: `act-${from}`,
			seat: 'design',
			purpose: 'respond',
			attempt: 1,
			outcome: { status: 'released' },
		},
	],
	...extra,
});
const trace = (id: string, withEnd: boolean): ActivationRead =>
	({
		activation: id,
		passes: [
			{
				pass: 1,
				input: 'view',
				through: 4,
				steps: [
					{ type: 'pass', pass: 1, input: 'view', through: 4 },
					{ type: 'tool_call', call: 'c1', name: 'read', input: { path: '/a' } },
					...(withEnd ? [{ type: 'end', stop: 'stopped' }] : []),
				],
			},
		],
	}) as unknown as ActivationRead;
const blockTypes = (session: Session) => session.blocks.map((block) => block.type);
const stepsBlock = (session: Session) =>
	session.blocks.find((candidate) => candidate.type === 'steps');

describe('Session steps', () => {
	it('opens the steps of the latest exchange, and reads them again on a room change', async () => {
		const { host, session } = await started();
		host.table.set('bringup', view('bringup', { exchanges: [closedExchange(4)] }));
		host.traces.set('act-4', trace('act-4', false));
		await session.refresh();
		await session.submit('/steps');
		expect(host.calls).toContain('activation:act-4');
		expect(stepsBlock(session)).toMatchObject({
			type: 'steps',
			running: true,
			title: 'design · respond · attempt 1',
		});
		host.traces.set('act-4', trace('act-4', true));
		host.notify('bringup');
		await vi.waitFor(() => expect(stepsBlock(session)).toMatchObject({ running: false }));
		await session.submit('/steps off');
		expect(blockTypes(session)).not.toContain('steps');
	});

	it('picks an exchange by ordinal or by discussion key, and says so for no exchange or no trace', async () => {
		const { host, session } = await started();
		host.table.set(
			'bringup',
			view('bringup', { exchanges: [closedExchange(4), closedExchange(9)] }),
		);
		host.traces.set('act-4', trace('act-4', true));
		await session.refresh();
		await session.submit('/steps');
		expect(session.notice).toMatch(/holds no steps/);
		await session.submit('/steps 1');
		expect(session.steps?.id).toBe('act-4');
		await session.submit('/steps 7');
		expect(session.notice).toBe('No exchange 7.');
		await session.submit('/steps off');
		await session.showSteps('4');
		expect(session.steps?.id).toBe('act-4');
	});
});

describe('Session awaiting and approval', () => {
	it('shows an awaiting exchange and a pending operation to the person they wait on only', async () => {
		const { host, session } = await started();
		const awaiting = closedExchange(4, { outcome: { kind: 'awaiting', person: 'mira' } });
		host.table.set('bringup', view('bringup', { exchanges: [awaiting] }));
		host.pendingApprovals = [
			{ id: 3, instrument: 'led-current', setpoint: 30, unit: 'mA', owner: 'mira', at: AT },
		];
		await session.refresh();
		expect(session.attention).toEqual([
			'The exchange from message 4 waits for your reply.',
			expect.stringMatching(/Operation 3 needs your answer.*led-current to 30 mA/),
		]);
		expect(blockTypes(session)).toContain('note');
		await session.submit('/user theo');
		expect(session.attention).toEqual([]);
		host.table.set('bringup', view('bringup'));
		host.pendingApprovals = [];
		await session.submit('/user mira');
		expect(session.attention).toEqual([]);
	});
});
