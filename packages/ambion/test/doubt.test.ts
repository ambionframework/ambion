/**
 * The room in doubt: a write that landed while its confirmation was lost.
 * The journal reads the storage at once, and the room hears what it finds the
 * way it hears what it wrote.
 */
import { describe, expect, it } from 'vitest';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	isPresence,
	isSpoken,
	isSummary,
	type SessionEvent,
	startSession,
	visitSession,
} from '../src/index.ts';
import { type CommitResult, inProcessTransport, type Transport } from '../src/transport.ts';
import { fakeClock } from './support/clock.ts';
import { collect, roomName, storedOf } from './support/room.ts';
import {
	answersLastQuestion,
	byAgent,
	quiet,
	says,
	scripted,
	summarise,
	toolNames,
	toolResultTexts,
} from './support/scripted.ts';
import { faultyJournals, memory, tappedJournals } from './support/storage.ts';

const assistant = defineAgent({
	name: 'assistant',
	identity: 'Writes the one message.',
	instructions: 'x',
	model: 'scripted/assistant',
});
const alpha = defineAgent({
	name: 'alpha',
	identity: 'Alpha.',
	instructions: 'x',
	model: 'scripted/alpha',
});
const priya = defineHuman({ name: 'priya', identity: 'PM.' });

const script = byAgent({
	alpha: answersLastQuestion(['priya']),
	assistant: (context) =>
		toolNames(context).includes('summarise') && !toolResultTexts(context).includes('delivered')
			? summarise('The one message.')
			: quiet(),
});

const count = (events: SessionEvent[], type: SessionEvent['type']) =>
	events.filter((e) => e.type === type).length;

/** A room over a storage that fails on request, with the events it emits. */
async function room(name: string) {
	const opened = await memory.open();
	const faulty = faultyJournals(opened.storage);
	const clock = fakeClock();
	const runtime = createRuntime({ clock, storage: faulty.journals });
	const session = startSession({
		name: roomName(name),
		runtime,
		assistant,
		agents: [alpha],
		streamFn: scripted(script),
	});
	return { opened, faulty, clock, session, events: collect(session) };
}

describe('a room in doubt', () => {
	it('returns one summary when its first commit confirmation is lost', async () => {
		const opened = await memory.open();
		const clock = fakeClock();
		const base = inProcessTransport();
		const replies: CommitResult[] = [];
		let retried = false;
		let confirmed: () => void = () => {};
		const confirmation = new Promise<void>((resolve) => {
			confirmed = resolve;
		});
		const transport: Transport = {
			connect(room, seat, runtime) {
				const port = base.connect(
					{
						name: room.name,
						stream: room.stream,
						model: room.model,
						transcripts: room.transcripts,
						definition: (seat) => room.definition(seat),
						emit: (event) => room.emit(event),
						evict: () => room.evict(),
						view: (id) => room.view(id),
						lease: (lease) => room.lease(lease),
						commit: async (commit) => {
							if (retried || commit.intent.kind !== 'summary') return room.commit(commit);
							retried = true;
							const first = await room.commit(commit);
							const retry = await room.commit(commit);
							replies.push(first, retry);
							confirmed();
							return retry;
						},
					},
					seat,
					runtime,
				);
				return port;
			},
		};
		const session = startSession({
			name: roomName('doubt-summary'),
			runtime: createRuntime({ clock, storage: opened.storage, transport }),
			assistant,
			agents: [alpha],
			streamFn: scripted(
				byAgent({
					alpha: says(['one', 'two']),
					assistant: (context) =>
						toolNames(context).includes('summarise') &&
						!toolResultTexts(context).includes('delivered')
							? summarise('The one message.')
							: quiet(),
				}),
			),
		});
		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'First?', key: 'q1' });
		await confirmation;
		const summaries = (await session.messages()).filter(isSummary);
		expect(retried).toBe(true);
		expect(summaries).toHaveLength(1);
		const seqs = replies.flatMap((reply) => ('committed' in reply ? [reply.committed.seq] : []));
		expect(seqs).toEqual([summaries[0]?.seq, summaries[0]?.seq]);
	});

	it('hears a delivery that landed and lost its confirmation, and the seats wake for it', async () => {
		const { faulty, session, events } = await room('doubt-delivery');
		const visit = await visitSession(session, priya);
		await session.settled();
		faulty.fail('after', 'message');
		await expect(visit.deliver({ text: 'First?', key: 'q1' })).rejects.toThrow(/disk is full/);
		faulty.fail(false);
		await session.quiet();
		const record = await session.messages();
		expect(record.filter((m) => m.key === 'q1')).toHaveLength(1);
		expect(record.filter(isSpoken).filter((m) => m.from === alpha.name)).toHaveLength(1);
		expect(events.filter((e) => e.type === 'message').map((e) => e.message.key)).toContain('q1');
		// and a retry under the same key lands nothing new
		await visit.deliver({ text: 'First?', key: 'q1' });
		expect((await session.messages()).filter((m) => m.key === 'q1')).toHaveLength(1);
	});

	it('opens the next exchange when the close it found had a question queued ahead of it', async () => {
		const opened = await memory.open();
		let failNextClose = false;
		const journals = tappedJournals(opened.storage, (_id, _n, phase, customType) => {
			if (failNextClose && phase === 'after' && customType === 'close') {
				failNextClose = false;
				throw new Error('the disk is full');
			}
		});
		const clock = fakeClock();
		const runtime = createRuntime({ clock, storage: journals });
		const session = startSession({
			name: roomName('doubt-close'),
			runtime,
			assistant,
			agents: [alpha],
			streamFn: scripted(script),
		});
		const events = collect(session);
		const visit = await visitSession(session, priya);
		await session.settled();
		// The second question is delivered the moment alpha's activation ends, so its
		// commit is queued ahead of the close the reconcile decides, and that close
		// lands and loses its confirmation.
		let delivered: Promise<unknown> | undefined;
		session.subscribe((event) => {
			if (
				event.type === 'activation_end' &&
				event.agent === alpha.name &&
				delivered === undefined
			) {
				failNextClose = true;
				delivered = visit.deliver({ text: 'Second?', key: 'q2' });
			}
		});
		await visit.deliver({ text: 'First?', key: 'q1' });
		await session.quiet();
		await delivered;
		for (let i = 0; i < 4; i += 1) await clock.advance(61_000);
		await session.quiet();
		const stored = await storedOf(opened.journals, session.name);
		expect(stored.filter((r) => r.kind === 'close')).toHaveLength(2);
		expect(count(events, 'exchange_opened')).toBe(2);
		expect(count(events, 'exchange_closed')).toBe(2);
	});

	it('answers messages() with what the read found, whenever the read was asked for', async () => {
		const { faulty, session } = await room('doubt-read');
		const visit = await visitSession(session, priya);
		await session.settled();
		faulty.fail('after', 'message');
		const delivery = visit.deliver({ text: 'First?', key: 'q1' });
		const read = session.messages();
		await expect(delivery).rejects.toThrow(/disk is full/);
		faulty.fail(false);
		expect((await read).map((m) => m.key)).toContain('q1');
	});

	it('writes one arrival for a visit retried after its arrival lost its confirmation', async () => {
		const { faulty, session } = await room('doubt-visit');
		await session.messages();
		faulty.fail('after', 'message');
		const first = visitSession(session, priya);
		const second = first.catch(() => visitSession(session, priya));
		await expect(first).rejects.toThrow(/disk is full/);
		faulty.fail(false);
		await second;
		await session.quiet();
		const arrivals = (await session.messages())
			.filter(isPresence)
			.filter((m) => m.kind === 'arrived');
		expect(arrivals).toHaveLength(1);
	});
});
