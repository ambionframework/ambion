import type { Session as PiSession, SessionRepo } from '@earendil-works/pi-agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	attentive,
	defineAgent,
	defineHuman,
	InMemorySessionRepo,
	isSpoken,
	type Message,
	passive,
	readSession,
	type Session,
	startSession,
	stopSession,
	visitSession,
} from '../src/index.ts';
import { andrei, assistant, collect, deferred, roomName as name } from './support/room.ts';
import { contextText, quiet, scripted } from './support/scripted.ts';

// -- a room that never speaks ------------------------------------------------

const contexts: string[] = [];
const prompts: string[] = [];

/** Every seat reads and stays quiet, and the test reads what each seat was shown. */
const recording = scripted((context) => {
	prompts.push(context.systemPrompt ?? '');
	contexts.push(contextText(context));
	return quiet();
});

const watcher = defineAgent({
	name: 'watcher',
	identity: 'Watches the room.',
	instructions: 'stay quiet',
	model: 'scripted/watcher',
});

const mara = defineHuman({ name: 'mara', identity: 'Design lead.' });

const roomName = () => name('presence');

const open = (overrides: Partial<Parameters<typeof startSession>[0]> = {}) =>
	startSession({
		name: roomName(),
		assistant,
		agents: [watcher],
		streamFn: recording,
		...overrides,
	});

const kinds = async (session: { messages(): Promise<Message[]> }) =>
	(await session.messages()).map((m) => m.kind);

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
	});

	it('commits an arrival and wakes nobody, because no seat watches for one by default', async () => {
		const session = track(open());
		const seen = collect(session);
		await visitSession(session, andrei);
		await session.settled();

		expect(await kinds(session)).toEqual(['arrived']);
		expect(seen.some((e) => e.type === 'activation_start')).toBe(false);
		expect(contexts).toHaveLength(0); // no seat was handed a context at all
	});

	it('wakes a seat that watches arrivals, and only that seat', async () => {
		const greeter = defineAgent({
			name: 'greeter',
			identity: 'Meets people.',
			instructions: 'greet',
			model: 'scripted/greeter',
		});
		const quiet2 = defineAgent({
			name: 'aside',
			identity: 'Named only.',
			instructions: 'wait',
			model: 'scripted/aside',
		});
		const session = track(open({ agents: [watcher, attentive(greeter), passive(quiet2)] }));
		const seen = collect(session);
		await visitSession(session, andrei);
		await session.settled();

		const woke = seen.filter((e) => e.type === 'activation_start').map((e) => e.agent);
		expect(woke).toEqual(['greeter']); // not watcher, not the passive seat
		// the roster tells every seat which of them watches for this
		expect(contexts.at(-1)).toContain('- greeter (active, watches arrivals)');
		expect(contexts.at(-1)).toContain('- aside (idle, named only)');
	});

	it('steers a seat already at work, which is the whole of what presence routing does', async () => {
		const held = deferred();
		const seen: string[] = [];
		const holding = scripted(async (context) => {
			seen.push(contextText(context));
			await held.promise;
			return quiet();
		});
		const session = track(open({ streamFn: holding }));
		const visit = await visitSession(session, andrei);
		await visit.deliver({ text: 'start something long' }); // watcher is now mid-activation
		await visitSession(session, mara); // arrives while it works
		held.resolve();
		await session.settled();

		// the arrival never woke a second activation; it landed inside the running one
		expect(await kinds(session)).toEqual(['arrived', 'said', 'arrived']);
		expect(seen.some((c) => c.includes('[new] · mara arrived'))).toBe(true);
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

	it('holds one visit per person: a second visit is the same visit', async () => {
		const session = track(open());
		const seen = collect(session);
		const terminal = await visitSession(session, andrei);
		const browser = await visitSession(session, andrei);
		await session.settled();
		expect(browser.human).toBe(terminal.human); // one person is in the room once, or not at all
		expect(await kinds(session)).toEqual(['arrived']); // the second visit committed nothing
		expect(presenceOf(session, 'andrei')).toBe('present');

		await terminal.leave();
		await session.settled();
		expect(presenceOf(session, 'andrei')).toBe('absent');
		expect(await kinds(session)).toEqual(['arrived', 'left']);
		// leaving is a message like any other, and the stream carries it
		const left = seen.filter((e) => e.type === 'message' && e.message.kind === 'left');
		expect(left).toHaveLength(1);
	});

	it('still addresses somebody who left, and remembers them across a run', async () => {
		const repo = new InMemorySessionRepo();
		const name = roomName();
		const first = startSession({ name, assistant, agents: [watcher], streamFn: recording, repo });
		const visit = await visitSession(first, andrei);
		await visit.deliver({ text: 'noting that I was here' });
		await first.settled();
		await visit.leave();
		await first.settled();
		expect(presenceOf(first, 'andrei')).toBe('absent');
		// absent, and still on the roster the agents read
		expect(contexts.at(-1)).toContain('andrei');
		await stopSession(first);

		const again = track(
			startSession({ name, assistant, agents: [watcher], streamFn: recording, repo }),
		);
		await again.messages(); // startSession is synchronous; the replay is awaited here
		expect(presenceOf(again, 'andrei')).toBe('absent');
		expect(again.seats().find((s) => s.name === 'andrei')?.identity).toBe(andrei.identity);
	});

	it('refuses a stale visit, and takes leave() twice', async () => {
		const session = track(open());
		const visit = await visitSession(session, andrei);
		await visit.leave();
		await expect(visit.leave()).resolves.toBeUndefined();
		await expect(visit.deliver({ text: 'hello?' })).rejects.toThrow(/has ended/);
	});

	it('anchors since at where a person stopped reading, and holds it while they read', async () => {
		const session = track(open());
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

		await again.leave();
		await session.settled();
		const second = (await session.messages()).filter((m) => m.kind === 'left').at(-1);
		const back = await visitSession(session, andrei);
		expect(back.since).toBe(second?.seq); // it moves when they leave again
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
		const seen = collect(session);

		await stopSession(session);

		const view = readSession(session.name);
		expect((await view.messages()).map((m) => m.kind)).toEqual(['arrived', 'left']);
		// an activation started to hear that the room is closing is an activation nobody reads
		expect(seen.some((e) => e.type === 'activation_start')).toBe(false);
		await expect(visit.deliver({ text: 'still there?' })).rejects.toThrow();
	});

	it('reads a name that is not running, and starts nothing', async () => {
		const repo = new InMemorySessionRepo();
		const name = roomName();
		const session = startSession({ name, assistant, agents: [watcher], streamFn: recording, repo });
		const visit = await visitSession(session, andrei);
		await visit.deliver({ text: 'for later' });
		await session.settled();
		await stopSession(session);

		const view = readSession(name, { repo });
		expect((await view.messages()).filter(isSpoken).map((m) => m.text)).toEqual(['for later']);
		// no agents stand up, and everybody the record knows is absent
		expect(view.seats()).toEqual([
			{ kind: 'human', name: 'andrei', identity: andrei.identity, presence: 'absent' },
		]);
	});

	it('shows an agent the goal, the clock, and what each person has not seen', async () => {
		const session = track(open({ goal: 'Ship payments v2 this quarter.' }));
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

	it('renders the goal only when set, and always tells a seat what a presence line is for', async () => {
		const withGoal = track(open({ goal: 'Ship payments v2.' }));
		const gv = await visitSession(withGoal, andrei);
		await gv.deliver({ text: 'anything' }); // arrivals wake nobody, so ask
		await withGoal.settled();
		const prompted = lastSystemPrompt();
		expect(prompted).toContain('This session exists to: Ship payments v2.');
		expect(prompted).toContain('Who is reading can change while you work');

		prompts.length = 0;
		const without = track(open());
		const wv = await visitSession(without, andrei);
		await wv.deliver({ text: 'anything' });
		await without.settled();
		const bare = lastSystemPrompt();
		expect(bare).not.toContain('This session exists to:');
		// the audience paragraph is about routing, not purpose, so it needs no goal
		expect(bare).toContain('Who is reading can change while you work');
		expect(await kinds(without)).toEqual(['arrived', 'said']);
	});
});

// -- a repository that fails ------------------------------------------------

/** A Pi repository the test can break and mend, to see what the room does. */
function brittleRepo(): { repo: SessionRepo; entries: unknown[]; fail: (on: boolean) => void } {
	let failing = false;
	const entries: unknown[] = [];
	const piSession = {
		id: 'brittle',
		findEntries: async () => [],
		appendCustomEntry: async (_type: string, data: unknown) => {
			if (failing) throw new Error('the disk is full');
			entries.push(data);
		},
		appendMessage: async () => {},
	} as unknown as PiSession;
	const repo = {
		list: async () => [],
		create: async () => piSession,
		open: async () => piSession,
	} as unknown as SessionRepo;
	return { repo, entries, fail: (on: boolean) => (failing = on) };
}

describe('a repository that fails', () => {
	it('reports one failed write, then writes again once the repository mends', async () => {
		const { repo, entries, fail } = brittleRepo();
		const session = startSession({
			name: roomName(),
			assistant,
			agents: [watcher],
			streamFn: recording,
			repo,
		});
		const visit = await visitSession(session, andrei);
		expect(entries).toHaveLength(1);

		fail(true);
		await expect(visit.deliver({ text: 'lost' })).rejects.toThrow(/disk is full/);

		// the chain carries on: a mended repository writes the next message
		fail(false);
		await expect(visit.deliver({ text: 'kept' })).resolves.toBeUndefined();
		// the message that failed is gone from the repository, and only it
		expect(entries).toHaveLength(2);
		// the running room never lost it, so it still reads all three
		expect(await session.messages()).toHaveLength(3);
		await stopSession(session);
	});

	it('frees the name when the shutdown itself cannot write', async () => {
		const { repo, fail } = brittleRepo();
		const name = roomName();
		const session = startSession({ name, assistant, agents: [watcher], streamFn: recording, repo });
		await visitSession(session, andrei);

		fail(true);
		await expect(stopSession(session)).rejects.toThrow(/disk is full/);
		// a room that cannot be started again is worse than one that lost a write
		const again = track(
			startSession({ name, assistant, agents: [watcher], streamFn: recording, repo }),
		);
		expect(again.name).toBe(name);
	});

	it('surfaces a repository it cannot open, and never as an unhandled rejection', async () => {
		const unreachable = {
			list: async () => {
				throw new Error('the repository is unreachable');
			},
			create: async () => {
				throw new Error('the repository is unreachable');
			},
			open: async () => {
				throw new Error('the repository is unreachable');
			},
		} as unknown as SessionRepo;
		const loose: unknown[] = [];
		const note = (reason: unknown) => loose.push(reason);
		process.on('unhandledRejection', note);

		const session = startSession({
			name: roomName(),
			assistant,
			agents: [watcher],
			streamFn: recording,
			repo: unreachable,
		});
		// the failure waits for the call that needs the store
		await expect(session.messages()).rejects.toThrow(/unreachable/);
		await expect(visitSession(session, andrei)).rejects.toThrow(/unreachable/);
		await expect(stopSession(session)).rejects.toThrow(/unreachable/);

		await new Promise((resolve) => setImmediate(resolve));
		process.off('unhandledRejection', note);
		expect(loose).toHaveLength(0);
	});
});
