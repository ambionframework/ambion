import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/session.ts';
import type { ActivationRead } from '../src/workbench.ts';
import { started, view } from './fake-host.ts';

describe('Session start', () => {
	it('opens the first running room as the chosen person', async () => {
		const { host, session } = await started();
		expect(session.room).toBe('bringup');
		expect(session.entered).toBe(true);
		expect(host.calls).toEqual(['join:bringup:mira']);
	});

	it('asks who the person is, and joins no room, when nobody is chosen', async () => {
		const { host, session } = await started(null);
		expect(session.identity).toBeUndefined();
		expect(session.room).toBe('');
		expect(host.calls).toEqual([]);
		expect(session.notice).toMatch(/Who are you.*mira, theo/);
	});

	it('tells the terminal to redraw when the state changes', async () => {
		const { changes } = await started();
		expect(changes()).toBeGreaterThan(0);
	});
});

describe('Session users', () => {
	it('chooses the first person, then enters the first room', async () => {
		const { host, session } = await started(null);
		await session.submit('/user theo');
		expect(session.identity?.name).toBe('theo');
		expect(host.calls).toEqual(['join:bringup:theo']);
		expect(session.notice).toBe('You are theo, firmware engineer.');
	});

	it('leaves the room as the old person, and enters it as the new one', async () => {
		const { host, session } = await started();
		host.calls.length = 0;
		await session.submit('/user theo');
		expect(host.calls).toEqual(['leave:bringup:mira', 'join:bringup:theo']);
		expect(session.room).toBe('bringup');
		expect(session.entered).toBe(true);
	});

	it('lists the people for /user, and refuses an unknown or the same person', async () => {
		const { host, session } = await started();
		host.calls.length = 0;
		await session.submit('/user');
		expect(session.notice).toMatch(/Pick a person: mira, theo/);
		await session.submit('/user nobody');
		expect(session.notice).toMatch(/No person named nobody/);
		await session.submit('/user mira');
		expect(session.notice).toBe('You are already mira.');
		expect(host.calls).toEqual([]);
	});
});

describe('Session rooms', () => {
	it('leaves the room it was in before it enters another', async () => {
		const { host, session } = await started();
		host.calls.length = 0;
		await session.submit('/room power');
		expect(host.calls).toEqual(['leave:bringup:mira', 'join:power:mira']);
		expect(session.room).toBe('power');
	});

	it('names the fix when the room does not exist', async () => {
		const { session } = await started();
		await session.submit('/room nowhere');
		expect(session.notice).toMatch(/No room named nowhere/);
		expect(session.room).toBe('bringup');
	});

	it('creates a room named with its goal, and opens it', async () => {
		const { host, session } = await started();
		await session.submit('/new motors Drive a small motor');
		expect(host.calls).toContain('create:motors:Drive a small motor');
		expect(session.room).toBe('motors');
		expect(session.notice).toBe('Created motors.');
	});

	it('asks for the goal when the command has none, and takes the next line as the goal', async () => {
		const { host, session } = await started();
		await session.submit('/new motors');
		expect(session.awaitingGoal).toBe('motors');
		expect(session.waiting).toBe('Goal for motors');
		expect(host.calls.some((call) => call.startsWith('create'))).toBe(false);
		await session.submit('Drive a small motor');
		expect(host.calls).toContain('create:motors:Drive a small motor');
		expect(session.awaitingGoal).toBeUndefined();
		expect(session.room).toBe('motors');
	});

	it('can drop a room that waits for its goal', async () => {
		const { host, session } = await started();
		await session.submit('/new motors');
		session.cancelWaiting();
		expect(session.awaitingGoal).toBeUndefined();
		expect(session.notice).toMatch(/Canceled/);
		expect(host.calls.some((call) => call.startsWith('create'))).toBe(false);
	});

	it('refuses a bad name at once, and a room that exists', async () => {
		const { host, session } = await started();
		await session.submit('/new Bad_Name');
		expect(session.notice).toMatch(/lowercase room name/);
		await session.submit('/new bringup');
		expect(session.notice).toBe('bringup already exists.');
		await session.submit('/new');
		expect(session.notice).toMatch(/Name the room/);
		expect(host.calls.some((call) => call.startsWith('create'))).toBe(false);
	});

	it('reports a failed creation and stops waiting', async () => {
		const { host, session } = await started();
		await session.submit('/new motors');
		host.failNext = 'The host refused.';
		await session.submit('Drive a motor');
		expect(session.error).toBe('The host refused.');
		expect(session.awaitingGoal).toBeUndefined();
	});
});

describe('Session messages and control', () => {
	it('sends a message as the person, and enters first when not present', async () => {
		const { host, session } = await started();
		session.entered = false;
		host.calls.length = 0;
		await session.submit('Which resistor?');
		expect(host.calls).toEqual(['join:bringup:mira', 'send:bringup:mira:Which resistor?']);
	});

	it('asks for a person before it sends for nobody', async () => {
		const { host, session } = await started(null);
		await session.submit('Hello?');
		expect(session.notice).toMatch(/Pick a person first/);
		expect(host.calls).toEqual([]);
	});

	it('keeps the text and names the fix when the room is stopped', async () => {
		const { host, session } = await started();
		host.table.set('bringup', view('bringup', { status: 'stopped' }));
		await session.refresh();
		host.calls.length = 0;
		await session.submit('Anybody?');
		expect(session.error).toBe('bringup is stopped. Use /resume first.');
		expect(host.calls).toEqual([]);
	});

	it('shows a host error instead of losing it', async () => {
		const { host, session } = await started();
		host.failNext = 'Enter this room before sending.';
		await session.submit('Hello');
		expect(session.error).toBe('Enter this room before sending.');
	});

	it('refuses to abort when no exchange is open, and aborts when one is', async () => {
		const { host, session } = await started();
		await session.submit('/abort');
		expect(session.notice).toBe('Nothing to abort. bringup has no open exchange.');
		expect(host.calls.some((call) => call.startsWith('control'))).toBe(false);
		host.table.set('bringup', view('bringup', { exchange: { owner: 'mira', from: 4, at: '' } }));
		await session.refresh();
		await session.submit('/abort');
		expect(host.calls).toContain('control:bringup:abort');
		expect(session.notice).toBe('Aborted the open exchange in bringup.');
	});

	it('stops a room, marks the person out of it, and enters it again on resume', async () => {
		const { host, session } = await started();
		await session.submit('/stop');
		expect(session.entered).toBe(false);
		host.table.set('bringup', view('bringup', { status: 'stopped' }));
		await session.refresh();
		await session.submit('/stop');
		expect(session.notice).toBe('bringup is already stopped.');
		host.calls.length = 0;
		await session.submit('/resume');
		expect(host.calls).toEqual(['control:bringup:resume', 'join:bringup:mira']);
		expect(session.entered).toBe(true);
	});

	it('ends the visit on leave, and only when the person is in the room', async () => {
		const { host, session } = await started();
		host.calls.length = 0;
		await session.leave();
		expect(host.calls).toEqual(['leave:bringup:mira']);
		session.entered = false;
		await session.leave();
		expect(host.calls).toEqual(['leave:bringup:mira']);
	});
});

describe('Session /attach', () => {
	it('copies a local file into the workspace, and cites it as a ref of the next message', async () => {
		const { host, session } = await started();
		await session.submit('/attach ~/photos/board.png');
		expect(host.attached).toEqual(['~/photos/board.png']);
		expect(session.pendingRefs).toEqual([
			{ path: '/attachments/board.png', ref: 'file:///attachments/board.png' },
		]);
		expect(session.notice).toMatch(/Attached \/attachments\/board\.png/);

		await session.submit('Look at this.');
		expect(host.sentRefs).toEqual([['file:///attachments/board.png']]);
		expect(session.pendingRefs).toEqual([]);
	});

	it('asks for a path when the command takes none', async () => {
		const { session } = await started();
		await session.submit('/attach');
		expect(session.notice).toMatch(/Use \/attach/);
	});

	it('shows a host error, and keeps nothing staged, when the copy fails', async () => {
		const { host, session } = await started();
		host.failNext = 'ENOENT: no such file';
		await session.submit('/attach missing.png');
		expect(session.error).toBe('ENOENT: no such file');
		expect(session.pendingRefs).toEqual([]);
	});

	it('drops a staged attachment on a room switch', async () => {
		const { session } = await started();
		await session.submit('/attach board.png');
		expect(session.pendingRefs).toHaveLength(1);
		await session.switchRoom('power');
		expect(session.pendingRefs).toEqual([]);
	});

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
});

describe('Session files and prompts', () => {
	it('opens the files panel on the first file, and previews it', async () => {
		const { session } = await started();
		expect(await session.submit('/files')).toEqual({ type: 'files' });
		await vi.waitFor(() => expect(session.browser.file?.path).toBe('/library/led-5mm.md'));
		expect(session.browser.open).toBe(true);
		expect(session.browser.file?.text).toBe('text of /library/led-5mm.md');
	});

	it('narrows the files as the person types, and follows the selection', async () => {
		const { session } = await started();
		await session.submit('/files');
		session.browser.type('NOTES');
		expect(session.browser.matches.map((file) => file.path)).toEqual(['/shared/notes.md']);
		await vi.waitFor(() => expect(session.browser.file?.path).toBe('/shared/notes.md'));
		session.browser.clear();
		await vi.waitFor(() => expect(session.browser.file?.path).toBe('/library/led-5mm.md'));
		session.browser.move(1);
		await vi.waitFor(() => expect(session.browser.file?.path).toBe('/shared/notes.md'));
		session.browser.type('nothing');
		expect(session.browser.selected).toBeUndefined();
		await vi.waitFor(() => expect(session.browser.file).toBeUndefined());
	});

	it('opens the panel on one file for /open, by path or by a part of it', async () => {
		const { session } = await started();
		await session.refreshRooms();
		for (const argument of ['/library/led-5mm.md', 'library/led-5mm.md', 'led-5']) {
			expect(await session.submit(`/open ${argument}`)).toEqual({ type: 'files' });
			expect(session.browser.selected?.path).toBe('/library/led-5mm.md');
		}
	});

	it('says so when /open matches no file, and opens the panel with none named', async () => {
		const { session } = await started();
		expect(await session.submit('/open nothing')).toBeUndefined();
		expect(session.notice).toMatch(/No file matches nothing/);
		expect(await session.submit('/open')).toEqual({ type: 'files' });
	});

	it('fills the composer with the room’s suggested question', async () => {
		const { session } = await started();
		expect(await session.submit('/try')).toEqual({ type: 'compose', text: 'Try bringup' });
	});

	it('returns a quit intent, and a message for an unknown command', async () => {
		const { session } = await started();
		expect(await session.submit('/quit')).toEqual({ type: 'quit' });
		await session.submit('/nope');
		expect(session.notice).toMatch(/Unknown command \/nope/);
	});
});

describe('Session push updates', () => {
	it('reads the open room when the host reports a change', async () => {
		const { host, session } = await started();
		const before = host.readCount;
		host.table.set('bringup', view('bringup', { exchange: { owner: 'mira', from: 4, at: '' } }));
		host.notify('bringup');
		await vi.waitFor(() => expect(session.view?.exchange).toBeDefined());
		expect(host.readCount).toBeGreaterThan(before);
	});

	it('watches only the open room, and moves the watch when the room changes', async () => {
		const { host, session } = await started();
		expect(host.listeners('bringup')).toBe(1);
		await session.submit('/room power');
		expect(host.listeners('bringup')).toBe(0);
		expect(host.listeners('power')).toBe(1);
	});

	it('ends the watch when the person leaves', async () => {
		const { host, session } = await started();
		await session.leave();
		expect(host.listeners('bringup')).toBe(0);
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

	it('picks an exchange by ordinal, and refuses one that does not exist', async () => {
		const { host, session } = await started();
		host.table.set(
			'bringup',
			view('bringup', { exchanges: [closedExchange(4), closedExchange(9)] }),
		);
		host.traces.set('act-4', trace('act-4', true));
		await session.refresh();
		await session.submit('/steps 1');
		expect(session.steps?.id).toBe('act-4');
		await session.submit('/steps 7');
		expect(session.notice).toBe('No exchange 7.');
	});

	it('opens the steps of the exchange a discussion key names', async () => {
		const { host, session } = await started();
		host.table.set('bringup', view('bringup', { exchanges: [closedExchange(4)] }));
		host.traces.set('act-4', trace('act-4', true));
		await session.refresh();
		await session.showSteps('4');
		expect(session.steps?.id).toBe('act-4');
	});

	it('says so when the activation has no trace', async () => {
		const { host, session } = await started();
		host.table.set('bringup', view('bringup', { exchanges: [closedExchange(4)] }));
		await session.refresh();
		await session.submit('/steps');
		expect(session.notice).toMatch(/holds no steps/);
	});
});

describe('Session awaiting and approval', () => {
	const awaiting = closedExchange(4, { outcome: { kind: 'awaiting', person: 'mira' } });

	it('shows an awaiting exchange to the person it waits on, and to nobody else', async () => {
		const { host, session } = await started();
		host.table.set('bringup', view('bringup', { exchanges: [awaiting] }));
		await session.refresh();
		expect(session.attention).toEqual(['The exchange from message 4 waits for your reply.']);
		expect(blockTypes(session)).toContain('note');
		await session.submit('/user theo');
		expect(session.attention).toEqual([]);
	});

	it('shows a pending operation to the owner of the exchange only', async () => {
		const { host, session } = await started();
		host.pendingApprovals = [
			{ id: 3, instrument: 'led-current', setpoint: 30, unit: 'mA', owner: 'mira', at: AT },
		];
		await session.refresh();
		expect(session.attention).toHaveLength(1);
		expect(session.attention[0]).toMatch(/Operation 3 needs your answer.*led-current to 30 mA/);
		await session.submit('/user theo');
		expect(session.attention).toEqual([]);
		host.pendingApprovals = [];
		await session.submit('/user mira');
		expect(session.attention).toEqual([]);
	});
});
