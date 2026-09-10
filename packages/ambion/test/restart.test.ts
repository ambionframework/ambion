/**
 * What a run wrote about itself outlives it. The composition is a row on
 * the log, so a stopped room says who was in it, and the next run over the
 * same log starts from its own row.
 */
import { describe, expect, it } from 'vitest';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	type Runtime,
	readSession,
	type Session,
	startSession,
	stopSession,
	visitSession,
} from '../src/index.ts';
import { type FakeClock, fakeClock } from './support/clock.ts';
import { collect, deferred, roomName, rowsOf } from './support/room.ts';
import { byAgent, quiet, scripted } from './support/scripted.ts';
import { type OpenedStorage, storages } from './support/storage.ts';

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
const priya = defineHuman({ name: 'priya', identity: 'Project manager.' });

/** Resolves when the named seat's activation has ended, so its lease is released. */
function ended(session: Session, agent: string): Promise<void> {
	return new Promise((resolve) => {
		const off = session.subscribe((event) => {
			if (event.type !== 'activation_end' || event.agent !== agent) return;
			off();
			resolve();
		});
	});
}

interface World {
	opened: OpenedStorage;
	clock: FakeClock;
	/** A runtime over the storage. Each call is a new host over the same log. */
	runtime(): Runtime;
}

async function world(storage: (typeof storages)[number]): Promise<World> {
	const opened = await storage.open();
	const clock = fakeClock();
	return {
		opened,
		clock,
		runtime: () => createRuntime({ sessions: opened.sessions, clock }),
	};
}

describe.each(storages)('a room on $name', (storage) => {
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

	it('reads every identity off the log, in a process that holds no definition', async () => {
		const { opened, runtime } = await world(storage);
		try {
			const name = roomName(`restart-identity-${storage.name}`);
			const session = startSession({
				name,
				assistant,
				agents: [alpha],
				available: [beta],
				runtime: runtime(),
				streamFn: scripted(byAgent({})),
			});
			// before the replay, the seats fold from the row the run is about to write
			expect(session.seats().map((s) => [s.name, s.identity])).toEqual([
				['alpha', 'Alpha.'],
				['assistant', assistant.identity],
			]);
			await session.messages();
			await session.seat(beta);
			await session.quiet();
			await stopSession(session);

			// a fresh runtime knows no definition: the composition row and the seating carry them
			const view = readSession(name, { runtime: createRuntime({ sessions: opened.sessions }) });
			await view.messages();
			expect(view.seats().map((s) => [s.name, s.identity])).toEqual([
				['alpha', 'Alpha.'],
				['assistant', assistant.identity],
				['beta', 'Beta.'],
			]);
		} finally {
			await opened.dispose();
		}
	});

	it('leaves an open exchange to the next run, which closes it before it answers', async () => {
		const { opened, runtime } = await world(storage);
		try {
			const name = roomName(`restart-exchange-${storage.name}`);
			const working = deferred();
			const one = startSession({
				name,
				assistant,
				agents: [alpha],
				runtime: runtime(),
				streamFn: scripted(
					byAgent({
						alpha: async () => {
							working.resolve();
							await new Promise(() => {});
							return quiet();
						},
					}),
				),
			});
			const heard = collect(one);
			const visit = await visitSession(one, priya);
			await visit.deliver({ text: 'Is anybody there?' });
			await working.promise;
			// a stop mid-exchange: the activation is cut, and its release closes nothing
			const released = ended(one, 'alpha');
			await stopSession(one);
			await released;
			expect(heard.map((e) => e.type)).not.toContain('exchange_closed');
			const before = await rowsOf(opened.sessions, name);
			expect(before.map((row) => row.type)).not.toContain('ambion/close');

			// the next run closes it as it starts, and quiet() waits for that close
			const two = startSession({
				name,
				assistant,
				agents: [alpha],
				runtime: runtime(),
				streamFn: scripted(byAgent({})),
			});
			const events = collect(two);
			await two.quiet();
			// the close is on the stream when quiet() answers, before any other call replays the log
			expect(events.map((e) => e.type)).toContain('exchange_closed');
			expect(two.exchange()).toBeUndefined();
			const question = (await two.messages()).find((m) => m.kind === 'said');
			const closes = (await rowsOf(opened.sessions, name)).filter(
				(row) => row.type === 'ambion/close',
			);
			expect(closes).toHaveLength(1);
			expect(closes[0]?.data).toMatchObject({ owner: 'priya', from: question?.seq });
			await stopSession(two);
		} finally {
			await opened.dispose();
		}
	});
});
