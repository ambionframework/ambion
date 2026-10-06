import type { CanvasWidget, WidgetAct, WidgetActResult } from '@ambionframework/canvas';
import { describe, expect, it, vi } from 'vitest';
import {
	ActionPad,
	type ActionWidget,
	actionWidget,
	checkForm,
	type KeyInput,
	type Row,
} from '../src/action-state.ts';

const FIELDS = [
	{ name: 'note', label: 'Note', type: 'text' },
	{ name: 'count', label: 'Count', type: 'number', min: 1, max: 5 },
	{ name: 'urgent', label: 'Urgent', type: 'boolean' },
	{ name: 'color', label: 'Color', type: 'choice', options: ['red', 'blue'] },
] as const;

const widget = (revision: string, extra: Partial<ActionWidget> = {}): ActionWidget => ({
	room: 'bringup',
	name: 'plan',
	revision,
	rev: Number(revision.slice(1)),
	actions: [
		{ id: 'keep', label: 'Keep it', once: true },
		{ id: 'rate', label: 'Rate it', fields: FIELDS },
	],
	...extra,
});

/** A pad on a recorded `send`. `results` answers the calls in order; a rejection is an Error. */
function padOn(results: (WidgetActResult | Error)[] = []) {
	const sent: WidgetAct[] = [];
	const redraws = vi.fn();
	const pad = new ActionPad(async (act) => {
		sent.push(act);
		const result = results.shift() ?? { kind: 'sent' as const, seq: 7 };
		if (result instanceof Error) throw result;
		return result;
	}, redraws);
	return { pad, sent, redraws };
}

const press = (name: string, sequence = ''): KeyInput => ({ name, sequence });
const type = (pad: ActionPad, text: string) => {
	for (const char of text) pad.key(press(char === ' ' ? 'space' : char, char));
};
const labels = (rows: Row[]) =>
	rows.map((row) => (row.type === 'note' ? row.text : `${row.type}:${row.label}`));

describe('checkForm', () => {
	it.each([
		['an empty text', { note: '' }, 'Note needs 1 to 200 characters.', 0],
		['an empty number', { note: 'a', count: '' }, 'Count needs a number.', 1],
		['a word for a number', { note: 'a', count: 'two' }, 'Count needs a number.', 1],
		['a number below its min', { note: 'a', count: '0' }, 'Count must be at least 1.', 1],
		['a number above its max', { note: 'a', count: '6' }, 'Count must be at most 5.', 1],
	])('refuses %s', (_name, typed, problem, at) => {
		const drafts = FIELDS.map((field) => ({
			field,
			text: (typed as Record<string, string>)[field.name] ?? '',
			on: false,
			pick: 0,
		}));
		expect(checkForm(FIELDS, drafts)).toEqual({ problem, at });
	});

	it('gives each value its type', () => {
		const drafts = FIELDS.map((field) => ({
			field,
			text: field.name === 'count' ? ' 3.5 ' : 'ok',
			on: true,
			pick: 1,
		}));
		expect(checkForm(FIELDS, drafts)).toEqual({
			values: { note: 'ok', count: 3.5, urgent: true, color: 'blue' },
		});
	});
});

describe('ActionPad', () => {
	it('moves between actions, opens a form, and keeps the typed values until it sends', async () => {
		const { pad, sent } = padOn();
		pad.sync([widget('r1', { for: 'mira' })]);
		expect(pad.enter()).toBe(true);
		expect(labels(pad.rows('plan'))).toEqual(['for mira', 'button:Keep it', 'button:Rate it']);

		pad.key(press('down'));
		pad.key(press('return'));
		expect(labels(pad.rows('plan')).slice(2)).toEqual([
			'button:Rate it',
			'field:Note',
			'field:Count (min 1, max 5)',
			'field:Urgent',
			'field:Color',
		]);

		// An empty form shows the first problem and sends nothing.
		await pad.submit();
		expect(sent).toEqual([]);
		expect(pad.rows('plan').at(-1)).toMatchObject({ type: 'note', tone: 'error' });

		type(pad, 'ab');
		pad.key(press('backspace'));
		pad.key(press('down'));
		type(pad, 'x4');
		pad.key(press('down'));
		pad.key(press('space'));
		pad.key(press('down'));
		pad.key(press('right'));
		const fields = pad.rows('plan').filter((row) => row.type === 'field');
		expect(fields.map((row) => row.value)).toEqual(['a', '4', '[x]', '‹ blue ›']);

		await pad.submit();
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			room: 'bringup',
			widget: 'plan',
			revision: 'r1',
			action: 'rate',
			values: { note: 'a', count: 4, urgent: true, color: 'blue' },
		});
		expect(pad.rows('plan').at(-1)).toEqual({ type: 'note', text: 'Sent as #7.', tone: 'info' });
	});

	it('reuses the press token after a failure and makes a new one after the call settles', async () => {
		const { pad, sent } = padOn([new Error('The connection dropped.'), { kind: 'sent', seq: 8 }]);
		pad.sync([widget('r1')]);
		pad.enter();

		await pad.press();
		expect(pad.rows('plan').at(-1)).toMatchObject({
			text: 'The connection dropped. Press again to retry.',
			tone: 'error',
		});
		await pad.press();
		expect(sent).toHaveLength(2);
		expect(sent[1]?.press).toBe(sent[0]?.press);
		expect(sent[0]?.values).toBeUndefined();

		await pad.press();
		expect(sent[2]?.press).not.toBe(sent[0]?.press);
	});

	it('draws a once action as done once its widget is answered, and sends nothing for it', async () => {
		const { pad, sent } = padOn();
		pad.sync([widget('r1', { answered: { seq: 3, by: 'mira' } })]);
		pad.enter();
		expect(pad.rows('plan').slice(0, 2)).toEqual([
			{ type: 'note', text: 'answered by mira in #3', tone: 'info' },
			{ type: 'button', label: 'Keep it', focused: true, done: true },
		]);
		await pad.press();
		expect(sent).toEqual([]);
		expect(pad.rows('plan').at(-1)).toMatchObject({ text: 'This was answered by mira in #3.' });
	});

	it('draws a stale result with the new revision, and an answered result as a line', async () => {
		const newer: CanvasWidget = {
			room: 'bringup',
			name: 'plan',
			revision: 'r2',
			rev: 2,
			state: 'shown',
			kind: 'markdown',
			author: 'assistant',
			actions: [{ id: 'keep', label: 'Keep it now' }],
		};
		const { pad } = padOn([
			{ kind: 'stale', widget: newer },
			{ kind: 'answered', seq: 9 },
		]);
		pad.sync([widget('r1')]);
		pad.enter();
		await pad.press();
		expect(labels(pad.rows('plan'))).toEqual([
			'button:Keep it now',
			'This widget changed. Press again.',
		]);
		// The host read of the new revision replaces the result, and the focus stays on the action.
		pad.sync([actionWidget(newer)]);
		await pad.press();
		expect(pad.rows('plan').at(-1)).toMatchObject({ text: 'Already answered in #9.' });
	});

	it('drops the form and the focus with the widget, and leaves when no action remains', () => {
		const { pad } = padOn();
		pad.sync([widget('r1')]);
		pad.enter();
		pad.key(press('down'));
		pad.key(press('return'));
		pad.sync([widget('r2')]);
		expect(pad.rows('plan').some((row) => row.type === 'field')).toBe(false);
		pad.sync([widget('r2', { actions: [] })]);
		expect(pad.active).toBe(false);
		expect(pad.enter()).toBe(false);
		expect(pad.rows('plan')).toEqual([]);
	});

	it('leaves on Esc, closes a form first, and ignores control keys', () => {
		const { pad } = padOn();
		pad.sync([widget('r1')]);
		pad.enter();
		pad.key(press('down'));
		pad.key(press('return'));
		expect(pad.hint().join('\n')).toContain('Enter send');
		expect(pad.key({ name: 'q', sequence: 'q', ctrl: true })).toBeUndefined();
		expect(pad.key(press('escape'))).toBeUndefined();
		expect(pad.hint().join('\n')).toContain('Esc leave');
		expect(pad.key(press('escape'))).toBe('leave');
	});
});
