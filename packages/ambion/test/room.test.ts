import type { Context } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { piExecution } from '../../pi/src/index.ts';
import { runningRoom } from '../src/host/runtime.ts';
import { inProcessTransport } from '../src/hosting.ts';
import {
	type Attention,
	createRuntime,
	defineHuman,
	isSpoken,
	type Message,
	type Room,
	readRoom,
	startRoom,
} from '../src/index.ts';
import { refusedAs } from './support/core-room.ts';
import {
	andrei,
	assistant,
	collect,
	deferred,
	enter,
	messagesOf,
	participantsOf,
	roomName,
	scriptedAgent,
	waitForRoom,
} from './support/room.ts';
import { byAgent, contextText, quiet, type Script, scripted, speak } from './support/scripted.ts';
import { stopAtEnd } from './support/stop.ts';
import { memory } from './support/storage.ts';

/** The record's spoken half, which is what most of these tests are about. */
const spoken = (messages: readonly Message[]) => messages.filter(isSpoken);

type Options = Partial<Parameters<typeof startRoom>[0]>;

/** A room of scripted agents on these seats, and the assistant seated for nothing. */
async function open(
	label: string,
	seats: Record<string, Attention>,
	script: Script = () => quiet(),
	options: Options = {},
): Promise<Room> {
	return stopAtEnd(
		await startRoom({
			name: roomName(label),
			seats: { ...seats, [assistant.name]: 'none' },
			agents: [...Object.keys(seats).map((name) => scriptedAgent(name)), assistant],
			execution: piExecution({ stream: scripted(script) }),
			...options,
		}),
	);
}

/** A transport whose seats hear nothing, so the test holds the seat side of the wire itself. */
const deaf = () =>
	createRuntime({
		transport: {
			connect: () => ({ wake: async () => {}, steer: async () => {}, cut: async () => {} }),
		},
	});

describe('startRoom', () => {
	it('activates idle agents in parallel, steers a working colleague, wakes an idle one', async () => {
		const gammaIdle = deferred();
		const alphaSaid = deferred();
		const betaContexts: string[] = [];
		let betaAcked = false;
		const session = await open(
			'parallel',
			{ alpha: 'broadcast', beta: 'broadcast', gamma: 'broadcast' },
			byAgent({
				alpha: async (_context, _agent, call) => {
					if (call !== 1) return quiet();
					await gammaIdle.promise; // let gamma go idle before alpha speaks
					return speak('the answer is 42');
				},
				// beta: hold the first activation open until alpha has spoken, so
				// the reply reaches beta as a mid-activation arrival.
				beta: async (context, _agent, call) => {
					if (call === 1) {
						await alphaSaid.promise;
						return quiet('waiting');
					}
					betaContexts.push(contextText(context));
					if (betaAcked || !contextText(context).includes('the answer is 42')) return quiet();
					betaAcked = true;
					return speak('ack: 42');
				},
			}),
		);
		const events = collect(session);
		session.subscribe((event) => {
			if (event.type === 'activation_end' && event.agent === 'gamma') gammaIdle.resolve();
			if (event.type === 'message' && event.message.from === 'alpha') alphaSaid.resolve();
		});

		const visit = await enter(session);
		await visit.send({ text: 'What is the answer?' });
		await waitForRoom(session);

		const texts = spoken(await messagesOf(session)).map((m) => `${m.from}: ${m.text}`);
		expect(texts).toContain('alpha: the answer is 42');
		expect(texts).toContain('beta: ack: 42');
		expect(texts).toHaveLength(3); // the woken seats that declined wrote nothing
		expect(betaContexts.some((c) => c.includes('the answer is 42'))).toBe(true);
		// a say wakes the idle room: gamma, idle when alpha spoke, looked again,
		// and the exchange still settled, because a woken seat with nothing to add declines
		const gammaStarts = events.filter(
			(e) => e.type === 'activation_start' && e.agent === 'gamma',
		).length;
		expect(gammaStarts).toBeGreaterThanOrEqual(2);
	});

	it('resets the working view at idle: a new activation reads the record', async () => {
		const contexts: Context[] = [];
		// a say costs a second call for the tool result, so the two deliveries
		// speak on 1 and 3; arrivals are quiet and wake nobody.
		const session = await open('reset', { echo: 'broadcast' }, (context, _agent, call) => {
			contexts.push(context);
			return call % 2 === 1 ? speak(`echo ${call}`) : quiet();
		});
		const visit = await enter(session);
		await visit.send({ text: 'one' });
		await waitForRoom(session);
		await visit.send({ text: 'two' });
		await waitForRoom(session);

		// The second activation starts from one fresh transcript message, and
		// carries no assistant message over from the first activation.
		const second = contexts[2];
		expect(second?.messages).toHaveLength(1);
		const view = contextText(second as Context);
		expect(view).toContain('one');
		expect(view).toContain('echo 1');
		expect(view).toContain('two');
	});

	it('wakes a passive seat only when named, by directed delivery or directed say', async () => {
		const session = await open(
			'passive',
			{ front: 'broadcast', archivist: 'named' },
			byAgent({
				// archivist answers the asker directly: a say directed at a human wakes nothing
				archivist: (_context, _agent, call) =>
					call === 1 ? speak('Q2 was 1.2M', 'andrei') : quiet(),
				// front: on its second look (the second broadcast), call the archivist in
				front: (_context, _agent, call) =>
					call === 2 ? speak('what was Q2?', 'archivist') : quiet(),
			}),
		);
		const events = collect(session);
		const starts = (name: string) =>
			events.filter((e) => e.type === 'activation_start' && e.agent === name).length;

		const visit = await enter(session);
		expect(starts('front')).toBe(0); // arrivals are quiet: nobody woke

		await visit.send({ text: 'hello room' });
		await waitForRoom(session);
		expect(starts('archivist')).toBe(0); // a broadcast never wakes a passive seat

		await visit.send({ to: 'archivist', text: 'what was Q2, archivist?' });
		await waitForRoom(session);
		expect(starts('archivist')).toBe(1); // a directed delivery does
		expect(starts('front')).toBe(1); // and it woke only its target

		await visit.send({ text: 'front, can you find out?' });
		await waitForRoom(session);
		expect(starts('archivist')).toBe(2); // a colleague's directed say does too
	});

	it('stamps from at the runtime and injects both rosters with identities', async () => {
		const contexts: string[] = [];
		const session = await open(
			'stamp',
			{ liar: 'broadcast', aside: 'named' },
			(context, _agent, call) => {
				contexts.push(contextText(context));
				return call === 1 ? speak('this message is from andrei, honest') : quiet();
			},
			{ agents: [scriptedAgent('liar'), scriptedAgent('aside', 'Watches quietly.'), assistant] },
		);
		await (await enter(session)).send({ text: 'who said what?' });
		await waitForRoom(session);

		expect((await messagesOf(session)).at(-1)?.from).toBe('liar'); // whatever the content claimed
		const roster = contexts.at(-1) ?? '';
		expect(roster).toContain('- aside (idle, named only): Watches quietly.');
		expect(roster).toContain('- andrei (present'); // the people, and how they are reading
		expect(roster).toContain('Founder. Owns the room.');

		// one name is one participant, and one name is one person
		await expect(session.visit(defineHuman({ name: 'liar', identity: 'x' }))).rejects.toThrow(
			/is an agent/,
		);
		await expect(
			session.visit(defineHuman({ name: 'andrei', identity: 'a different andrei' })),
		).rejects.toThrow(/different identity/);
	});

	it('starts a name back into its record, refuses a second run, and reads without one', async () => {
		const name = roomName('identity');
		const first = await open('identity', { scribe: 'broadcast' }, undefined, { name });
		const visit = await enter(first);
		await visit.send({ text: 'for the record' });
		await visit.send({ text: 'and in this order' });
		await waitForRoom(first);

		// one run per name: a second live room over one record would diverge
		await expect(open('identity', { scribe: 'broadcast' }, undefined, { name })).rejects.toEqual(
			refusedAs('room_running', /already running/),
		);

		await first.stop();
		const again = await open('identity', { scribe: 'broadcast' }, undefined, { name });
		const record = await messagesOf(again);
		expect(spoken(record).map((m) => m.text)).toEqual(['for the record', 'and in this order']);
		// seqs continue in order, and none repeats
		const seqs = record.map((m) => m.seq);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
		expect(new Set(seqs).size).toBe(seqs.length);
		await again.stop();

		// a room that is not running reads: the record, and the roster it folds
		const view = await readRoom(name);
		expect(spoken(view.messages).map((m) => m.text)).toContain('for the record');
		expect(view.participants.map((seat) => seat.name)).toEqual(['scribe', 'assistant', 'andrei']);
		expect(view.participants.every((seat) => seat.kind === 'human' || seat.status === 'idle')).toBe(
			true,
		);

		expect(await messagesOf(await open('identity', { scribe: 'broadcast' }))).toHaveLength(0);
	});

	it('streams events in order, and surfaces an activation that throws as an error event', async () => {
		const ordered = await open('events', { solo: 'broadcast' }, (_context, _agent, call) =>
			call === 1 ? speak('hi') : quiet(),
		);
		const orderedVisit = await enter(ordered);
		const events = collect(ordered);
		await orderedVisit.send({ text: 'say hi' });
		await waitForRoom(ordered);
		// one event per message on the record, whoever wrote it, and the exchange
		// that message opened around it. The `step` events have their own tests
		// in trace.test.ts. One answer needs no summary, so the room goes quiet
		// in the same tick the exchange closes.
		expect(events.filter((e) => e.type !== 'step').map((e) => e.type)).toEqual([
			'message',
			'exchange_opened',
			'activation_start',
			'message',
			'activation_end',
			'exchange_closed',
		]);
		expect(events.flatMap((e) => (e.type === 'message' ? [e.message.from] : []))).toEqual([
			'andrei',
			'solo',
		]);

		const faulty = await open('error', { solo: 'broadcast' }, () => {
			throw new Error('boom');
		});
		const faultVisit = await faulty.visit(andrei);
		const faultEvents = collect(faulty);
		const failed = new Promise<void>((resolve) => {
			faulty.subscribe((e) => {
				if (e.type === 'activation_end') resolve();
			});
		});
		await faultVisit.send({ text: 'trigger' });
		await failed;
		expect(faultEvents.some((e) => e.type === 'error' && e.agent === 'solo')).toBe(true);
		expect(spoken(await messagesOf(faulty))).toHaveLength(1);
		// the failed activation is one attempt: the wake is pending again after the
		// backoff, so the room is still working, and only an abort settles it now
		await faulty.abort();
		await waitForRoom(faulty);
	});

	it('aborts a hung activation to a quiet room, and never rebuilds it for a queued steer', async () => {
		let calls = 0;
		const started = deferred();
		const session = await open('abort-steer', { solo: 'broadcast' }, () => {
			calls += 1;
			started.resolve();
			return new Promise<never>(() => {});
		});
		const visit = await session.visit(andrei);
		const events = collect(session);
		await visit.send({ text: 'hang' });
		await started.promise;
		await visit.send({ text: 'mid-turn note' }); // queues a steer into the hung run
		await session.abort();
		await waitForRoom(session);
		expect(calls).toBe(1);
		expect(events.some((e) => e.type === 'error')).toBe(false);
		expect(spoken(await messagesOf(session))).toHaveLength(2); // what was said stays
	});

	it('fails a say that races past the record, delivering what was missed', async () => {
		// Two seats answer the same broadcast; the slower one commits blind.
		// The losing say fails back with the winner's message, and the retry,
		// now with the point in view, commits cleanly.
		const firstSaid = deferred();
		const secondContexts: string[] = [];
		const session = await open(
			'race',
			{ first: 'broadcast', second: 'broadcast' },
			byAgent({
				first: (_context, _agent, call) => (call === 1 ? speak('the point') : quiet()),
				second: async (context, _agent, call) => {
					secondContexts.push(contextText(context));
					if (call === 1) {
						await firstSaid.promise; // commit blind, after the record moved
						return speak('the same point, again');
					}
					return call === 2 ? speak('a genuinely different angle') : quiet();
				},
			}),
		);
		const events = collect(session);
		const visit = await enter(session);
		session.subscribe((event) => {
			if (event.type === 'message' && event.message.from === 'first') firstSaid.resolve();
		});
		await visit.send({ text: 'thoughts?' });
		await waitForRoom(session);

		const texts = spoken(await messagesOf(session)).map((m) => m.text);
		expect(texts).toEqual(['thoughts?', 'the point', 'a genuinely different angle']);
		const conflicts = events.filter((e) => e.type === 'conflict');
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0]).toMatchObject({
			author: 'second',
			activation: expect.stringMatching(/:second:\d+$/),
		});
		const missed = conflicts[0]?.type === 'conflict' ? conflicts[0].missed[0] : undefined;
		expect(missed && isSpoken(missed) && missed.text).toBe('the point');
		// the failure reached the model as a tool result carrying the missed line
		expect(secondContexts[1]).toContain('Not delivered');
		expect(secondContexts[1]).toContain('the point');
	});

	it('leaves no mark when a seat stands down after a conflict', async () => {
		const firstSaid = deferred();
		const session = await open(
			'race-yield',
			{ first: 'broadcast', second: 'broadcast' },
			byAgent({
				first: (_context, _agent, call) => (call === 1 ? speak('the point') : quiet()),
				second: async (_context, _agent, call) => {
					if (call !== 1) return quiet('point already made');
					await firstSaid.promise;
					return speak('me too');
				},
			}),
		);
		const visit = await enter(session);
		const events = collect(session);
		session.subscribe((event) => {
			if (event.type === 'message' && event.message.from === 'first') firstSaid.resolve();
		});
		await visit.send({ text: 'thoughts?' });
		await waitForRoom(session);

		expect(spoken(await messagesOf(session))).toHaveLength(2);
		const end = events.find((e) => e.type === 'activation_end' && e.agent === 'second');
		expect(end).toMatchObject({ spoke: false });
	});

	it('refuses a delivery to the assistant, lands a repeated key once, and leaves no mark of a decline', async () => {
		const session = await open('keys', { shy: 'broadcast' }, () => quiet('not for me'));
		const events = collect(session);
		const visit = await enter(session);
		// the assistant wakes for nothing said, and nothing lands
		await expect(visit.send({ to: assistant.name, text: 'Write it up for me.' })).rejects.toThrow(
			/wakes for nothing said/,
		);
		expect((await messagesOf(session)).map((m) => m.kind)).toEqual(['arrived']);

		await visit.send({ text: 'once', key: 'delivery-1' });
		await visit.send({ text: 'once', key: 'delivery-1' });
		await waitForRoom(session);

		// one message with the person's key, one event, one activation, and it declined
		const said = spoken(await messagesOf(session));
		expect(said.map((m) => [m.seq, m.text, m.key])).toEqual([[4, 'once', 'delivery-1']]);
		expect(events.filter((e) => e.type === 'message' && e.message.kind === 'said')).toHaveLength(1);
		expect(events.filter((e) => e.type === 'activation_start')).toHaveLength(1);
		expect(events.find((e) => e.type === 'activation_end')).toMatchObject({
			agent: 'shy',
			spoke: false,
		});
	});

	it('refuses a composition that seats a name the record knows as a person, and frees the name', async () => {
		const runtime = createRuntime({ storage: (await memory.open()).storage });
		const name = roomName('clash');
		const first = await open('clash', {}, undefined, { name, runtime });
		await first.visit(andrei);
		await first.stop();

		const impostor = { ...scriptedAgent('impostor'), name: 'andrei' };
		const clash = () =>
			open('clash', {}, undefined, {
				name,
				runtime,
				seats: { andrei: 'broadcast', [assistant.name]: 'none' },
				agents: [impostor, assistant],
			});
		await expect(clash()).rejects.toEqual(
			refusedAs('duplicate_name', /one name names one participant/),
		);
		// nothing runs under the name, and the host never stopped the handle it holds:
		// a composition that stands takes the name and reads the record the first run left
		const again = await open('clash', {}, undefined, { name, runtime });
		expect((await messagesOf(again)).map((m) => m.from)).toEqual(['andrei', 'andrei']);
	});

	it('refuses a duplicate agent name', async () => {
		const twin = scriptedAgent('solo');
		await expect(
			open('dupe', { solo: 'broadcast' }, undefined, { agents: [twin, twin, assistant] }),
		).rejects.toThrow(/one name names one participant/);
	});

	it('tells the seat side to stop, over the wire, when it cuts a lease', async () => {
		const hangs = deferred();
		// a transport of the host's own: the room reaches it through the wire alone
		const cuts: string[] = [];
		const inProcess = inProcessTransport();
		const runtime = createRuntime({
			transport: {
				connect: (room, context) => {
					const port = inProcess.connect(room, context);
					return {
						wake: (wake) => port.wake(wake),
						steer: (steer) => port.steer(steer),
						cut: (activation) => {
							cuts.push(activation);
							return port.cut(activation);
						},
					};
				},
			},
		});
		const session = await open(
			'cut',
			{ solo: 'broadcast' },
			async () => {
				hangs.resolve();
				return new Promise<never>(() => {});
			},
			{ runtime },
		);
		const visit = await enter(session);
		await visit.send({ text: 'wait for me' });
		await hangs.promise;
		await session.abort();
		await waitForRoom(session);
		// the room ended the lease and told the seat, and the seat stopped: the room is idle
		expect(cuts).toEqual(['message:4:solo:1']);
		expect((await participantsOf(session)).find((s) => s.name === 'solo')).toMatchObject({
			status: 'idle',
		});
	});

	it('refuses stale leases, missing or invalid freshness, and a commit from a lease that ended', async () => {
		const runtime = deaf();
		const session = await open('stale', { solo: 'broadcast' }, undefined, { runtime });
		const events = collect(session);
		const visit = await enter(session);
		await visit.send({ text: 'first' });
		const room = runningRoom(runtime, session.name);
		if (room === undefined) throw new Error('the room is not running');
		const activation = 'message:4:solo:1';
		expect(await room.lease({ activation, operation: 'renew' })).toEqual({
			stale: 'the lease ended',
		});
		const claimed = await room.lease({ activation, operation: 'claim' });
		expect(claimed).toMatchObject({ ok: {} });
		expect(await room.lease({ activation, operation: 'claim' })).toMatchObject({ ok: {} });
		// A renewal writes an entry beside the record, and the record stands
		// where it stood. The seat reads `lastSeq` against what its view held to
		// decide whether to read again: a renewal that reported its own landing
		// as movement would read again, renew again, and never stop.
		expect(await room.lease({ activation, operation: 'renew' })).toMatchObject({
			ok: { lastSeq: 'ok' in claimed ? claimed.ok.lastSeq : -1 },
		});

		const before = await messagesOf(session);
		for (const readThrough of [undefined, -1, 1.5, 99]) {
			const reply = await room.commit({
				activation,
				key: `fresh-${readThrough}`,
				...(readThrough === undefined ? {} : { readThrough }),
				intent: { kind: 'said', text: 'x' },
			});
			expect(reply).toMatchObject({ refused: expect.any(String) });
		}
		expect(await messagesOf(session)).toEqual(before);
		const opened = await room.view(activation);
		if ('stale' in opened) throw new Error('Expected a live activation.');
		expect(
			await room.commit({
				activation,
				key: 'fresh-valid',
				readThrough: opened.view.through,
				intent: { kind: 'said', text: 'valid' },
			}),
		).toMatchObject({ committed: { text: 'valid' } });

		// the record moves past what the activation read, and then its lease ends
		await visit.send({ text: 'second' });
		await room.lease({ activation, operation: 'release', reason: 'released', readThrough: 0 });
		const late = await room.commit({
			activation,
			key: 'late',
			readThrough: 2,
			intent: { kind: 'said', text: 'too late' },
		});
		// nothing this activation writes lands, whatever the record did, so the
		// room reports no conflict for a seat that has nothing to redraft
		expect(late).toEqual({ stale: 'the lease ended' });
		expect(events.some((event) => event.type === 'conflict')).toBe(false);
	});
});

/**
 * The room keeps when it last sent each wake, so it sends one again only
 * after the resend window. `decide` says which of those the fold no longer
 * owes, and the pass drops them: the cache holds only what the room still
 * waits on, however long the room has run.
 *
 * Nothing else reads a forgotten id, because `decide` looks up only what the
 * fold says is due. This is the one place the bound is visible.
 */
describe('what the room waits on', () => {
	const sentBy = (session: Room): Map<string, number> =>
		(session as unknown as { sentAt: Map<string, number> }).sentAt;

	it('drops a wake the fold stopped owing, and holds one it still owes', async () => {
		const held = deferred();
		const session = await open('waits', { solo: 'broadcast' }, async (_c, _n, call) => {
			if (call === 1) await held.promise;
			return quiet();
		});
		const visit = await enter(session);
		await visit.send({ text: 'go' });
		// the wake is sent and the activation holds it: the room still waits
		await session.reconcile();
		expect([...sentBy(session).keys()]).toEqual(['message:4:solo:1']);

		held.resolve();
		await waitForRoom(session);
		// the activation released, so the fold owes nothing and the room holds nothing
		expect([...sentBy(session).keys()]).toEqual([]);
	});
});
