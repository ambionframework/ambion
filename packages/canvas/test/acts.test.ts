import { definePerson, type Room, type ToolBundle } from '@ambionframework/ambion';
import { settled } from '@ambionframework/ambion/testing';
import { describe, expect, it } from 'vitest';
import {
	type CanvasEvent,
	type CanvasStore,
	memoryCanvas,
	type WidgetAct,
	type WidgetAction,
} from '../src/index.ts';
import { gallery, refusal, statusSource } from './support/gallery.ts';
import { breakoutRow } from './support/host.ts';

const mira = definePerson({ name: 'mira', identity: 'Mira.' });
const ola = definePerson({ name: 'ola', identity: 'Ola.' });

const look: WidgetAction = { id: 'look', label: 'Look now' };
const keep: WidgetAction = { id: 'keep', label: 'Keep it', once: true };
const form: WidgetAction = {
	id: 'file-it',
	label: 'File it',
	fields: [
		{ name: 'note', label: 'Note', type: 'text' },
		{ name: 'size', label: 'Size', type: 'number', min: 1, max: 9 },
		{ name: 'loud', label: 'Loud', type: 'boolean' },
		{ name: 'mode', label: 'Mode', type: 'choice', options: ['fast', 'slow'] },
	],
};

/** A canvas with the widget `status` that carries actions, and the calls to press them. */
async function desk(options: { store?: CanvasStore; actions?: WidgetAction[]; for?: string } = {}) {
	const lab = await gallery(options.store === undefined ? {} : { store: options.store });
	const answered: Extract<CanvasEvent, { type: 'answered' }>[] = [];
	lab.canvas.subscribe((event) => {
		if (event.type === 'answered') answered.push(event);
	});
	const ask = async (args: Record<string, unknown> = {}) =>
		(await lab.show({
			actions: options.actions ?? [look],
			...(options.for === undefined ? {} : { for: options.for }),
			...args,
		})) as { revision: string; rev: number };
	const shown = await ask();
	const press = (extra: Partial<WidgetAct> = {}, person = mira) =>
		lab.canvas.act(person, {
			room: 'site',
			widget: 'status',
			revision: shown.revision,
			action: (options.actions ?? [look])[0]?.id ?? 'look',
			press: 'p1',
			...extra,
		});
	return { ...lab, answered, ask, shown, press };
}

type Lab = Awaited<ReturnType<typeof desk>>;

/** The messages of a room that a person said. */
async function saidIn(room: Room) {
	return (await room.read()).messages.flatMap((message) =>
		message.kind === 'said' ? [message] : [],
	);
}

describe('an act', () => {
	it('sends the press as a message of the person to the author, with the revision as its ref', async () => {
		const { press, site, canvas, shown } = await desk();
		const result = await press();
		expect(result).toEqual({ kind: 'sent', seq: expect.any(Number) });
		await settled(site);
		const [said] = await saidIn(site);
		expect(said).toMatchObject({
			seq: (result as { seq: number }).seq,
			from: 'mira',
			to: 'ada',
			text: 'status, rev 1: Look now [look]',
			refs: [`ambion-canvas://lab/room/site/widget/status/revision/${shown.revision}`],
			key: `act:${shown.revision}:p1`,
		});
		expect(canvas.revision(shown.revision)).toMatchObject({ author: 'ada' });
		expect((await site.read()).participants).toMatchObject(
			expect.arrayContaining([expect.objectContaining({ name: 'mira', presence: 'present' })]),
		);
	});

	it('names the title and quotes each field of a form', async () => {
		const { press, site, ask } = await desk({ actions: [form] });
		const { revision } = await ask({ title: 'Clip 4' });
		await press({
			revision,
			action: 'file-it',
			values: { note: 'the red door', size: 3, loud: false, mode: 'slow' },
		});
		const [said] = await saidIn(site);
		expect(said?.text).toBe(
			[
				'status, rev 2 "Clip 4": File it [file-it]',
				'Note: the red door',
				'Size: 3',
				'Loud: false',
				'Mode: slow',
			].join('\n'),
		);
	});

	it.each([
		['the author left the roster', 'site', true],
		['the author sits at none', 'quiet', false],
	])('sends with no `to` when %s', async (_label, room, unseat) => {
		const { canvas, call, site } = await desk();
		await canvas.open({ name: 'quiet', goal: 'Hush.', agents: ['ada'], seats: { ada: 'none' } });
		const { revision } = (await call(
			'ada',
			'show',
			{ name: 'status', kind: 'frame', source: statusSource, actions: [look] },
			room,
		)) as { revision: string };
		if (unseat) await site.unseat('ada');
		const result = await canvas.act(mira, {
			room,
			widget: 'status',
			revision,
			action: 'look',
			press: 'p1',
		});
		expect(result).toMatchObject({ kind: 'sent' });
		const [said] = await saidIn(canvas.room(room) as Room);
		expect(said).toBeDefined();
		expect(said).not.toHaveProperty('to');
	});

	it('opens a visit first for a person who left, and the arrival comes before the act', async () => {
		const { press, site } = await desk();
		const visit = await site.visit(mira);
		await visit.leave();
		const result = (await press()) as { seq: number };
		const read = await site.read();
		const arrivals = read.messages.filter((message) => message.kind === 'arrived');
		expect(arrivals).toHaveLength(2);
		expect(arrivals[1]?.seq).toBeLessThan(result.seq);
	});

	it('returns stale with the current widget for an older revision, and sends nothing', async () => {
		const { press, ask, site, canvas } = await desk();
		await ask({ title: 'New' });
		const [current] = canvas.widgets('site');
		expect(await press()).toEqual({ kind: 'stale', widget: current });
		expect(await saidIn(site)).toEqual([]);
	});

	it('runs in the widget queue, so a show before it makes it stale', async () => {
		const { press, ask } = await desk();
		const results = await Promise.all([ask({ title: 'New' }), press()]);
		expect(results[1]).toMatchObject({ kind: 'stale' });
	});

	it('lands once for a retry with the same press', async () => {
		const { press, site } = await desk();
		const first = await press();
		expect(await press()).toEqual(first);
		const acts = (await saidIn(site)).filter((message) => message.key?.startsWith('act:'));
		expect(acts).toHaveLength(1);
		const second = await press({ press: 'p2' });
		expect(second).not.toEqual(first);
		expect(await saidIn(site)).toHaveLength(2);
	});

	it.each([
		[
			'hides the widget',
			async (lab: Lab) => void (await lab.call('ada', 'hide', { name: 'status' })),
		],
		['shows a new revision', async (lab: Lab) => void (await lab.ask({ title: 'New' }))],
		['leaves the roster', async (lab: Lab) => lab.site.unseat('ada')],
	])('returns the landed press for a retry after the author %s', async (_label, react) => {
		const lab = await desk();
		const first = await lab.press();
		await react(lab);
		expect(await lab.press()).toEqual(first);
		expect(await saidIn(lab.site)).toHaveLength(1);
	});

	it.each([
		[
			'hides the widget',
			async (lab: Lab) => void (await lab.call('ada', 'hide', { name: 'status' })),
		],
		['shows a new revision', async (lab: Lab) => void (await lab.ask({ title: 'New' }))],
		['leaves the roster', async (lab: Lab) => lab.site.unseat('ada')],
	])('returns sent for a once retry after the author %s', async (_label, react) => {
		const lab = await desk({ actions: [keep] });
		const first = await lab.press();
		await react(lab);
		expect(await lab.press()).toEqual(first);
		expect(await saidIn(lab.site)).toHaveLength(1);
	});

	it('refuses a press that landed with other values, as a defect of the host', async () => {
		const { press, ask } = await desk({ actions: [form] });
		const { revision } = await ask();
		const values = { note: 'a', size: 1, loud: true, mode: 'fast' };
		await press({ revision, action: 'file-it', values });
		await refusal(
			press({ revision, action: 'file-it', values: { ...values, note: 'b' } }),
			/landed with other content/,
		);
	});

	it('takes the person from a visit that exists, with no second arrival', async () => {
		const { press, site } = await desk();
		await site.visit(mira);
		await press();
		const arrivals = (await site.read()).messages.filter(
			(message) => message.kind === 'arrived' && message.subject === 'mira',
		);
		expect(arrivals).toHaveLength(1);
	});
});

describe('a once action', () => {
	it('answers on the first press, and the second press is answered with its seq', async () => {
		const { press, answered, canvas, shown, site } = await desk({ actions: [keep] });
		expect(canvas.answers('site').size).toBe(0);
		const first = (await press()) as { kind: 'sent'; seq: number };
		expect(first.kind).toBe('sent');
		expect(canvas.answers('site')).toEqual(new Map([[shown.revision, first.seq]]));
		expect(answered).toEqual([
			{ type: 'answered', room: 'site', revision: shown.revision, seq: first.seq },
		]);
		const second = await press({ press: 'p2', values: undefined }, ola);
		expect(second).toEqual({ kind: 'answered', seq: first.seq });
		expect(await saidIn(site)).toHaveLength(1);
		expect(answered).toHaveLength(1);
		const [said] = await saidIn(site);
		expect(said?.key).toBe(`act:${shown.revision}`);
	});

	it('returns the landed message for a retry of the same press, and tells the listeners once', async () => {
		const { press, answered } = await desk({ actions: [keep] });
		const first = await press();
		expect(await press()).toEqual(first);
		expect(answered).toHaveLength(1);
	});

	it('answers a once act that the canvas has not seen, from the key of the room', async () => {
		const { press, site, shown, canvas } = await desk({ actions: [keep] });
		const visit = await site.visit(ola);
		const landed = await visit.send({ text: 'Keep it.', key: `act:${shown.revision}` });
		expect(canvas.answers('site').size).toBe(0);
		expect(await press()).toMatchObject({ kind: 'answered', seq: landed.from });
		expect(canvas.answers('site').get(shown.revision)).toBe(landed.from);
	});

	it('keeps the answer across a restart, since the journal holds it', async () => {
		const store = memoryCanvas();
		const first = await desk({ store, actions: [keep] });
		const sent = (await first.press()) as { seq: number };
		await first.canvas.close();
		const second = await gallery({ store, storage: first.storage });
		expect(second.canvas.answers('site')).toEqual(new Map([[first.shown.revision, sent.seq]]));
		expect(second.canvas.answers('docs').size).toBe(0);
		const again = await second.canvas.act(ola, {
			room: 'site',
			widget: 'status',
			revision: first.shown.revision,
			action: 'keep',
			press: 'p9',
		});
		expect(again).toEqual({ kind: 'answered', seq: sent.seq });
	});

	it('answers one revision, and a new revision asks again', async () => {
		const { press, ask, canvas, shown } = await desk({ actions: [keep] });
		await press();
		const next = await ask({ title: 'Again' });
		expect(await press({ revision: next.revision, press: 'p2' })).toMatchObject({ kind: 'sent' });
		expect([...canvas.answers('site').keys()]).toEqual([shown.revision, next.revision]);
	});

	it('names the answer in the reminder, with the person it is for', async () => {
		const { press, bundle } = await desk({ actions: [keep], for: 'mira' });
		const remind = () =>
			(bundle as ToolBundle).remind?.(
				{ agent: 'ada', room: 'site', activation: 'act-1' },
				new AbortController().signal,
			);
		expect(await remind()).toBe(
			[
				'Widgets in this room:',
				'- status: frame from process bash-1 /status for mira, by ada, rev 1',
			].join('\n'),
		);
		const sent = (await press()) as { seq: number };
		expect(await remind()).toBe(
			[
				'Widgets in this room:',
				`- status: frame from process bash-1 /status for mira, by ada, rev 1, answered by mira in #${sent.seq}`,
			].join('\n'),
		);
	});

	it('reports a failing listener of the answer as an act failure, and still sends', async () => {
		const { press, canvas, errors } = await desk({ actions: [keep] });
		canvas.subscribe((event) => {
			if (event.type === 'answered') throw new Error('listener');
		});
		expect(await press()).toMatchObject({ kind: 'sent' });
		expect(errors).toMatchObject([{ room: 'site', operation: 'act' }]);
	});
});

describe('the refusals of an act', () => {
	const values = { note: 'a', size: 3, loud: true, mode: 'fast' };
	const bad: [string, Partial<WidgetAct>, RegExp][] = [
		['an unknown action', { action: 'drop' }, /no action "drop"/],
		['a missing value', { values: { note: 'a' } }, /"size" of the action "file-it" needs a value/],
		['a value of another type', { values: { ...values, loud: 'yes' } }, /"loud".*breaks it/],
		['a number under its min', { values: { ...values, size: 0 } }, /"size".*breaks it/],
		['a number over its max', { values: { ...values, size: 10 } }, /"size".*breaks it/],
		['a number that is not finite', { values: { ...values, size: Infinity } }, /"size".*breaks it/],
		['a choice outside its options', { values: { ...values, mode: 'x' } }, /"mode".*breaks it/],
		['a text of two lines', { values: { ...values, note: 'a\nb' } }, /"note".*breaks it/],
		['an empty text', { values: { ...values, note: '' } }, /"note".*breaks it/],
		['a text over 200 characters', { values: { ...values, note: 'x'.repeat(201) } }, /"note"/],
		['a value for no field', { values: { ...values, extra: 1 } }, /no field "extra"/],
		['an empty press', { press: '' }, /The press is one line/],
	];

	it.each(bad)('refuses %s', async (_label, extra, cause) => {
		const { press, ask, site } = await desk({ actions: [form] });
		const { revision } = await ask();
		await refusal(press({ revision, action: 'file-it', values, ...extra }), cause);
		expect(await saidIn(site)).toEqual([]);
	});

	it('refuses a person outside `for`, and accepts the person that it names', async () => {
		const { press, site } = await desk({ for: 'mira' });
		await refusal(press({}, ola), /is for mira/);
		expect(await saidIn(site)).toEqual([]);
		expect(await press()).toMatchObject({ kind: 'sent' });
	});

	it('refuses an unknown widget and an unknown room', async () => {
		const { press } = await desk();
		await refusal(press({ widget: 'ghost' }), /no widget "ghost"/);
		await refusal(press({ room: 'docs' }), /"docs" is not on the canvas/);
	});

	it('returns stale with the hidden widget for an act on a hidden widget', async () => {
		const { press, call, canvas, site } = await desk();
		await call('ada', 'hide', { name: 'status' });
		expect(await press()).toEqual({ kind: 'stale', widget: canvas.widgets('site')[0] });
		expect(await saidIn(site)).toEqual([]);
	});

	it('refuses a room that is stopped, archived, or closed', async () => {
		const store = memoryCanvas();
		await store.insert({
			...breakoutRow('site-old', 'site'),
			state: 'archived',
			close: { result: 'done' },
		});
		const { press, canvas } = await desk({ store });
		await refusal(press({ room: 'site-old' }), /"site-old" is archived/);
		await canvas.stop('site');
		await refusal(press(), /"site" is stopped/);
		await canvas.start('site');
		expect(await press()).toMatchObject({ kind: 'sent' });
		await canvas.close();
		await refusal(press({ press: 'p2' }), /is closed/);
	});

	it('checks in a fixed order: the room, the widget and its revision, then the action', async () => {
		const { press, ask, call, canvas } = await desk();
		await ask({ title: 'New' });
		const stale = { action: 'drop' };
		expect(await press(stale)).toMatchObject({ kind: 'stale' });
		await call('ada', 'hide', { name: 'status' });
		expect(await press(stale)).toMatchObject({ kind: 'stale' });
		await canvas.stop('site');
		await refusal(press(stale), /is stopped/);
	});
});

describe('the actions of a widget', () => {
	it('is part of the content, so a change writes a revision and an equal show writes nothing', async () => {
		const { ask, canvas, shown } = await desk();
		expect(await ask()).toMatchObject({ revision: shown.revision });
		expect(await ask({ actions: [{ ...look }] })).toMatchObject({ revision: shown.revision });
		expect(await ask({ actions: [look, keep] })).toMatchObject({ rev: 2 });
		expect(await ask({ actions: [look, keep], for: 'mira' })).toMatchObject({ rev: 3 });
		expect(await ask({ actions: [look, keep], for: 'mira' })).toMatchObject({ rev: 3 });
		expect(await ask({ actions: [] })).toMatchObject({ rev: 4 });
		expect(canvas.widgets('site')).toMatchObject([{ rev: 4, actions: [] }]);
		expect(canvas.widgets('site')[0]).not.toHaveProperty('for');
	});

	it('keeps its actions and its person on the hidden revision', async () => {
		const { call, canvas } = await desk({ for: 'mira' });
		await call('bob', 'hide', { name: 'status' });
		expect(canvas.widgets('site')).toMatchObject([
			{ state: 'hidden', actions: [look], for: 'mira' },
		]);
	});

	const many = (count: number) =>
		Array.from({ length: count }, (_, index) => ({ id: `a${index}`, label: 'A' }));
	const field = (extra: Record<string, unknown>) => ({
		id: 'x',
		label: 'X',
		fields: [{ name: 'f', label: 'F', type: 'text', ...extra }],
	});
	const bad: [string, Record<string, unknown>, RegExp][] = [
		[
			'a kind that draws no actions',
			{ kind: 'pin', source: { type: 'file', path: '/a' }, actions: [look] },
			/draws no actions/,
		],
		['a `for` with no actions', { actions: [], for: 'mira' }, /no actions/],
		['nine actions', { actions: many(9) }, /9 actions/],
		['an action id twice', { actions: [look, look] }, /"look" twice/],
		['a bad action id', { actions: [{ id: 'Look', label: 'L' }] }, /not an action id/],
		['a label of two lines', { actions: [{ id: 'a', label: 'a\nb' }] }, /one line/],
		[
			'a label over 40 characters',
			{ actions: [{ id: 'a', label: 'x'.repeat(41) }] },
			/41 characters/,
		],
		['a bad person', { for: 'Mira' }, /not a person name/],
		[
			'nine fields',
			{
				actions: [
					{
						id: 'a',
						label: 'A',
						fields: Array.from({ length: 9 }, (_, i) => ({
							name: `f${i}`,
							label: 'F',
							type: 'boolean',
						})),
					},
				],
			},
			/9 fields/,
		],
		[
			'a field name twice',
			{
				actions: [
					{
						id: 'a',
						label: 'A',
						fields: [
							{ name: 'f', label: 'F', type: 'boolean' },
							{ name: 'f', label: 'G', type: 'boolean' },
						],
					},
				],
			},
			/"f" twice/,
		],
		['a bad field name', { actions: [field({ name: 'F' })] }, /not a field name/],
		['a field label over 40 characters', { actions: [field({ label: 'x'.repeat(41) })] }, /41/],
		['a choice with no option', { actions: [field({ type: 'choice', options: [] })] }, /0 options/],
		[
			'a choice with eleven options',
			{
				actions: [
					field({ type: 'choice', options: Array.from({ length: 11 }, (_, i) => `o${i}`) }),
				],
			},
			/11 options/,
		],
		['an option twice', { actions: [field({ type: 'choice', options: ['a', 'a'] })] }, /"a" twice/],
		[
			'an option over 40 characters',
			{ actions: [field({ type: 'choice', options: ['x'.repeat(41)] })] },
			/41/,
		],
		['a min above its max', { actions: [field({ type: 'number', min: 5, max: 1 })] }, /min above/],
	];

	it.each(bad)('refuses %s', async (_label, args, cause) => {
		const { show, bundle } = await gallery();
		await refusal(show(args), cause);
		expect(bundle.tools).toHaveLength(2);
	});

	it('refuses an unknown field type and an unknown key at the schema', async () => {
		const { show } = await gallery();
		await expect(show({ actions: [field({ type: 'date' })] })).rejects.toThrow(/Invalid arguments/);
		await expect(show({ actions: [{ id: 'a', label: 'A', extra: 1 }] })).rejects.toThrow(
			/Invalid arguments/,
		);
	});
});
