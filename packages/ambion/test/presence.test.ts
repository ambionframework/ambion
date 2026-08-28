import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	defineAgent,
	defineHuman,
	InMemorySessionRepo,
	isSpoken,
	type Message,
	passive,
	readSession,
	type Session,
	type SessionEvent,
	startSession,
	stopSession,
	visitSession,
} from '../src/index.ts';

// -- a room that never speaks ------------------------------------------------

const contexts: string[] = [];
const prompts: string[] = [];

const quiet: StreamFn = (_model, context) => {
	prompts.push(context.systemPrompt ?? '');
	contexts.push(
		context.messages
			.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
			.join('\n'),
	);
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = fauxAssistantMessage('nothing to add', { stopReason: 'stop' });
	queueMicrotask(() => {
		stream.push({ type: 'start', partial: message });
		stream.push({ type: 'done', reason: 'stop', message });
	});
	return stream;
};

const watcher = defineAgent({
	name: 'watcher',
	identity: 'Watches the room.',
	instructions: 'stay quiet',
	model: 'scripted/watcher',
});

const andrei = defineHuman({ name: 'andrei', identity: 'Founder. Owns the weekly.' });
const mara = defineHuman({ name: 'mara', identity: 'Design lead.' });

let unique = 0;
const roomName = () => `presence-${++unique}`;

const open = (overrides: Partial<Parameters<typeof startSession>[0]> = {}) =>
	startSession({ name: roomName(), agents: [watcher], streamFn: quiet, ...overrides });

const kinds = async (session: { messages(): Promise<Message[]> }) =>
	(await session.messages()).map((m) => m.kind);

const events = (session: Session) => {
	const seen: SessionEvent[] = [];
	session.subscribe((event) => seen.push(event));
	return seen;
};

const presenceOf = (session: Session, name: string) => {
	const seat = session.seats().find((s) => s.name === name);
	return seat?.kind === 'human' ? seat.presence : undefined;
};

const started: Session[] = [];
const track = (session: Session) => {
	started.push(session);
	return session;
};

afterEach(async () => {
	vi.useRealTimers();
	for (const session of started.splice(0)) await stopSession(session);
	contexts.length = 0;
	prompts.length = 0;
});

const lastSystemPrompt = () => prompts.at(-1) ?? '';

// -- the milestone tests -----------------------------------------------------

describe('presence', () => {
	it('runs a room of agents with nobody present, and settles', async () => {
		const session = track(open());
		await session.settled();
		expect(await session.messages()).toHaveLength(0);
		expect(session.seats().filter((s) => s.kind === 'human')).toHaveLength(0);
		expect(session.visits()).toHaveLength(0);
	});

	it('commits an arrival and wakes nobody, because arrivals are quiet by default', async () => {
		const session = track(open());
		const seen = events(session);
		await visitSession(session, andrei);
		await session.settled();

		expect(await kinds(session)).toEqual(['arrived']);
		expect(seen.some((e) => e.type === 'agent_start')).toBe(false);
		expect(contexts).toHaveLength(0); // no seat was handed a context at all
	});

	it('wakes the idle room on an arrival when the room asks for it, passive seats excepted', async () => {
		const aside = defineAgent({
			name: 'aside',
			identity: 'The quiet corner.',
			instructions: 'wait',
			model: 'scripted/aside',
		});
		const session = track(open({ agents: [watcher, passive(aside)], arrivals: 'activate' }));
		const seen = events(session);
		await visitSession(session, andrei);
		await session.settled();

		const starts = seen.filter((e) => e.type === 'agent_start').map((e) => e.agent);
		expect(starts).toEqual(['watcher']);
		// the roster the woken seat read already showed the arrival
		expect(contexts.at(-1)).toContain('andrei (present');
		expect(contexts.at(-1)).toContain('· andrei arrived');
	});

	it('reaches a colleague already at work either way, because a steer is not an activation', async () => {
		const session = track(open());
		const visit = await visitSession(session, andrei);
		await visit.deliver({ text: 'start something' });
		await visitSession(session, mara); // lands while nobody is mid-turn here
		await session.settled();
		// quiet or not, the arrival is on the record for the next activation to read
		expect(await kinds(session)).toEqual(['arrived', 'said', 'arrived']);
	});

	it('carries no text on a presence message, and stamps from the visit', async () => {
		const session = track(open());
		await visitSession(session, andrei);
		await session.settled();

		const arrival = (await session.messages())[0];
		expect(arrival).toMatchObject({ kind: 'arrived', from: 'andrei' });
		expect(arrival && isSpoken(arrival)).toBe(false);
		expect(arrival && 'text' in arrival).toBe(false);
	});

	it('stamps two people from their own visits', async () => {
		const session = track(open());
		const one = await visitSession(session, andrei);
		const two = await visitSession(session, mara);
		await one.deliver({ text: 'from andrei' });
		await two.deliver({ text: 'from mara' });
		await session.settled();

		const said = (await session.messages()).filter(isSpoken);
		expect(said.map((m) => [m.from, m.text])).toEqual([
			['andrei', 'from andrei'],
			['mara', 'from mara'],
		]);
	});

	it('counts visits per person: only the first arrives and only the last leaves', async () => {
		const session = track(open());
		const seen = events(session);
		const terminal = await visitSession(session, andrei, { via: 'terminal' });
		const browser = await visitSession(session, andrei, { via: 'web' });
		await session.settled();
		expect(await kinds(session)).toEqual(['arrived']); // the second visit committed nothing
		expect(session.visits()).toHaveLength(2);
		expect(presenceOf(session, 'andrei')).toBe('present');

		await terminal.leave();
		expect(presenceOf(session, 'andrei')).toBe('present'); // still reading in the other
		expect(await kinds(session)).toEqual(['arrived']);

		await browser.leave();
		await session.settled();
		expect(presenceOf(session, 'andrei')).toBe('absent');
		expect(await kinds(session)).toEqual(['arrived', 'left']);
		// the stream carries every attachment, and names the person's status after
		const leaves = seen.filter((e) => e.type === 'visit_leave');
		expect(leaves.map((e) => e.type === 'visit_leave' && e.presence)).toEqual([
			'present',
			'absent',
		]);
	});

	it('turns a visit away on the timeout, and never with Infinity', async () => {
		vi.useFakeTimers();
		const session = track(open({ idleTimeout: 60_000 }));
		const visit = await visitSession(session, andrei);
		expect(visit.status).toBe('present');

		await vi.advanceTimersByTimeAsync(60_001);
		expect(visit.status).toBe('away');
		expect(presenceOf(session, 'andrei')).toBe('away');
		expect(await kinds(session)).toEqual(['arrived', 'away']);

		const forever = track(open({ idleTimeout: Number.POSITIVE_INFINITY }));
		const patient = await visitSession(forever, andrei);
		await vi.advanceTimersByTimeAsync(60 * 60_000);
		expect(patient.status).toBe('present');
		expect(await kinds(forever)).toEqual(['arrived']);
	});

	it('takes a timeout from the visit, then the run, then fifteen minutes', async () => {
		vi.useFakeTimers();
		const session = track(open({ idleTimeout: 60_000 }));
		const short = await visitSession(session, andrei, { idleTimeout: 1_000 });
		const house = await visitSession(session, mara);
		await vi.advanceTimersByTimeAsync(1_001);
		expect(short.status).toBe('away');
		expect(house.status).toBe('present');

		const defaulted = track(open());
		const long = await visitSession(defaulted, andrei);
		await vi.advanceTimersByTimeAsync(14 * 60_000);
		expect(long.status).toBe('present');
		await vi.advanceTimersByTimeAsync(2 * 60_000);
		expect(long.status).toBe('away');
	});

	it('turns a person away only when every visit is', async () => {
		vi.useFakeTimers();
		const session = track(open({ idleTimeout: 60_000 }));
		const first = await visitSession(session, andrei);
		const second = await visitSession(session, andrei, { idleTimeout: 10 * 60_000 });

		await vi.advanceTimersByTimeAsync(60_001);
		expect(first.status).toBe('away');
		expect(presenceOf(session, 'andrei')).toBe('present'); // the other is still reading
		expect(await kinds(session)).toEqual(['arrived']);

		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(second.status).toBe('away');
		expect(presenceOf(session, 'andrei')).toBe('away');
		expect(await kinds(session)).toEqual(['arrived', 'away']);
	});

	it('returns an away visit before the delivery it came with', async () => {
		vi.useFakeTimers();
		const session = track(open({ idleTimeout: 60_000 }));
		const visit = await visitSession(session, andrei);
		await vi.advanceTimersByTimeAsync(60_001);
		expect(await kinds(session)).toEqual(['arrived', 'away']);

		await visit.deliver({ text: 'back' });
		expect(await kinds(session)).toEqual(['arrived', 'away', 'returned', 'said']);
		expect(visit.status).toBe('present');
	});

	it('still addresses somebody who left, and remembers them across a run', async () => {
		const repo = new InMemorySessionRepo();
		const name = roomName();
		const first = startSession({ name, agents: [watcher], streamFn: quiet, repo });
		const visit = await visitSession(first, andrei);
		await visit.deliver({ text: 'noting that I was here' });
		await first.settled();
		await visit.leave();
		await first.settled();
		expect(presenceOf(first, 'andrei')).toBe('absent');
		// absent, and still on the roster the agents read
		expect(contexts.at(-1)).toContain('andrei');
		await stopSession(first);

		const again = track(startSession({ name, agents: [watcher], streamFn: quiet, repo }));
		await again.messages(); // startSession is synchronous; the replay is awaited here
		expect(presenceOf(again, 'andrei')).toBe('absent');
		expect(again.seats().find((s) => s.name === 'andrei')?.identity).toBe(andrei.identity);
	});

	it('refuses a stale visit, and takes leave() twice', async () => {
		const session = track(open());
		const visit = await visitSession(session, andrei);
		await visit.leave();
		await expect(visit.leave()).resolves.toBeUndefined();
		expect(() => visit.acted()).toThrow(/has ended/);
		await expect(visit.deliver({ text: 'hello?' })).rejects.toThrow(/has ended/);
	});

	it('anchors since at where a person stopped reading, and holds it while they read', async () => {
		vi.useFakeTimers();
		const session = track(open({ idleTimeout: 60_000 }));
		const first = await visitSession(session, andrei);
		expect(first.since).toBeUndefined(); // never been here

		await first.deliver({ text: 'before' });
		await first.leave();
		await session.settled();
		const left = (await session.messages()).find((m) => m.kind === 'left');

		const again = await visitSession(session, andrei);
		expect(again.since).toBe(left?.seq);
		await again.deliver({ text: 'after' });
		expect(again.since).toBe(left?.seq); // it does not move while they read

		await vi.advanceTimersByTimeAsync(60_001);
		const away = (await session.messages()).find((m) => m.kind === 'away');
		expect(again.since).toBe(away?.seq); // it moves when they stop
	});

	it('reads only what followed a cursor, both kinds in order', async () => {
		const session = track(open());
		const visit = await visitSession(session, andrei);
		await visit.deliver({ text: 'one' });
		await visit.leave();
		const left = (await session.messages()).find((m) => m.kind === 'left');
		const again = await visitSession(session, andrei);
		await again.deliver({ text: 'two' });
		await session.settled();

		const missed = await session.messages({ since: again.since });
		expect(missed.map((m) => m.kind)).toEqual(['arrived', 'said']);
		expect(missed.every((m) => m.seq > (left?.seq ?? 0))).toBe(true);
		expect(await session.messages()).toHaveLength(5);
	});

	it('closes its visits when the run stops, without waking anybody', async () => {
		const session = open();
		const visit = await visitSession(session, andrei);
		await session.settled();
		const seen = events(session);

		await stopSession(session);

		const view = readSession(session.name);
		expect((await view.messages()).map((m) => m.kind)).toEqual(['arrived', 'left']);
		// a turn started to hear that the room is closing is a turn nobody reads
		expect(seen.some((e) => e.type === 'agent_start')).toBe(false);
		await expect(visit.deliver({ text: 'still there?' })).rejects.toThrow();
	});

	it('reads a name that is not running, and starts nothing', async () => {
		const repo = new InMemorySessionRepo();
		const name = roomName();
		const session = startSession({ name, agents: [watcher], streamFn: quiet, repo });
		const visit = await visitSession(session, andrei);
		await visit.deliver({ text: 'for later' });
		await session.settled();
		await stopSession(session);

		const view = readSession(name, { repo });
		expect((await view.messages()).filter(isSpoken).map((m) => m.text)).toEqual(['for later']);
		// no agents stand up, and everybody the record knows is absent
		expect(view.seats()).toEqual([
			{ kind: 'human', name: 'andrei', identity: andrei.identity, presence: 'absent', visits: 0 },
		]);
	});

	it('shows an agent the goal, the clock, and what each person has not seen', async () => {
		const session = track(
			open({ goal: 'Ship payments v2 this quarter.', idleTimeout: Number.POSITIVE_INFINITY }),
		);
		const visit = await visitSession(session, andrei);
		await visit.deliver({ text: 'kicking this off' });
		await visit.leave();
		await session.settled();

		const later = await visitSession(session, mara);
		await later.deliver({ text: 'while andrei is away' });
		await session.settled();

		const back = await visitSession(session, andrei);
		await back.deliver({ text: 'what moved?' }); // quiet arrivals wake nobody
		await session.settled();
		expect(back.since).toBeDefined();

		const view = contexts.at(-1) ?? '';
		expect(view).toContain('The time is');
		expect(view).toContain('- watcher (active): Watches the room.');
		expect(view).toContain('andrei (present');
		expect(view).toContain('has not seen the last');
		expect(view).toContain('── andrei has not seen anything below this line ──');
		expect(view).toContain('while andrei is away');
	});

	it('renders the arrival paragraph only for a goal and a room that wakes', async () => {
		// a goal, but arrivals are quiet: the goal renders, the paragraph does not
		const quietRoom = track(open({ goal: 'Ship payments v2.' }));
		const qv = await visitSession(quietRoom, andrei);
		await qv.deliver({ text: 'anything' }); // quiet arrivals wake nobody, so ask
		await quietRoom.settled();
		const prompted = lastSystemPrompt();
		expect(prompted).toContain('This session exists to: Ship payments v2.');
		expect(prompted).not.toContain('An arrival is a message like any other');

		prompts.length = 0;
		const loud = track(open({ goal: 'Ship payments v2.', arrivals: 'activate' }));
		await visitSession(loud, andrei);
		await loud.settled();
		expect(lastSystemPrompt()).toContain('An arrival is a message like any other');

		prompts.length = 0;
		const without = track(open());
		await visitSession(without, andrei);
		await without.settled();
		const bare = lastSystemPrompt();
		expect(bare).not.toContain('This session exists to:');
		expect(bare).not.toContain('An arrival is a message like any other');
		// presence still commits and still routes
		expect(await kinds(without)).toEqual(['arrived']);
	});
});
