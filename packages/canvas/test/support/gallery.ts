import type { Script } from '@ambionframework/ambion/testing';
import type { JournalOpener } from '@ambionframework/journal';
import { expect } from 'vitest';
import type { CanvasEvent, CanvasStore, WidgetKind } from '../../src/index.ts';
import { callOf, contextOf, host, tooled } from './host.ts';

export const kinds: readonly WidgetKind[] = [
	{
		name: 'frame',
		description: 'The newest frame of a process.',
		sources: ['process'],
		actions: true,
	},
	{ name: 'pin', description: 'A pinned document.', sources: ['file', 'snapshot'], actions: false },
	{ name: 'note', description: 'A line of text.', sources: [], actions: false },
];

export const statusSource = { type: 'process', handle: 'bash-1', path: '/status' } as const;

export const refusal = (promise: Promise<unknown>, cause?: RegExp) =>
	expect(promise).rejects.toMatchObject({
		name: 'AmbionError',
		code: 'refused',
		...(cause === undefined ? {} : { message: expect.stringMatching(cause) }),
	});

/** A canvas with the root room `site`, an agent that holds the widget bundle, and its calls. */
export async function gallery(
	options: { store?: CanvasStore; storage?: JournalOpener; script?: Script } = {},
) {
	const context = host({
		widgets: { kinds },
		breakout: { team: ['cy'] },
		...(options.store === undefined ? {} : { store: options.store }),
		...(options.storage === undefined ? {} : { storage: options.storage }),
		...(options.script === undefined ? {} : { script: options.script }),
	});
	const { canvas } = context;
	const bundle = canvas.widgetTools();
	const agents = [tooled('ada', bundle), tooled('bob', bundle), tooled('cy', bundle)];
	const events: CanvasEvent[] = [];
	canvas.subscribe((event) => void events.push(event));
	await canvas.resume({ agents });
	const site = await canvas.open({ name: 'site', goal: 'Plan.', agents: ['ada', 'bob'] });
	let count = 0;
	const call = (
		agent: string,
		tool: string,
		args: Record<string, unknown>,
		room = 'site',
		extra: Parameters<typeof contextOf>[3] = {},
	) => callOf(bundle, tool, args, contextOf(agent, room, `call-${++count}`, extra));
	const show = (args: Record<string, unknown> = {}, agent = 'ada') =>
		call(agent, 'show', { name: 'status', kind: 'frame', source: statusSource, ...args });
	const widgetEvents = () => events.flatMap((event) => (event.type === 'widget' ? [event] : []));
	return { ...context, site, bundle, agents, call, show, widgetEvents };
}
