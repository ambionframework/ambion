/**
 * A room resumed over its log continues where the last run stopped. What the
 * room held in memory is a fold over the log, so a crash loses nothing but
 * the run: the exchange, the roster, the people, the leases and the summary
 * still owed all fold back, on both storages.
 */
import { describe, expect, it } from 'vitest';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	inProcessTransport,
	isSpoken,
	isSummary,
	type Runtime,
	readSession,
	resumeSession,
	type Session,
	startSession,
	stopSession,
	visitSession,
} from '../src/index.ts';
import { type FakeClock, fakeClock } from './support/clock.ts';
import { collect, crash, deferred, roomName } from './support/room.ts';
import {
	byAgent,
	quiet,
	type Script,
	says,
	scripted,
	summarise,
	toolNames,
} from './support/scripted.ts';
import { type OpenedStorage, storages } from './support/storage.ts';
import { faultyTransport } from './support/transport.ts';

const assistant = defineAgent({
	name: 'assistant',
	identity: 'Writes the one message a person reads.',
	instructions: 'Answer what was asked, once.',
	model: 'scripted/assistant',
});
const alpha = defineAgent({
	name: 'alpha',
	identity: 'Alpha.',
	instructions: 'x',
	model: 'scripted/alpha',
});
const beta = defineAgent({
	name: 'beta',
	identity: 'Beta.',
	instructions: 'x',
	model: 'scripted/beta',
});
const priya = defineHuman({
	name: 'priya',
	identity: 'Project manager.',
	preferences: 'Lead with the decision.',
});
const sam = defineHuman({ name: 'sam', identity: 'Site foreman.' });
const agents = [assistant, alpha, beta];

/** The assistant writes once when it holds `summarise`, or fails when told to. */
const writes =
	(text: string, failures = 0): Script =>
	(context, _name, call) => {
		if (!toolNames(context).includes('summarise')) return quiet();
		if (call <= failures) throw new Error('the model failed');
		return toolNames(context).includes('summarise') && call === failures + 1
			? summarise(text)
			: quiet();
	};

interface World {
	opened: OpenedStorage;
	clock: FakeClock;
	/** A runtime over the storage. Each call is a new host over the same log. */
	runtime(faults?: Parameters<typeof faultyTransport>[1]): Runtime;
}

async function world(storage: (typeof storages)[number]): Promise<World> {
	const opened = await storage.open();
	const clock = fakeClock();
	return {
		opened,
		clock,
		runtime: (faults = []) =>
			createRuntime({
				sessions: opened.sessions,
				clock,
				agents,
				transport: faultyTransport(inProcessTransport(), faults, clock),
			}),
	};
}

const summaries = async (session: Session) => (await session.messages()).filter(isSummary);

/** Resolves when this seat's next activation ends. */
const ended = (session: Session, seat: string) =>
	new Promise<void>((resolve) => {
		const off = session.subscribe((event) => {
			if (event.type !== 'activation_end' || event.agent !== seat) return;
			off();
			resolve();
		});
	});

describe.each(storages)('a room resumed on $name', (storage) => {
	it('continues an exchange with a lease live and a wake pending, and expires what never comes back', async () => {
		const { opened, clock, runtime } = await world(storage);
		try {
			const held = deferred();
			const script = byAgent({
				alpha: async (_c, _n, call) => {
					if (call === 1) await held.promise;
					return quiet();
				},
				beta: says(['beta one', 'beta two']),
				assistant: writes('The one message.'),
			});
			// beta's wake is lost on the way: at the crash it is still pending
			const first = runtime([
				{ on: 'wake', kind: 'drop', match: (w) => (w as { seat: string }).seat === 'beta' },
			]);
			const name = roomName(`restart-${storage.name}`);
			const session = startSession({
				name,
				assistant,
				agents: [alpha, beta],
				runtime: first,
				streamFn: scripted(script),
			});
			const visit = await visitSession(session, priya);
			await visit.deliver({ text: 'Can I tell the client Thursday?' });
			await new Promise((resolve) => setImmediate(resolve));
			const before = { seats: session.seats(), exchange: session.exchange() };
			expect(before.seats.find((s) => s.name === 'alpha')).toMatchObject({ status: 'active' });
			expect(before.exchange).toMatchObject({ owner: 'priya' });
			crash(first, session);

			const second = runtime();
			const resumed = await resumeSession(name, { runtime: second, streamFn: scripted(script) });
			const events = collect(resumed);
			// the fold before the crash is the fold after the resume
			expect(resumed.seats()).toEqual(before.seats);
			expect(resumed.exchange()).toEqual(before.exchange);
			// the pending wake is sent again, and beta answers into the same exchange
			await ended(resumed, 'beta');
			expect((await resumed.messages()).filter(isSpoken).map((m) => m.from)).toEqual([
				'priya',
				'beta',
				'beta',
			]);
			expect(resumed.exchange()).toMatchObject({ owner: 'priya' });

			// alpha's lease is held by a run that is gone: it expires, and the exchange closes
			held.resolve();
			await clock.advance(60_000);
			await resumed.quiet();
			expect(events.some((e) => e.type === 'error' && e.agent === 'alpha')).toBe(true);
			expect(events.some((e) => e.type === 'exchange_closed')).toBe(true);
			expect(await summaries(resumed)).toHaveLength(1);
			expect(resumed.seats().find((s) => s.name === 'alpha')).toMatchObject({ status: 'idle' });
			await stopSession(resumed);
		} finally {
			await opened.dispose();
		}
	});

	it('expires a lease that ran out while the room was down', async () => {
		const { opened, clock, runtime } = await world(storage);
		try {
			const held = deferred();
			const script = byAgent({
				alpha: async (_c, _n, call) => {
					if (call === 1) await held.promise;
					return quiet();
				},
			});
			const first = runtime();
			const name = roomName(`restart-${storage.name}`);
			const session = startSession({
				name,
				assistant,
				agents: [alpha],
				runtime: first,
				streamFn: scripted(script),
			});
			const visit = await visitSession(session, priya);
			await visit.deliver({ text: 'Anyone?' });
			await new Promise((resolve) => setImmediate(resolve));
			crash(first, session);
			held.resolve();

			await clock.advance(61_000);
			const resumed = await resumeSession(name, { runtime: runtime(), streamFn: scripted(script) });
			const events = collect(resumed);
			// the resume itself reported the expiry; the activation came to nothing,
			// so the question is still open and alpha is woken again after the backoff
			expect(resumed.exchange()).toMatchObject({ owner: 'priya' });
			expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
			await clock.advance(30_000);
			await resumed.quiet();
			expect(events.filter((e) => e.type === 'activation_start')).toHaveLength(1);
			expect(resumed.exchange()).toBeUndefined();
			expect(resumed.seats().find((s) => s.name === 'alpha')).toMatchObject({ status: 'idle' });
			await stopSession(resumed);
		} finally {
			await opened.dispose();
		}
	});

	it('writes one composition per run, and the latest roster wins', async () => {
		const { opened, runtime } = await world(storage);
		try {
			const name = roomName(`restart-${storage.name}`);
			const one = startSession({
				name,
				assistant,
				agents: [alpha],
				runtime: runtime(),
				streamFn: scripted(byAgent({})),
			});
			await one.messages();
			expect(one.seats().map((s) => s.name)).toEqual(['alpha', 'assistant']);
			await stopSession(one);

			const two = startSession({
				name,
				assistant,
				agents: [beta],
				runtime: runtime(),
				streamFn: scripted(byAgent({})),
			});
			await two.messages();
			expect(two.seats().map((s) => s.name)).toEqual(['beta', 'assistant']);
			await stopSession(two);

			const view = readSession(name, { runtime: runtime() });
			await view.messages();
			expect(view.seats().map((s) => s.name)).toEqual(['beta', 'assistant']);
		} finally {
			await opened.dispose();
		}
	});

	it('keeps a person present across a crash, holds their identity while present, and frees it after leave', async () => {
		const { opened, runtime } = await world(storage);
		try {
			const name = roomName(`restart-${storage.name}`);
			const first = runtime();
			const session = startSession({
				name,
				assistant,
				runtime: first,
				streamFn: scripted(byAgent({})),
			});
			await visitSession(session, priya);
			await visitSession(session, sam);
			crash(first, session);

			const resumed = await resumeSession(name, {
				runtime: runtime(),
				streamFn: scripted(byAgent({})),
			});
			// no `left` was written, so both are still present, and visiting again writes nothing
			expect(
				resumed
					.seats()
					.filter((s) => s.kind === 'human')
					.map((s) => [s.name, s.presence]),
			).toEqual([
				['priya', 'present'],
				['sam', 'present'],
			]);
			const again = await visitSession(resumed, priya);
			expect((await resumed.messages()).map((m) => m.kind)).toEqual(['arrived', 'arrived']);

			const renamed = defineHuman({ name: 'priya', identity: 'A different priya.' });
			await expect(visitSession(resumed, renamed)).rejects.toThrow(/different identity/);
			await again.leave();
			const back = await visitSession(resumed, renamed);
			expect(back.human.identity).toBe('A different priya.');
			expect((await resumed.messages()).map((m) => m.kind)).toEqual([
				'arrived',
				'arrived',
				'left',
				'arrived',
			]);
			expect(resumed.seats().find((s) => s.name === 'priya')).toMatchObject({
				identity: 'A different priya.',
			});
			await stopSession(resumed);
		} finally {
			await opened.dispose();
		}
	});

	it('folds two closes owed to one person into one draft, and writes it after the backoff', async () => {
		const { opened, clock, runtime } = await world(storage);
		try {
			const script = byAgent({
				alpha: says(['alpha one', 'alpha two', 'alpha three']),
				beta: says(['beta one']),
				assistant: writes('Both questions, answered.', 1),
			});
			const name = roomName(`restart-${storage.name}`);
			const first = runtime();
			const session = startSession({
				name,
				assistant,
				agents: [alpha, beta],
				runtime: first,
				streamFn: scripted(script),
			});
			const visit = await visitSession(session, priya);
			await visit.deliver({ text: 'First?' });
			await session.quiet();
			// the first draft failed: priya is owed, and the room waits for the backoff
			expect(await summaries(session)).toHaveLength(0);
			await visit.deliver({ text: 'Second?' });
			await session.quiet();
			expect(await summaries(session)).toHaveLength(0);
			const record = await session.messages();
			const questions = record.filter((m) => isSpoken(m) && m.from === 'priya');
			crash(first, session);

			// the resumed room's assistant writes at the first draft it is given
			const writing = byAgent({ assistant: writes('Both questions, answered.') });
			const resumed = await resumeSession(name, {
				runtime: runtime(),
				streamFn: scripted(writing),
			});
			await resumed.quiet();
			expect(await summaries(resumed)).toHaveLength(0);
			await clock.advance(30_000);
			await resumed.quiet();
			const written = await summaries(resumed);
			expect(written).toHaveLength(1);
			// one message reaches back to the first question, and covers the second
			expect(written[0]?.covers.from).toBe(questions[0]?.seq);
			expect(written[0]?.covers.through).toBe((written[0]?.seq ?? 0) - 1);
			expect(written[0]?.to).toBe('priya');
			await stopSession(resumed);
		} finally {
			await opened.dispose();
		}
	});

	it('refuses to resume a name whose seats the catalog does not hold, and one with no composition', async () => {
		const { opened, runtime } = await world(storage);
		try {
			const name = roomName(`restart-${storage.name}`);
			const session = startSession({
				name,
				assistant,
				agents: [alpha],
				runtime: runtime(),
				streamFn: scripted(byAgent({})),
			});
			await session.messages();
			await stopSession(session);
			const bare = createRuntime({ sessions: opened.sessions, clock: fakeClock() });
			await expect(resumeSession(name, { runtime: bare })).rejects.toThrow(
				/not in the runtime's catalog/,
			);
			await expect(
				resumeSession(roomName('never-started'), { runtime: runtime() }),
			).rejects.toThrow(/no composition/);
		} finally {
			await opened.dispose();
		}
	});
});
