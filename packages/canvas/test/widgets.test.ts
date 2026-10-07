import { DatabaseSync } from 'node:sqlite';
import type { ToolBundle } from '@ambionframework/ambion';
import { byAgent, callTool, settled } from '@ambionframework/ambion/testing';
import { describe, expect, it } from 'vitest';
import {
	type CanvasStore,
	memoryCanvas,
	openCanvas,
	sqliteCanvas,
	type WidgetKind,
} from '../src/index.ts';
import { gallery, kinds, refusal, statusSource } from './support/gallery.ts';
import { breakoutRow, callOf, contextOf, host, live, tooled } from './support/host.ts';
import { sqlOver } from './support/sql.ts';

const stores: readonly { name: string; open: () => CanvasStore }[] = [
	{ name: 'memory', open: () => memoryCanvas() },
	{ name: 'native SQLite', open: () => sqliteCanvas(sqlOver(new DatabaseSync(':memory:'))) },
];

describe.each(stores)('widgets on the $name store', ({ open }) => {
	it('writes a revision, emits it, and answers the reads of the canvas', async () => {
		const store = open();
		const { canvas, show, widgetEvents } = await gallery({ store });
		const result = await show({ title: 'Status' });
		expect(result).toMatchObject({ room: 'site', name: 'status', rev: 1, state: 'shown' });
		const [stored] = await store.revisions();
		expect(stored).toEqual({
			room: 'site',
			name: 'status',
			revision: expect.stringMatching(/^[0-9a-f-]{36}$/),
			rev: 1,
			state: 'shown',
			kind: 'frame',
			source: statusSource,
			title: 'Status',
			author: 'ada',
			actions: [],
		});
		expect(canvas.widgets('site')).toEqual([stored]);
		expect(canvas.revision(stored?.revision ?? '')).toEqual(stored);
		expect(canvas.revision('missing')).toBeUndefined();
		expect(canvas.widgets('docs')).toEqual([]);
		expect(widgetEvents()).toEqual([{ type: 'widget', widget: stored }]);
	});

	it('writes nothing for equal content of a shown widget, and a revision for new content', async () => {
		const store = open();
		const { show, canvas, widgetEvents, call } = await gallery({ store });
		const first = await show({ title: 'Status' });
		expect(await show({ title: 'Status' }, 'bob')).toEqual({
			...(first as object),
			changed: false,
		});
		expect(await store.revisions()).toHaveLength(1);
		expect(await show({ title: 'Status 2' }, 'bob')).toMatchObject({ rev: 2, changed: true });
		expect(
			await show({ title: 'Status 2', source: { ...statusSource, path: '/other' } }),
		).toMatchObject({
			rev: 3,
		});
		expect(
			await show({ title: undefined, source: { ...statusSource, path: '/other' } }),
		).toMatchObject({ rev: 4 });
		expect(canvas.widgets('site')).toMatchObject([{ rev: 4, author: 'ada' }]);
		expect(canvas.revision((first as { revision: string }).revision)).toMatchObject({ rev: 1 });
		expect(widgetEvents()).toHaveLength(4);
		await call('ada', 'hide', { name: 'status' });
		expect(
			await show({ title: undefined, source: { ...statusSource, path: '/other' } }),
		).toMatchObject({ rev: 6, state: 'shown', changed: true });
	});

	it('hides a widget once, keeps its content, and refuses an unknown name', async () => {
		const store = open();
		const { call, show, canvas, widgetEvents } = await gallery({ store });
		await refusal(call('ada', 'hide', { name: 'status' }), /no widget "status"/);
		await show({ title: 'Status' });
		const hidden = await call('bob', 'hide', { name: 'status' });
		expect(hidden).toMatchObject({ rev: 2, state: 'hidden', changed: true });
		expect(await call('ada', 'hide', { name: 'status' })).toMatchObject({
			rev: 2,
			changed: false,
		});
		expect(await store.revisions()).toHaveLength(2);
		expect(canvas.widgets('site')).toMatchObject([
			{ state: 'hidden', kind: 'frame', source: statusSource, title: 'Status', author: 'bob' },
		]);
		expect(widgetEvents()).toHaveLength(2);
		expect(await show({ title: 'Status' })).toMatchObject({ rev: 3, state: 'shown' });
	});

	it('keeps the revisions across a restart and numbers the next one after them', async () => {
		const store = open();
		const first = await gallery({ store });
		await first.show({ title: 'Status' });
		await first.call('ada', 'show', {
			name: 'plan',
			kind: 'pin',
			source: { type: 'file', path: '/p.md' },
		});
		await first.call('ada', 'hide', { name: 'plan' });
		const before = first.canvas.widgets('site');
		const revisions = before.map((widget) => widget.revision);
		await first.canvas.close();
		const second = await gallery({ store, storage: first.storage });
		expect(second.canvas.widgets('site')).toEqual(before);
		expect(second.canvas.revision(revisions[1] ?? '')).toMatchObject({ name: 'plan', rev: 2 });
		expect(second.widgetEvents()).toEqual([]);
		expect(await second.show({ title: 'Status' })).toMatchObject({ rev: 1, changed: false });
		expect(await second.show({ title: 'Other' })).toMatchObject({ rev: 2, changed: true });
	});
});

describe('the rules of a call', () => {
	const bad: [string, Record<string, unknown>, RegExp][] = [
		['a name with capitals', { name: 'View' }, /not a widget name/],
		['a name that starts with a digit', { name: '1st' }, /not a widget name/],
		['a name over 48 characters', { name: `a${'b'.repeat(48)}` }, /49 characters/],
		['a title over 80 characters', { title: 'x'.repeat(81) }, /81 characters/],
		['a title of two lines', { title: 'one\ntwo' }, /one line/],
		['a title with a separator', { title: 'one two' }, /one line/],
		['an empty title', { title: '' }, /one line/],
		['a kind outside the catalog', { kind: 'chart' }, /not a widget kind. The kinds are: frame/],
		['a kind that needs a source and gets none', { source: undefined }, /needs a source/],
		[
			'a source of another type',
			{ source: { type: 'file', path: '/a' } },
			/takes a source of type process/,
		],
		['a source on a kind with none', { kind: 'note' }, /takes no source/],
		[
			'a process path with no slash',
			{ source: { ...statusSource, path: 'status' } },
			/starts with "\/"/,
		],
		['a source text of two lines', { source: { ...statusSource, handle: 'a\nb' } }, /one line/],
	];

	it.each(bad)('refuses %s', async (_label, args, cause) => {
		const { show, bundle } = await gallery();
		await refusal(show(args), cause);
		expect(bundle.tools).toHaveLength(2);
	});

	it('accepts a name of 48 characters, a kind with no source, and a file or snapshot source', async () => {
		const { call, canvas } = await gallery();
		const name = `a${'b'.repeat(47)}`;
		await call('ada', 'show', { name, kind: 'note', title: 'Hi' });
		await call('ada', 'show', {
			name: 'doc',
			kind: 'pin',
			source: { type: 'file', path: '/a.md' },
		});
		await call('ada', 'show', {
			name: 'proof',
			kind: 'pin',
			source: { type: 'snapshot', ref: 's1' },
		});
		expect(canvas.widgets('site').map((widget) => widget.name)).toEqual([name, 'doc', 'proof']);
	});

	it('refuses a call with no room, a room off the canvas, and an archived room', async () => {
		const store = memoryCanvas();
		await store.insert({
			...breakoutRow('site-old', 'site'),
			state: 'archived',
			close: { result: 'done' },
		});
		const { bundle, call, show } = await gallery({ store });
		const args = { name: 'status', kind: 'frame', source: statusSource };
		await refusal(
			callOf(bundle, 'show', args, { ...contextOf('ada', 'site', 'c1'), room: undefined }),
			/no room/,
		);
		await refusal(call('ada', 'show', args, 'docs'), /"docs" is not on the canvas/);
		await refusal(call('ada', 'hide', { name: 'status' }, 'docs'), /"docs" is not on the canvas/);
		await refusal(call('cy', 'show', args, 'site-old'), /"site-old" is archived/);
		await refusal(call('cy', 'hide', { name: 'status' }, 'site-old'), /archived/);
		await show();
	});

	it('refuses before resume and after close', async () => {
		const { canvas } = host({ widgets: { kinds } });
		const bundle = canvas.widgetTools();
		const args = { name: 'status', kind: 'frame', source: statusSource };
		const ctx = (id: string) => contextOf('ada', 'site', id);
		await refusal(callOf(bundle, 'show', args, ctx('c1')), /needs resume first/);
		await canvas.resume({ agents: [tooled('ada', bundle)] });
		await canvas.open({ name: 'site', goal: 'Plan.' });
		await callOf(bundle, 'show', args, ctx('c2'));
		await canvas.close();
		await refusal(callOf(bundle, 'show', args, ctx('c3')), /is closed/);
		await refusal(callOf(bundle, 'hide', { name: 'status' }, ctx('c4')), /is closed/);
	});

	it('refuses `widgetTools` with no kinds, and a catalog that cannot work', () => {
		expect(() => host().canvas.widgetTools()).toThrow(/no widget kinds/);
		expect(() => host({ widgets: { kinds: [] } }).canvas.widgetTools()).toThrow(/no widget kinds/);
		const open = (list: WidgetKind[]) =>
			openCanvas({
				name: 'lab',
				runtime: host().runtime,
				store: memoryCanvas(),
				widgets: { kinds: list },
			});
		const frame = kinds[0] as WidgetKind;
		expect(() => open([frame, frame])).toThrow(/twice/);
		expect(() => open([{ ...frame, name: 'Frame' }])).toThrow(/not a widget kind name/);
		expect(() => open([{ ...frame, description: 'a\nb' }])).toThrow(/one line/);
		expect(() => open([{ ...frame, sources: ['url' as 'file'] }])).toThrow(/unknown source type/);
	});
});

describe('the calls of one room', () => {
	it('run one at a time, so concurrent equal shows write one revision', async () => {
		const store = memoryCanvas();
		const { show, call, canvas } = await gallery({ store });
		const results = await Promise.all([show(), show({}, 'bob'), show()]);
		expect(results.map((result) => (result as { changed: boolean }).changed)).toEqual([
			true,
			false,
			false,
		]);
		const hides = await Promise.all([
			call('ada', 'hide', { name: 'status' }),
			call('bob', 'hide', { name: 'status' }),
		]);
		expect(hides.map((result) => (result as { changed: boolean }).changed)).toEqual([true, false]);
		expect(await store.revisions()).toHaveLength(2);
		expect(canvas.widgets('site')).toMatchObject([{ rev: 2, state: 'hidden' }]);
	});

	it('are separate for each room', async () => {
		const { call, canvas } = await gallery();
		await call('ada', 'show', { name: 'a', kind: 'note' });
		await canvas.open({ name: 'docs', goal: 'Docs.', agents: ['ada'] });
		await call('ada', 'show', { name: 'a', kind: 'note', title: 'Docs' }, 'docs');
		expect(canvas.widgets('site')).toMatchObject([{ room: 'site', rev: 1 }]);
		expect(canvas.widgets('docs')).toMatchObject([{ room: 'docs', rev: 1, title: 'Docs' }]);
	});
});

describe('a failed write', () => {
	it('goes to onError and the caller, and leaves the widget as it was', async () => {
		const memory = memoryCanvas();
		let failing = false;
		const store: CanvasStore = {
			...memory,
			appendRevision: (widget) => {
				if (failing) return Promise.reject(new Error('disk full'));
				return memory.appendRevision(widget);
			},
		};
		const { show, call, canvas, errors, widgetEvents } = await gallery({ store });
		await show();
		failing = true;
		await expect(show({ title: 'Other' })).rejects.toThrow('disk full');
		await expect(call('ada', 'hide', { name: 'status' })).rejects.toThrow('disk full');
		expect(errors).toMatchObject([
			{ room: 'site', operation: 'show' },
			{ room: 'site', operation: 'hide' },
		]);
		expect(canvas.widgets('site')).toMatchObject([{ rev: 1, state: 'shown' }]);
		expect(widgetEvents()).toHaveLength(1);
		failing = false;
		expect(await show({ title: 'Other' })).toMatchObject({ rev: 2 });
	});

	it('reports a listener that throws as a widget failure, and still writes', async () => {
		const { show, canvas, errors } = await gallery();
		canvas.subscribe((event) => {
			if (event.type === 'widget') throw new Error('listener');
		});
		expect(await show()).toMatchObject({ rev: 1 });
		expect(errors).toMatchObject([{ room: 'site', operation: 'widget' }]);
	});
});

describe('the reminder', () => {
	const remind = async (bundle: ToolBundle, room = 'site') =>
		bundle.remind?.({ agent: 'ada', room, activation: 'act-1' }, new AbortController().signal);

	it('gives no text when the room shows no widget', async () => {
		const { bundle, show, call } = await gallery();
		expect(await remind(bundle)).toBeUndefined();
		await show();
		await call('ada', 'hide', { name: 'status' });
		expect(await remind(bundle)).toBeUndefined();
	});

	it('lists each shown widget of the room with its source and author', async () => {
		const { bundle, show, call, canvas } = await gallery();
		await show({ title: 'Status' });
		await show({ title: 'Status 2' }, 'bob');
		await call('ada', 'show', {
			name: 'doc',
			kind: 'pin',
			source: { type: 'file', path: '/a.md' },
		});
		await call('ada', 'show', {
			name: 'proof',
			kind: 'pin',
			source: { type: 'snapshot', ref: 's1' },
		});
		await call('ada', 'show', { name: 'line', kind: 'note' });
		await call('ada', 'show', { name: 'gone', kind: 'note' });
		await call('ada', 'hide', { name: 'gone' });
		await canvas.open({ name: 'docs', goal: 'Docs.', agents: ['ada'] });
		expect(await remind(bundle)).toBe(
			[
				'Widgets in this room:',
				'- status: frame from process bash-1 /status, by bob, rev 2',
				'- doc: pin from file /a.md, by ada, rev 1',
				'- proof: pin from snapshot s1, by ada, rev 1',
				'- line: note, by ada, rev 1',
			].join('\n'),
		);
		expect(await remind(bundle, 'docs')).toBeUndefined();
	});

	it('lists at most ten widgets, then the rest', async () => {
		const { bundle, call } = await gallery();
		for (let n = 1; n <= 12; n++) await call('ada', 'show', { name: `w${n}`, kind: 'note' });
		const lines = ((await remind(bundle)) ?? '').split('\n');
		expect(lines).toHaveLength(12);
		expect(lines[0]).toBe('Widgets in this room:');
		expect(lines.at(-1)).toBe('and 2 more');
	});

	it('carries the guidance with the catalog', async () => {
		const { bundle } = await gallery();
		expect(bundle.guidance).toContain(
			'- frame: The newest frame of a process. Sources: process. Actions: yes.',
		);
		expect(bundle.guidance).toContain('- note: A line of text. Sources: none. Actions: no.');
		expect(bundle.guidance).toContain('cancel the process');
	});
});

describe('an agent on the scripted executor', () => {
	it('shows a widget with the tool that its bundle carries', async () => {
		const { site, canvas } = await gallery({
			script: byAgent({
				ada: (_step, _seat, request) =>
					request === 1
						? callTool('show', { name: 'status', kind: 'frame', source: statusSource })
						: [],
			}),
		});
		await site.post({ to: 'ada', text: 'Show the status.' });
		await settled(site);
		expect(canvas.widgets('site')).toMatchObject([{ name: 'status', author: 'ada', rev: 1 }]);
		expect(live(canvas, 'site')).toBe(site);
	});
});
