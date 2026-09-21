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
	owner: 'mira',
	at: AT,
	outcome: { kind: 'complete' },
	summary: { status: 'silent' },
	activations: [],
};

const FILE = 'file:///library/led-5mm.md';
const MISSING = 'file:///library/missing.md';
const HOST_FILE = 'file:///etc/passwd';

/** A room with a closed exchange of two messages, then two messages that cite. */
function room(host: FakeHost, cite = true): void {
	host.table.set(
		'bringup',
		view('bringup', {
			participants: [{ name: 'mira', kind: 'human' }],
			messages: [
				said(1, 'mira'),
				said(2, 'design', cite ? [FILE, 'lab:///runs'] : undefined),
				said(3, 'datasheets'),
				said(4, 'mira', cite ? ['ambion://room/bringup/message/3', MISSING] : undefined),
				said(
					5,
					'design',
					cite ? [HOST_FILE, 'https://example.com/x', 'lab:///missing'] : undefined,
				),
			],
			exchanges: [exchange],
		}),
	);
}

async function open() {
	const made = await started();
	made.host.fileList = [{ path: '/library/led-5mm.md', size: 797 }];
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
	it('lists the refs of the shown messages only, and every discussion opens more', async () => {
		const { session } = await open();
		expect(session.refItems.map((item) => item.id)).toEqual(['4#0', '4#1', '5#0', '5#1', '5#2']);
		session.setAllOpen(true);
		expect(session.refItems.map((item) => item.id).slice(0, 2)).toEqual(['2#0', '2#1']);
	});

	it('marks each ref that does not resolve, and each one outside the workspace', async () => {
		const { session } = await open();
		const state = session.refItems.map((item) => [item.id, Boolean(item.resolved.target)]);
		expect(state).toEqual([
			['4#0', true],
			['4#1', false],
			['5#0', false],
			['5#1', false],
			['5#2', false],
		]);
	});

	it('opens a file ref in the same preview the files panel gives', async () => {
		const { session, host } = await open();
		session.setAllOpen(true);
		const intent = await session.openRef('2#0');
		expect(intent).toEqual({ type: 'files' });
		await vi.waitFor(() => expect(session.browser.file?.path).toBe('/library/led-5mm.md'));
		expect(session.browser.open).toBe(true);
		expect(session.browser.selected?.path).toBe('/library/led-5mm.md');
		expect(host.reads).toContain('/library/led-5mm.md');
	});

	it('opens a table ref in the table preview', async () => {
		const { session, host } = await open();
		session.setAllOpen(true);
		expect(await session.openRef('2#1')).toEqual({ type: 'files' });
		await vi.waitFor(() => expect(session.browser.file?.path).toBe('lab:///runs'));
		expect(session.browser.selected).toEqual({ path: 'lab:///runs', size: 0, kind: 'table' });
		expect(host.reads).toContain('lab:///runs');
	});

	it('lists the tables in the files panel beside the files', async () => {
		const { session } = await open();
		await session.submit('/files');
		expect(session.browser.matches.map((entry) => entry.path)).toEqual([
			'/library/led-5mm.md',
			'lab:///runs',
			'lab:///results',
		]);
	});

	it('opens nothing for a ref that does not resolve, and reads nothing from the host', async () => {
		const { session, host } = await open();
		host.reads.length = 0;
		for (const id of ['4#1', '5#0', '5#1', '5#2']) {
			expect(await session.openRef(id)).toBeUndefined();
		}
		expect(session.browser.open).toBe(false);
		expect(host.reads).toEqual([]);
	});

	it('jumps to a message inside a closed discussion, and opens the discussion', async () => {
		const { session } = await open();
		expect(session.refItems.find((item) => item.id === '4#0')?.resolved.target).toEqual({
			kind: 'message',
			seq: 3,
		});
		expect(session.expanded.has('1')).toBe(false);
		await session.openRef('4#0');
		expect(session.expanded.has('1')).toBe(true);
		expect(session.focus).toBe(3);
		session.clearFocus();
		expect(session.focus).toBeUndefined();
	});
});

describe('the ref keys', () => {
	it('chooses a ref with r, moves with Up and Down, and goes back with Escape', async () => {
		const { session } = await open();
		const { keys, press } = keysOver(session);
		press('tab');
		expect(keys.mode).toBe('browse');
		press('r');
		expect(keys.mode).toBe('refs');
		expect(keys.picking).toBe('5#2');
		press('up');
		expect(keys.picking).toBe('5#1');
		press('down');
		press('down');
		expect(keys.picking).toBe('5#2');
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

	it('does nothing when Enter meets a ref that does not resolve', async () => {
		const { session } = await open();
		const { keys, press } = keysOver(session);
		press('tab');
		press('r');
		expect(keys.picking).toBe('5#2');
		press('return');
		expect(keys.mode).toBe('refs');
		expect(session.browser.open).toBe(false);
	});
});
