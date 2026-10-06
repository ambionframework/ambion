import { BoxRenderable, type KeyEvent } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { describe, expect, it } from 'vitest';
import { ActionPad } from '../src/action-state.ts';
import { type KeyParts, Keys } from '../src/keys.ts';
import type { Pin } from '../src/pins.ts';
import { PinsPanel } from '../src/pins-panel.ts';
import { started } from './fake-host.ts';

const pin = (name: string, extra: Partial<Pin> = {}): Pin => ({
	room: 'bringup',
	name,
	title: undefined,
	kind: 'markdown',
	author: 'assistant',
	path: `/shared/${name}.md`,
	problem: 'The file did not read.',
	revision: `${name}-r1`,
	rev: 1,
	actions: [],
	...extra,
});

describe('PinsPanel actions', () => {
	it('draws each action as a button under its pin, with its form, its answer, and the hints', async () => {
		const setup = await createTestRenderer({ width: 70, height: 40 });
		const pad = new ActionPad({
			send: async () => ({ kind: 'sent', seq: 1 }),
			person: () => 'mira',
			stopped: () => false,
			changed: () => {},
		});
		const panel = new PinsPanel(setup.renderer, pad);
		// The side area sits in a row that has the height of the terminal, as in the terminal.
		const body = new BoxRenderable(setup.renderer, {
			flexDirection: 'row',
			width: '100%',
			height: '100%',
		});
		body.add(panel.root);
		setup.renderer.root.add(body);
		const asked = pin('ask', {
			for: 'mira',
			actions: [
				{ id: 'keep', label: 'Keep it', once: true },
				{
					id: 'rate',
					label: 'Rate it',
					fields: [{ name: 'count', label: 'Count', type: 'number', min: 1, max: 5 }],
				},
			],
		});
		const done = pin('done', {
			actions: [{ id: 'ok', label: 'Approve', once: true }],
			answered: { seq: 12, by: 'theo' },
		});
		const list = { pins: [asked, done, pin('plain')], more: 0 };
		const draw = async () => {
			pad.sync(list.pins);
			panel.draw(list, true, false);
			// Wrapped lines take their height at the layout pass after the content changes.
			await setup.renderOnce();
			await setup.renderOnce();
			return setup.captureCharFrame();
		};

		let frame = await draw();
		expect(frame).toContain('for mira');
		expect(frame).toContain('[ Keep it ]');
		expect(frame).toContain('[ Rate it ]');
		expect(frame).toContain('answered by theo in #12');
		expect(frame).toContain('✓ Approve  done');
		expect(frame).not.toContain('Up/Down choose');

		pad.enter();
		pad.key({ name: 'down', sequence: '' });
		pad.key({ name: 'return', sequence: '' });
		pad.key({ name: '3', sequence: '3' });
		frame = await draw();
		expect(frame).toContain('Count (min 1, max 5):');
		expect(frame).toContain('3▌');
		expect(frame).toContain('Enter send');
		pad.key({ name: 'escape', sequence: '' });
		expect(await draw()).toContain('Enter press   Esc leave');
		setup.renderer.destroy();
	});
});

describe('the keys of the actions', () => {
	it('takes the actions from browse mode, sends a press, and leaves on Esc', async () => {
		const { session } = await started();
		const sent: string[] = [];
		const pad = new ActionPad({
			send: async (_person, act) => {
				sent.push(act.action);
				return { kind: 'sent', seq: 5 };
			},
			person: () => 'mira',
			stopped: () => false,
			changed: () => {},
		});
		const log: string[] = [];
		const keys = new Keys({
			renderer: { width: 120 },
			session,
			composer: { blur: () => log.push('blur'), focus: () => log.push('focus') },
			painter: { invalidate: () => {} },
			pad,
			render: () => {},
		} as unknown as KeyParts);
		const press = (name: string) =>
			keys.onKey({ name, ctrl: false, meta: false, sequence: '', preventDefault() {} } as KeyEvent);

		keys.mode = 'browse';
		keys.reconcile();
		press('a');
		expect(keys.mode).toBe('browse');
		expect(session.notice).toBe('No pinned widget has actions to press.');

		session.pins = {
			pins: [pin('ask', { actions: [{ id: 'keep', label: 'Keep it' }] })],
			more: 0,
		};
		keys.reconcile();
		press('a');
		expect(keys.mode).toBe('actions');
		press('return');
		expect(sent).toEqual(['keep']);
		press('escape');
		expect(keys.mode).toBe('compose');
		expect(log).toEqual(['blur', 'focus']);

		// A pin that loses its actions takes the person out of the actions.
		keys.mode = 'browse';
		press('a');
		session.pins = { pins: [pin('ask')], more: 0 };
		keys.reconcile();
		expect(keys.mode).toBe('compose');
	});
});
