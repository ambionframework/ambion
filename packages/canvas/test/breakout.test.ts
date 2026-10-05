import { definePerson, readRoom, startRoom } from '@ambionframework/ambion';
import { byAgent, callTool, type Script, settled } from '@ambionframework/ambion/testing';
import { memoryBackend } from '@ambionframework/just-bash';
import { openWorkspace } from '@ambionframework/workspace';
import { describe, expect, it } from 'vitest';
import type { CanvasRoom } from '../src/index.ts';
import {
	breakoutRow,
	callOf,
	contextOf,
	cy,
	host,
	live,
	statesOf,
	tooled,
} from './support/host.ts';

const rootRow = (): CanvasRoom => ({
	name: 'site',
	goal: 'Plan.',
	depth: 0,
	state: 'running',
	start: { kind: 'root' },
});

const refusal = (promise: Promise<unknown>, cause?: RegExp) =>
	expect(promise).rejects.toMatchObject({
		name: 'AmbionError',
		code: 'refused',
		...(cause === undefined ? {} : { message: expect.stringMatching(cause) }),
	});

/** A canvas with two openers, two workers, and the root room `site`. */
async function lab(
	options: {
		perOpener?: number;
		script?: Script;
		seats?: Record<string, 'broadcast' | 'none'>;
		workspace?: boolean;
	} = {},
) {
	const workspace = options.workspace
		? openWorkspace({ name: 'lab', backend: { bash: memoryBackend() }, rooms: true })
		: undefined;
	const context = host({
		breakout: {
			team: ['cy', 'dan'],
			...(options.perOpener === undefined ? {} : { perOpener: options.perOpener }),
		},
		...(options.script === undefined ? {} : { script: options.script }),
		...(workspace === undefined ? {} : { workspace }),
	});
	const { canvas } = context;
	const opener = canvas.tools();
	const worker = canvas.workerTools();
	const agents = [
		tooled('ada', opener),
		tooled('bob', opener),
		tooled('cy', worker),
		tooled('dan', worker),
	];
	await canvas.resume({ agents });
	const site = await canvas.open({
		name: 'site',
		goal: 'Plan.',
		...(options.seats === undefined ? {} : { seats: options.seats }),
	});
	let count = 0;
	/** One tool call of `agent` in `room`, as an activation gives it. */
	const call = (
		agent: string,
		tool: string,
		args: Record<string, unknown>,
		room = 'site',
		extra: Parameters<typeof contextOf>[3] = {},
	) =>
		callOf(
			tool === 'report' ? worker : opener,
			tool,
			args,
			contextOf(agent, room, `call-${++count}`, extra),
		);
	const open = (name = 'survey', extra: Record<string, unknown> = {}) =>
		call('ada', 'breakout', {
			name,
			goal: 'Survey the options.',
			message: 'Survey it.',
			agents: ['cy'],
			...extra,
		});
	const posted = async (name: string) =>
		(await live(canvas, name).read()).messages.flatMap((m) => (m.kind === 'posted' ? [m] : []));
	return { ...context, site, opener, worker, call, open, posted, agents };
}

describe('breakout', () => {
	it('opens a room with a goal and a message, and gives the mirror path', async () => {
		const { canvas, open, store, posted } = await lab({ workspace: true });
		const result = await open();
		expect(result).toMatchObject({
			room: 'site-survey',
			uri: 'ambion://room/site-survey',
			state: 'running',
			created: true,
			mirror: expect.stringContaining('site-survey'),
		});
		const room = live(canvas, 'site-survey');
		const read = await room.read({ messages: false });
		expect(read.goal).toBe('Survey the options.');
		expect(read.participants).toMatchObject([{ name: 'cy', attention: 'broadcast' }]);
		expect(read.reserve).toEqual([]);
		expect(await posted('site-survey')).toMatchObject([
			{ text: 'Survey it.', key: 'breakout-start:site-survey' },
		]);
		expect(await store.list()).toMatchObject([
			{ name: 'site', depth: 0 },
			{
				name: 'site-survey',
				depth: 1,
				state: 'running',
				start: { kind: 'breakout', parent: 'site', opener: 'ada', agents: ['cy'] },
			},
		]);
	});

	it('posts the first message to one worker when `to` names it', async () => {
		const { open, posted } = await lab();
		await open('pair', { agents: ['cy', 'dan'], to: 'dan' });
		expect(await posted('site-pair')).toMatchObject([{ to: 'dan' }]);
	});

	it('returns the same room on a repeat, posts nothing, and ignores the other parameters', async () => {
		const { open, posted, canvas, call } = await lab({ perOpener: 1 });
		const first = await open();
		const again = await open('survey', { goal: 'Other.', message: 'Other.', agents: ['dan'] });
		expect(again).toEqual({ ...(first as object), created: false });
		expect(await posted('site-survey')).toHaveLength(1);
		await canvas.stop('site-survey');
		const stopped = await open();
		expect(stopped).toMatchObject({ state: 'stopped', created: false });
		expect(canvas.room('site-survey')).toBeUndefined();
		await canvas.start('site-survey');
		await call('ada', 'archive', { room: 'site-survey', result: 'failed', note: 'No use.' });
		expect(await open()).toMatchObject({
			state: 'archived',
			created: false,
			close: { result: 'failed', note: 'No use.' },
		});
	});

	it.each([
		['a name that breaks the syntax', { name: 'Bad Name' }, /not a room name/],
		['an empty name', { name: '' }, /not a room name/],
		['a name that makes the room name too long', { name: 'x'.repeat(44) }, /49 characters.*48/],
		['no agents', { agents: [] }, /names no worker/],
		['an agent outside the team', { agents: ['ada'] }, /"ada" is not in the worker team/],
		['an agent twice', { agents: ['cy', 'cy'] }, /"cy" twice/],
	])('refuses %s', async (_label, extra, cause) => {
		const { open, store } = await lab();
		await refusal(open('survey', extra), cause);
		expect((await store.list()).map((row) => row.name)).toEqual(['site']);
	});

	it('refuses a name that another opener or a root room holds', async () => {
		const { open, call, canvas } = await lab();
		await open();
		await refusal(
			call('bob', 'breakout', { name: 'survey', goal: 'G', message: 'M', agents: ['cy'] }),
			/another opener/,
		);
		await canvas.open({ name: 'site-docs', goal: 'Write.' });
		await refusal(open('docs'), /another opener or to a root room/);
	});

	it('refuses an open past perOpener, and an archive frees a place', async () => {
		const { open, call, canvas, errors } = await lab({ perOpener: 2 });
		await open('one');
		await open('two');
		await refusal(open('three'), /perOpener is 2/);
		await call('bob', 'breakout', { name: 'mine', goal: 'G', message: 'M', agents: ['cy'] });
		await call('ada', 'archive', { room: 'site-one', result: 'done' });
		await open('three');
		expect(canvas.rooms().filter((row) => row.state === 'running')).toHaveLength(4);
		expect(errors).toEqual([]);
	});

	it('refuses a call from a breakout room, from an unknown room, and with no room', async () => {
		const { open, call } = await lab();
		await open();
		const args = { name: 'deeper', goal: 'G', message: 'M', agents: ['cy'] };
		await refusal(call('ada', 'breakout', args, 'site-survey'), /depth is one/);
		await refusal(call('ada', 'breakout', args, 'elsewhere'), /not on the canvas/);
		await refusal(call('ada', 'breakout', args, 'site', { room: undefined }), /no room/);
	});

	it('passes the refusal of the room for `to` through, and closes the row as failed', async () => {
		const { open, store, canvas, call } = await lab({ perOpener: 1 });
		await expect(open('survey', { to: 'ghost' })).rejects.toMatchObject({
			name: 'AmbionError',
			code: expect.stringMatching(/unknown_participant|refused/),
		});
		expect(canvas.room('site-survey')).toBeUndefined();
		expect((await store.list()).at(-1)).toMatchObject({
			state: 'archived',
			close: { result: 'failed', note: expect.stringContaining('ghost') },
		});
		expect(await open('other')).toMatchObject({ created: true });
		expect(
			await call('ada', 'breakout', { name: 'survey', goal: 'G', message: 'M', agents: ['cy'] }),
		).toMatchObject({
			state: 'archived',
			created: false,
		});
	});

	it('refuses before resume and after close', async () => {
		const { canvas, open } = await lab();
		const early = host();
		const bundle = early.canvas.tools();
		await refusal(
			callOf(
				bundle,
				'breakout',
				{ name: 'a', goal: 'G', message: 'M', agents: ['cy'] },
				contextOf('ada', 'site', 'early'),
			),
			/needs resume/,
		);
		await canvas.close();
		await refusal(open(), /closed/);
	});
});

describe('the start of a row', () => {
	it('starts a row that has no journal, and posts the start under its key', async () => {
		const { canvas, store, errors } = host();
		await store.insert(rootRow());
		await store.insert(breakoutRow('site-a', 'site'));
		await canvas.resume({ agents: [tooled('ada', canvas.tools()), cy] });
		const read = await live(canvas, 'site-a').read();
		expect(read.messages.filter((m) => m.kind === 'posted')).toMatchObject([
			{ text: 'Start.', key: 'breakout-start:site-a' },
		]);
		expect(errors).toEqual([]);
	});

	it('posts the start once for a journal that has the room and no post', async () => {
		const first = host();
		await first.store.insert(rootRow());
		await first.store.insert(breakoutRow('site-a', 'site'));
		await startRoom({ name: 'site-a', agents: [cy], runtime: first.runtime }).then((room) =>
			room.stop(),
		);
		for (let run = 0; run < 2; run++) {
			const next = host({ store: first.store, storage: first.storage });
			await next.canvas.resume({ agents: [tooled('ada', next.canvas.tools()), cy] });
			const read = await live(next.canvas, 'site-a').read();
			expect(read.messages.filter((m) => m.kind === 'posted')).toHaveLength(1);
			await next.canvas.close();
		}
	});

	it('starts no archived room, and keeps its journal readable', async () => {
		const first = host();
		await first.store.insert(rootRow());
		await first.store.insert(breakoutRow('site-a', 'site'));
		await startRoom({ name: 'site-a', agents: [cy], runtime: first.runtime }).then(async (room) => {
			await room.post({ text: 'Start.', key: 'breakout-start:site-a' });
			await room.stop();
		});
		await first.store.archive('site-a', { result: 'done' });
		const next = host({ store: first.store, storage: first.storage });
		await next.canvas.resume({ agents: [tooled('ada', next.canvas.tools()), cy] });
		expect(next.canvas.room('site-a')).toBeUndefined();
		const read = await readRoom('site-a', { runtime: next.runtime });
		expect(read.messages.some((m) => m.kind === 'posted')).toBe(true);
	});
});

describe('tell', () => {
	it('steers a worker, lands once for one call, and opens a new exchange after one closes', async () => {
		const { open, call, canvas } = await lab();
		await open();
		const room = live(canvas, 'site-survey');
		await settled(room);
		const ctx = contextOf('ada', 'site', 'tell-1');
		const tool = canvas.tools();
		const first = await callOf(tool, 'tell', { room: 'site-survey', text: 'Narrow it.' }, ctx);
		const again = await callOf(tool, 'tell', { room: 'site-survey', text: 'Narrow it.' }, ctx);
		expect(again).toEqual(first);
		await settled(room);
		const read = await room.read();
		expect(
			read.messages.filter((m) => m.kind === 'posted' && m.text === 'Narrow it.'),
		).toHaveLength(1);
		expect(read.exchanges.filter((e) => e.status === 'closed')).toHaveLength(2);
		expect(
			await call('ada', 'tell', { room: 'site-survey', text: 'More.', to: 'cy' }),
		).toMatchObject({
			room: 'site-survey',
		});
	});

	it('passes the refusal of the room for `to` through', async () => {
		const { open, call } = await lab();
		await open();
		await expect(
			call('ada', 'tell', { room: 'site-survey', text: 'Hi.', to: 'dan' }),
		).rejects.toMatchObject({
			name: 'AmbionError',
		});
	});

	it('refuses a room that the caller did not open, an archived room, and a stopped room', async () => {
		const { open, call, canvas } = await lab();
		await open('one');
		await open('two');
		await open('three');
		await canvas.open({ name: 'docs', goal: 'Write.' });
		const tell = (room: string, agent = 'ada') => call(agent, 'tell', { room, text: 'Hi.' });
		await refusal(tell('site-one', 'bob'), /did not open/);
		await refusal(tell('docs'), /root room/);
		await refusal(tell('ghost'), /no room/);
		await call('ada', 'archive', { room: 'site-one', result: 'done' });
		await refusal(tell('site-one'), /archived/);
		await canvas.stop('site-two');
		await refusal(tell('site-two'), /stopped/);
		await canvas.stop('site');
		await canvas.start('site');
		await call('ada', 'tell', { room: 'site-three', text: 'Still here.' }, 'site');
	});

	it('refuses a running row that has no live handle, and a repeat open tries the start again', async () => {
		const { canvas, store, errors } = host();
		await store.insert(rootRow());
		await store.insert(breakoutRow('site-bad', 'site', ['ghost']));
		const opener = tooled('ada', canvas.tools());
		await canvas.resume({ agents: [opener, cy] });
		expect(canvas.room('site-bad')).toBeUndefined();
		expect(errors).toMatchObject([{ room: 'site-bad', operation: 'resume' }]);
		const ctx = contextOf('ada', 'site', 'late');
		await refusal(
			callOf(canvas.tools(), 'tell', { room: 'site-bad', text: 'Hi.' }, ctx),
			/no live handle/,
		);
		await expect(
			callOf(
				canvas.tools(),
				'breakout',
				{ name: 'bad', goal: 'G', message: 'M', agents: ['cy'] },
				ctx,
			),
		).rejects.toMatchObject({ code: 'refused' });
		expect(errors.map((e) => e.operation)).toEqual(['resume', 'breakout']);
	});
});

describe('archive', () => {
	it('records the result, stops the room, and returns it again on a repeat', async () => {
		const { open, call, canvas, store } = await lab();
		await open();
		const done = await call('ada', 'archive', {
			room: 'site-survey',
			result: 'done',
			note: 'Found it.',
		});
		expect(done).toEqual({ room: 'site-survey', result: 'done', note: 'Found it.' });
		expect(canvas.room('site-survey')).toBeUndefined();
		expect(await call('ada', 'archive', { room: 'site-survey', result: 'failed' })).toEqual(done);
		expect(await statesOf(store)).toMatchObject({ 'site-survey': 'archived' });
	});

	it('refuses the room of another opener, a root room, and an unknown room', async () => {
		const { open, call } = await lab();
		await open();
		const archive = (room: string, agent = 'ada') =>
			call(agent, 'archive', { room, result: 'done' });
		await refusal(archive('site-survey', 'bob'), /did not open/);
		await refusal(archive('site'), /root room/);
		await refusal(archive('ghost'), /no room/);
	});

	it('records the close of a stopped row, and stops nothing', async () => {
		const { open, call, canvas } = await lab();
		await open();
		await canvas.stop('site-survey');
		await call('ada', 'archive', { room: 'site-survey', result: 'failed' });
		expect(canvas.rooms().find((row) => row.name === 'site-survey')).toMatchObject({
			state: 'archived',
		});
	});

	it('runs a tell and an archive on one room in order', async () => {
		const { open, call, canvas } = await lab();
		await open();
		const tell = call('ada', 'tell', { room: 'site-survey', text: 'Last word.' });
		const archive = call('ada', 'archive', { room: 'site-survey', result: 'done' });
		await expect(tell).resolves.toMatchObject({ room: 'site-survey' });
		await archive;
		await refusal(call('ada', 'tell', { room: 'site-survey', text: 'Too late.' }), /archived/);
		const late = call('ada', 'archive', { room: 'site-survey', result: 'done' });
		await late;
		expect(canvas.room('site-survey')).toBeUndefined();
	});

	it('refuses every tool call after close', async () => {
		const { open, call, canvas } = await lab();
		await open();
		await canvas.close();
		await refusal(call('ada', 'tell', { room: 'site-survey', text: 'Hi.' }), /closed/);
		await refusal(call('ada', 'archive', { room: 'site-survey', result: 'done' }), /closed/);
		await refusal(call('cy', 'report', { text: 'Done.' }, 'site-survey'), /closed/);
	});
});

describe('report', () => {
	const reported = (name = 'site-survey') => ({
		text: `breakout ${name}: The survey is done.`,
	});

	it('reaches the opener from a worker that runs on the scripted executor', async () => {
		const script: Script = byAgent({
			ada: (_step, _seat, request) =>
				request === 1
					? callTool('breakout', {
							name: 'survey',
							goal: 'Survey.',
							message: 'Survey it.',
							agents: ['cy'],
						})
					: [],
			cy: (_step, _seat, request) =>
				request === 1 ? callTool('report', { text: 'The survey is done.' }) : [],
		});
		const { site, canvas } = await lab({ script });
		await site.post({ to: 'ada', text: 'Start a survey.' });
		await settled(site);
		await settled(live(canvas, 'site-survey'));
		const messages = (await site.read()).messages.flatMap((m) => (m.kind === 'posted' ? [m] : []));
		expect(messages.slice(1)).toMatchObject([
			{
				to: 'ada',
				...reported(),
				key: expect.stringMatching(/^breakout:site-survey:\d+:report:/),
			},
		]);
	});

	it('goes to the opener at an attention above none', async () => {
		const { open, call, site } = await lab();
		await open();
		const first = await call('cy', 'report', { text: 'Done.' }, 'site-survey', {
			exchange: { from: 7 },
		});
		expect(first).toMatchObject({ room: 'site', to: 'ada' });
		const read = await site.read();
		expect(read.messages.at(-1)).toMatchObject({
			kind: 'posted',
			to: 'ada',
			text: 'breakout site-survey: Done.',
			key: 'breakout:site-survey:7:report:call-2',
		});
	});

	it('has no `to` when the opener is at none', async () => {
		const { open, call, site } = await lab({ seats: { ada: 'none', bob: 'broadcast' } });
		await open();
		const result = await call('cy', 'report', { text: 'Done.' }, 'site-survey');
		expect(result).not.toHaveProperty('to');
		expect((await site.read()).messages.at(-1)).not.toHaveProperty('to');
	});

	it('has no `to` when the opener left the roster, and counts a key conflict as landed', async () => {
		const { open, site, worker } = await lab();
		await open();
		const ctx = contextOf('cy', 'site-survey', 'same-call');
		const first = await callOf(worker, 'report', { text: 'Done.' }, ctx);
		expect(first).toMatchObject({ to: 'ada' });
		await site.unseat('ada');
		const second = await callOf(worker, 'report', { text: 'Done.' }, ctx);
		expect(second).toMatchObject({ room: 'site', from: (first as { from: number }).from });
		const fresh = await callOf(
			worker,
			'report',
			{ text: 'Other.' },
			contextOf('cy', 'site-survey', 'next'),
		);
		expect(fresh).not.toHaveProperty('to');
		const posts = (await site.read()).messages.filter((m) => m.kind === 'posted');
		expect(posts).toHaveLength(2);
	});

	it('refuses a root room, a call with no exchange, an archived room, and a stopped room', async () => {
		const { open, call, canvas } = await lab();
		await open('one');
		await open('two');
		await open('three');
		await refusal(call('cy', 'report', { text: 'x' }, 'site'), /not a breakout room/);
		await refusal(
			call('cy', 'report', { text: 'x' }, 'site-one', { exchange: undefined }),
			/inside the exchange/,
		);
		await call('ada', 'archive', { room: 'site-one', result: 'done' });
		await refusal(call('cy', 'report', { text: 'x' }, 'site-one'), /archived/);
		await canvas.stop('site-two');
		await refusal(call('cy', 'report', { text: 'x' }, 'site-two'), /stopped/);
		await canvas.stop('site');
		await refusal(
			call('cy', 'report', { text: 'x' }, 'site-three'),
			/parent "site" is not running/,
		);
	});

	it('gives a worker no opener bundle', async () => {
		const { opener, worker } = await lab();
		expect(opener.tools.map((tool) => tool.name)).toEqual(['breakout', 'tell', 'archive']);
		expect(worker.tools.map((tool) => tool.name)).toEqual(['report']);
		expect(worker.remind).toBeUndefined();
	});
});

describe('the reminder', () => {
	const seat = { agent: 'ada', room: 'site', activation: 'act-1' };
	const remind = (bundle: { remind?: (...args: never[]) => unknown }, who = seat) =>
		(bundle.remind as (s: typeof seat, signal: AbortSignal) => Promise<string | undefined>)(
			who,
			new AbortController().signal,
		);

	it('gives no text for a seat with no breakout room', async () => {
		const { opener } = await lab();
		expect(await remind(opener)).toBeUndefined();
	});

	it('lists a running room and a stopped room, and omits an archived room', async () => {
		const { opener, open, call, canvas } = await lab();
		await open('one');
		await open('two');
		await open('three');
		await settled(live(canvas, 'site-one'));
		await canvas.stop('site-two');
		await call('ada', 'archive', { room: 'site-three', result: 'done' });
		const text = await remind(opener);
		expect(text).toMatch(
			/^Your breakout rooms:\n- site-one: running, no exchange open, last message #\d+\n- site-two: stopped$/,
		);
		expect(await remind(opener, { ...seat, agent: 'bob' })).toBeUndefined();
		expect(await remind(opener, { ...seat, room: 'docs' })).toBeUndefined();
	});

	it('names the open exchange and the last message', async () => {
		const { opener, open, canvas } = await lab({
			script: () => new Promise(() => {}),
		});
		await open('one');
		const read = await live(canvas, 'site-one').read();
		const last = read.messages.at(-1)?.seq;
		expect(await remind(opener)).toBe(
			`Your breakout rooms:\n- site-one: running, exchange #${read.exchange?.from} open, last message #${last}`,
		);
	});

	it('lists at most ten rooms, then the rest', async () => {
		const { opener, open } = await lab({ perOpener: 12 });
		for (let n = 1; n <= 12; n++) await open(`r${n}`);
		const lines = (await remind(opener))?.split('\n') ?? [];
		expect(lines).toHaveLength(12);
		expect(lines[0]).toBe('Your breakout rooms:');
		expect(lines.at(-1)).toBe('and 2 more');
	});
});

describe('a visit', () => {
	it('lets a person visit a breakout room', async () => {
		const { open, canvas } = await lab();
		await open();
		const room = live(canvas, 'site-survey');
		const visit = await room.visit(definePerson({ name: 'priya', identity: 'Priya.' }));
		const sent = await visit.send({ text: 'How is it going?', key: 'visit-1' });
		await sent.waitForClose();
		expect((await room.read()).messages.some((m) => m.kind === 'said' || m.kind === 'posted')).toBe(
			true,
		);
	});
});
