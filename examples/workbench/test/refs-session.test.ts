import type { KeyEvent } from '@opentui/core';
import { describe, expect, it, vi } from 'vitest';
import { type KeyParts, Keys } from '../src/keys.ts';
import { type FakeHost, started, view } from './fake-host.ts';

const AT = '2026-01-01T00:00:00Z';
const said = (seq: number, from: string, refs?: string[]) => ({
	seq,
	kind: 'said',
	from,
	text: `${from} ${seq}`,
	at: AT,
	refs,
});
const exchange = {
	from: 1,
	through: 3,
	status: 'closed',
	person: 'mira',
	at: AT,
	outcome: { kind: 'complete' },
	summary: { kind: 'silent' },
	activations: [],
};

const FILE = 'file:///library/led-5mm.md';
const MISSING = 'file:///library/missing.md';
const HOST_FILE = 'file:///etc/passwd';
const SNAPSHOT = `ambion://workspace/workbench/snapshot/${'a'.repeat(64)}/library/led-5mm.md`;
const COMMIT = `ambion://workspace/workbench/repo/bench/firmware/branch/blink/commit/${'e'.repeat(40)}`;
const ROOM = 'ambion://room/power';
const ELSEWHERE = 'ambion://room/power/message/2';

/** A room with a closed exchange of two messages, then three messages that cite, and a second room. */
function room(host: FakeHost, cite = true): void {
	host.table.set(
		'power',
		view('power', {
			participants: [{ name: 'mira', kind: 'human' }],
			messages: [said(1, 'mira'), said(2, 'design')],
		}),
	);
	host.table.set(
		'bringup',
		view('bringup', {
			participants: [{ name: 'mira', kind: 'human' }],
			messages: [
				said(1, 'mira'),
				said(2, 'design', cite ? [FILE, 'lab:///runs', SNAPSHOT] : undefined),
				said(3, 'datasheets'),
				said(4, 'mira', cite ? ['ambion://room/bringup/message/3', MISSING] : undefined),
				said(
					5,
					'design',
					cite ? [HOST_FILE, 'https://example.com/x', 'lab:///missing'] : undefined,
				),
				said(6, 'design', cite ? [COMMIT, ROOM, ELSEWHERE] : undefined),
			],
			exchanges: [exchange],
		}),
	);
}

async function open() {
	const made = await started();
	room(made.host);
	await made.session.refreshRooms();
	await made.session.refresh();
	return made;
}

/** The parts of the terminal that the keys touch, as records. */
function keysOver(session: Awaited<ReturnType<typeof open>>['session']) {
	const log: string[] = [];
	const root = { visible: true, height: 20 };
	const parts = {
		renderer: { width: 120 },
		session,
		composer: { blur: () => log.push('blur'), focus: () => log.push('focus'), setText: () => {} },
		palette: { refresh: () => {} },
		painter: {
			revealNext: () => {},
			revealMessage: (seq: number) => log.push(`reveal:${seq}`),
			invalidate: () => {},
		},
		panel: { fill: () => {}, draw: () => {}, scrollBy: () => {}, page: 4 },
		transcript: { root, scrollBy: () => {} },
		render: () => {},
	};
	const keys = new Keys(parts as unknown as KeyParts);
	const press = (name: string) =>
		keys.onKey({ name, ctrl: false, meta: false, sequence: '', preventDefault() {} } as KeyEvent);
	return { keys, press, log, root };
}

describe('the refs of a message', () => {
	it('lists and marks the refs of the shown messages, and a message ref opens its discussion', async () => {
		const { session } = await open();
		const state = session.refItems.map((item) => [item.id, Boolean(item.resolved.target)]);
		expect(state).toEqual([
			['4#0', true],
			['4#1', false],
			['5#0', false],
			['5#1', false],
			['5#2', false],
			['6#0', true],
			['6#1', true],
			['6#2', true],
		]);
		expect(session.refItems[0]?.resolved.target).toEqual({
			kind: 'message',
			room: 'bringup',
			seq: 3,
		});
		expect(session.expanded.has('1')).toBe(false);
		await session.openRef('4#0');
		expect(session.expanded.has('1')).toBe(true);
		expect(session.focus).toBe(3);
		session.clearFocus();
		expect(session.focus).toBeUndefined();
		session.setAllOpen(true);
		expect(session.refItems.map((item) => item.id).slice(0, 2)).toEqual(['2#0', '2#1']);
	});

	it('opens a file, a table, or a snapshot ref in the files panel, beside the tables, and nothing for a ref that does not resolve', async () => {
		const { session, host } = await open();
		host.reads.length = 0;
		for (const id of ['4#1', '5#0', '5#1', '5#2'])
			expect(await session.openRef(id)).toBeUndefined();
		expect(session.browser.open).toBe(false);
		expect(host.reads).toEqual([]);

		session.setAllOpen(true);
		expect(await session.openRef('2#0')).toEqual({ type: 'files' });
		await vi.waitFor(() => expect(session.browser.file?.path).toBe('/library/led-5mm.md'));
		expect(session.browser.open).toBe(true);
		expect(session.browser.selected?.path).toBe('/library/led-5mm.md');
		expect(session.browser.matches.map((entry) => entry.path)).toEqual([
			'/library/led-5mm.md',
			'lab:///runs',
			'lab:///results',
		]);
		expect(await session.openRef('2#1')).toEqual({ type: 'files' });
		await vi.waitFor(() => expect(session.browser.file?.path).toBe('lab:///runs'));
		expect(session.browser.selected).toEqual({ path: 'lab:///runs', size: 0, kind: 'table' });
		expect(await session.openRef('2#2')).toEqual({ type: 'files' });
		await vi.waitFor(() => expect(session.browser.file?.text).toBe(`bytes of ${SNAPSHOT}`));
		expect(session.browser.selected).toEqual({
			path: SNAPSHOT,
			size: 0,
			kind: 'snapshot',
			label: `/library/led-5mm.md @${'a'.repeat(8)}`,
		});
		expect(host.reads).toEqual(
			expect.arrayContaining(['/library/led-5mm.md', 'lab:///runs', SNAPSHOT]),
		);
	});
});

describe('the refs that open elsewhere', () => {
	it('opens a commit in the files panel, a room ref in its room, and a message of another room at the message', async () => {
		const { session, host } = await open();
		expect(await session.openRef('6#0')).toEqual({ type: 'files' });
		await vi.waitFor(() => expect(session.browser.file?.text).toBe(`commit of ${COMMIT}`));
		expect(session.browser.selected).toEqual({
			path: COMMIT,
			size: 0,
			kind: 'commit',
			label: 'bench/firmware blink eeeeeee',
		});
		expect(host.reads).toContain(COMMIT);

		expect(await session.openRef('6#1')).toBeUndefined();
		expect(session.room).toBe('power');
		await session.switchRoom('bringup');
		expect(await session.openRef('6#2')).toBeUndefined();
		expect(session.room).toBe('power');
		expect(session.focus).toBe(2);
		session.jump(9);
		expect(session.notice).toBe('Room power has no message 9 yet.');
	});
});

describe('the ref keys', () => {
	it('chooses a ref with r, moves with Up and Down, ignores Enter on a ref that does not resolve, and goes back with Escape', async () => {
		const { session } = await open();
		const { keys, press } = keysOver(session);
		press('tab');
		expect(keys.mode).toBe('browse');
		press('r');
		expect(keys.mode).toBe('refs');
		expect(keys.picking).toBe('6#2');
		for (const _ of [1, 2, 3]) press('up');
		expect(keys.picking).toBe('5#2');
		press('return');
		expect(keys.mode).toBe('refs');
		expect(session.browser.open).toBe(false);
		press('up');
		expect(keys.picking).toBe('5#1');
		press('down');
		press('down');
		expect(keys.picking).toBe('6#0');
		press('escape');
		expect(keys.mode).toBe('browse');
	});

	it('says so when no shown message has a ref', async () => {
		const { session, host } = await started();
		room(host, false);
		await session.refresh();
		const { keys, press } = keysOver(session);
		press('tab');
		press('r');
		expect(keys.mode).toBe('browse');
		expect(session.notice).toMatch(/No shown message has a ref/);
	});

	it.each([
		{ refs: [COMMIT], mode: 'refs', notice: undefined },
		{ refs: undefined, mode: 'compose', notice: 'No discussions or refs to browse yet.' },
	])(
		'reaches the refs of a direct reply, which has no discussion: $mode',
		async ({ refs, mode, notice }) => {
			const { session, host } = await started();
			host.table.set(
				'bringup',
				view('bringup', {
					participants: [{ name: 'mira', kind: 'human' }],
					messages: [said(1, 'mira'), said(2, 'design', refs)],
					exchanges: [{ ...exchange, through: 2 }],
				}),
			);
			await session.refresh();
			const { keys, press } = keysOver(session);
			press('tab');
			press('r');
			expect(keys.mode).toBe(mode);
			expect(session.notice).toBe(notice);
		},
	);

	it('opens the file preview from a chosen ref, and Escape returns to the refs', async () => {
		const { session } = await open();
		session.setAllOpen(true);
		const { keys, press, root } = keysOver(session);
		press('tab');
		press('r');
		while (keys.picking !== '2#0') press('up');
		press('return');
		await vi.waitFor(() => expect(keys.mode).toBe('files'));
		await vi.waitFor(() => expect(session.browser.file?.path).toBe('/library/led-5mm.md'));
		press('escape');
		expect(keys.mode).toBe('refs');
		expect(session.browser.open).toBe(false);
		expect(root.visible).toBe(true);
	});

	it('returns to the composer when the panel opened from a command', async () => {
		const { session } = await open();
		const { keys, press } = keysOver(session);
		await session.submit('/files');
		keys.openFiles();
		expect(keys.mode).toBe('files');
		press('escape');
		expect(keys.mode).toBe('compose');
	});

	it('opens the room of a room ref at the composer, and browses the room of a message ref at the message', async () => {
		const { session } = await open();
		const { keys, press, log } = keysOver(session);
		press('tab');
		press('r');
		press('up');
		expect(keys.picking).toBe('6#1');
		press('return');
		await vi.waitFor(() => expect(keys.mode).toBe('compose'));
		expect(session.room).toBe('power');
		expect(log.at(-1)).toBe('focus');

		await session.switchRoom('bringup');
		press('tab');
		press('r');
		press('down');
		expect(keys.picking).toBe('6#2');
		press('return');
		await vi.waitFor(() => expect(keys.mode).toBe('browse'));
		expect(session.room).toBe('power');
		expect(session.focus).toBe(2);
		expect(log).toContain('reveal:2');
	});

	it('jumps to the message a message ref cites', async () => {
		const { session } = await open();
		const { keys, press, log } = keysOver(session);
		press('tab');
		press('r');
		while (keys.picking !== '4#0') press('up');
		press('return');
		await vi.waitFor(() => expect(session.focus).toBe(3));
		expect(log).toContain('reveal:3');
		expect(session.expanded.has('1')).toBe(true);
		expect(keys.mode).toBe('refs');
		press('down');
		expect(session.focus).toBeUndefined();
	});
});
