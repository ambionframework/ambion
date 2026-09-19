import { describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.ts';
import type { FileContent, FileEntry, Person, RoomView, Workbench } from '../src/workbench.ts';

const person = (name: string, role: string) =>
	({ name, role, identity: name }) as unknown as Person;
const view = (name: string, extra: Record<string, unknown> = {}) =>
	({
		name,
		initialized: true,
		goal: `${name} goal`,
		status: 'running',
		activity: [],
		prompt: `Try ${name}`,
		messages: [],
		participants: [],
		exchanges: [],
		exchange: undefined,
		watermark: 0,
		...extra,
	}) as unknown as RoomView;

/** A host that records each call and answers from a table. */
class FakeHost implements Workbench {
	readonly people = [person('mira', 'Hardware lead'), person('theo', 'Firmware engineer')];
	readonly calls: string[] = [];
	readonly table = new Map<string, RoomView>([
		['bringup', view('bringup')],
		['power', view('power')],
	]);
	fileList: FileEntry[] = [
		{ path: '/library/led-5mm.md', size: 797 },
		{ path: '/shared/notes.md', size: 40 },
	];
	failNext: string | undefined;

	private record(call: string): void {
		this.calls.push(call);
		if (this.failNext) {
			const message = this.failNext;
			this.failNext = undefined;
			throw new Error(message);
		}
	}

	async rooms() {
		return [...this.table.values()];
	}
	async read(room: string) {
		const found = this.table.get(room);
		if (!found) throw new Error(`No room ${room}`);
		return found;
	}
	watch(_room: string, _changed: () => void) {
		return () => {};
	}
	async join(room: string, who: string) {
		this.record(`join:${room}:${who}`);
	}
	async leave(room: string, who: string) {
		this.record(`leave:${room}:${who}`);
	}
	async send(room: string, who: string, _key: string, text: string) {
		this.record(`send:${room}:${who}:${text}`);
	}
	async control(room: string, action: string) {
		this.record(`control:${room}:${action}`);
		return this.read(room);
	}
	async create(name: string, goal: string) {
		this.record(`create:${name}:${goal}`);
		const created = view(name, { goal });
		this.table.set(name, created);
		return created;
	}
	async files() {
		return this.fileList;
	}
	async file(path: string): Promise<FileContent> {
		return { path, text: `text of ${path}`, truncated: false };
	}
	async close() {
		this.calls.push('close');
	}
}

async function started(name: string | null = 'mira') {
	const host = new FakeHost();
	let changes = 0;
	const identity = name ? host.people.find((candidate) => candidate.name === name) : undefined;
	const session = new Session(host, identity, () => {
		changes += 1;
	});
	await session.start();
	return { host, session, changes: () => changes };
}

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
