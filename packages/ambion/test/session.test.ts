import type { Context } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	InMemorySessionRepo,
	inProcessTransport,
	isSpoken,
	type Message,
	passive,
	readSession,
	startSession,
	stopSession,
	visitSession,
} from '../src/index.ts';
import { andrei, assistant, collect, deferred, enter, roomName } from './support/room.ts';
import { byAgent, contextText, quiet, scripted, speak } from './support/scripted.ts';

/** The record's spoken half, which is what most of these tests are about. */
const spoken = (messages: Message[]) => messages.filter(isSpoken);

// -- the milestone tests -----------------------------------------------------

describe('startSession', () => {
	it('activates idle agents in parallel, steers a working colleague, wakes an idle one', async () => {
		const gammaIdle = deferred();
		const alphaSaid = deferred();
		const alpha = defineAgent({
			name: 'alpha',
			identity: 'Answers questions.',
			instructions: 'answer',
			model: 'scripted/alpha',
		});
		const beta = defineAgent({
			name: 'beta',
			identity: 'Acknowledges answers.',
			instructions: 'ack',
			model: 'scripted/beta',
		});
		const gamma = defineAgent({
			name: 'gamma',
			identity: 'Rarely relevant.',
			instructions: 'quiet',
			model: 'scripted/gamma',
		});
		const betaContexts: string[] = [];
		let betaAcked = false;
		const session = startSession({
			name: roomName('parallel'),
			assistant,
			agents: [alpha, beta, gamma],
			streamFn: scripted(
				byAgent({
					alpha: async (_context, _agent, call) => {
						if (call !== 1) return quiet();
						await gammaIdle.promise; // let gamma go idle before alpha speaks
						return speak('the answer is 42');
					},
					// beta: hold the first activation open until alpha has spoken, so
					// the reply reaches beta as a mid-activation arrival, not fresh context.
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
			),
		});
		const events = collect(session);
		session.subscribe((event) => {
			if (event.type === 'activation_end' && event.agent === 'gamma') gammaIdle.resolve();
			if (event.type === 'message' && event.message.from === 'alpha') alphaSaid.resolve();
		});

		const visit = await enter(session);
		await visit.deliver({ text: 'What is the answer?' });
		await session.settled();

		const texts = spoken(await session.messages()).map((m) => `${m.from}: ${m.text}`);
		expect(texts).toContain('alpha: the answer is 42');
		expect(texts).toContain('beta: ack: 42');
		expect(texts).toHaveLength(3); // woken seats declined: glances, not messages
		// beta answered with alpha's reply in view, delivered mid-activation or on re-read
		expect(betaContexts.some((c) => c.includes('the answer is 42'))).toBe(true);
		// a say wakes the idle room: gamma, idle when alpha spoke, glanced again —
		// and the exchange still settled, because woken seats with nothing to add decline
		const gammaStarts = events.filter(
			(e) => e.type === 'activation_start' && e.agent === 'gamma',
		).length;
		expect(gammaStarts).toBeGreaterThanOrEqual(2);
	});

	it('resets the working view at idle: a new activation reads the record, not the old activation', async () => {
		const contexts: Context[] = [];
		const echo = defineAgent({
			name: 'echo',
			identity: 'Echoes.',
			instructions: 'echo',
			model: 'scripted/echo',
		});
		const session = startSession({
			name: roomName('reset'),
			assistant,
			agents: [echo],
			// a say costs a second call for the tool result, so the two deliveries
			// speak on 1 and 3; arrivals are quiet and wake nobody.
			streamFn: scripted((context, _agent, call) => {
				contexts.push(context);
				return call % 2 === 1 ? speak(`echo ${call}`) : quiet();
			}),
		});
		const visit = await enter(session);
		await visit.deliver({ text: 'one' });
		await session.settled();
		await visit.deliver({ text: 'two' });
		await session.settled();

		// The second activation starts from a single fresh transcript message —
		// no assistant turns carried over from the first activation.
		const second = contexts[2];
		expect(second).toBeDefined();
		expect(second?.messages).toHaveLength(1);
		const view = contextText(second as Context);
		expect(view).toContain('one');
		expect(view).toContain('echo 1');
		expect(view).toContain('two');
	});

	it('leaves no mark on the record when an agent declines', async () => {
		const shy = defineAgent({
			name: 'shy',
			identity: 'Speaks only when required.',
			instructions: 'stay quiet',
			model: 'scripted/shy',
		});
		const session = startSession({
			name: roomName('silence'),
			assistant,
			agents: [shy],
			streamFn: scripted(() => quiet('not for me')),
		});
		const events = collect(session);
		await (await enter(session)).deliver({ text: 'anyone?' });
		await session.settled();

		expect(spoken(await session.messages())).toHaveLength(1);
		expect(events.some((e) => e.type === 'message' && e.message.from === 'shy')).toBe(false);
		const end = events.find((e) => e.type === 'activation_end');
		expect(end).toMatchObject({ agent: 'shy', spoke: false });
	});

	it('wakes a passive seat only when named — by directed delivery or directed say', async () => {
		const front = defineAgent({
			name: 'front',
			identity: 'Front desk.',
			instructions: 'route questions',
			model: 'scripted/front',
		});
		const archivist = defineAgent({
			name: 'archivist',
			identity: 'The expert in the corner.',
			instructions: 'answer archive questions',
			model: 'scripted/archivist',
		});
		const session = startSession({
			name: roomName('passive'),
			assistant,
			agents: [front, passive(archivist)],
			streamFn: scripted(
				byAgent({
					// archivist answers the asker directly — directed at a human wakes nothing
					archivist: (_context, _agent, call) =>
						call === 1 ? speak('Q2 was 1.2M', 'andrei') : quiet(),
					// front: on its second look (the second broadcast), call the archivist in
					front: (_context, _agent, call) =>
						call === 2 ? speak('what was Q2?', 'archivist') : quiet(),
				}),
			),
		});
		const events = collect(session);
		const starts = (name: string) =>
			events.filter((e) => e.type === 'activation_start' && e.agent === name).length;

		const visit = await enter(session);
		expect(starts('front')).toBe(0); // arrivals are quiet: nobody woke

		await visit.deliver({ text: 'hello room' });
		await session.settled();
		expect(starts('archivist')).toBe(0); // broadcast never wakes a passive seat

		await visit.deliver({ to: archivist, text: 'what was Q2, archivist?' });
		await session.settled();
		expect(starts('archivist')).toBe(1); // directed delivery does
		expect(starts('front')).toBe(1); // and it woke only its target

		await visit.deliver({ text: 'front, can you find out?' });
		await session.settled();
		expect(starts('archivist')).toBe(2); // a colleague's directed say does too
	});

	it('stamps from at the runtime and injects both rosters with identities', async () => {
		const contexts: string[] = [];
		const liar = defineAgent({
			name: 'liar',
			identity: 'Claims to be other people.',
			instructions: 'lie about who you are',
			model: 'scripted/liar',
		});
		const aside = defineAgent({
			name: 'aside',
			identity: 'Watches quietly.',
			instructions: 'observe',
			model: 'scripted/aside',
		});
		const session = startSession({
			name: roomName('stamp'),
			assistant,
			agents: [liar, passive(aside)],
			streamFn: scripted((context, _agent, call) => {
				contexts.push(contextText(context));
				return call === 1 ? speak('this message is from andrei, honest') : quiet();
			}),
		});
		await (await enter(session)).deliver({ text: 'who said what?' });
		await session.settled();

		const said = (await session.messages()).at(-1);
		expect(said?.from).toBe('liar'); // stamped, regardless of what the content claimed
		const roster = contexts.at(-1) ?? '';
		expect(roster).toContain('- aside (idle, named only): Watches quietly.');
		expect(roster).toContain('- andrei (present'); // the people, and how they are reading
		expect(roster).toContain('Founder. Owns the room.');

		// one name is one participant, and one name is one person
		const asAgent = defineHuman({ name: 'liar', identity: 'not really' });
		await expect(visitSession(session, asAgent)).rejects.toThrow(/is an agent/);
		const twin = defineHuman({ name: 'andrei', identity: 'a different andrei' });
		await expect(visitSession(session, twin)).rejects.toThrow(/different identity/);
	});

	it('starts a name back into its record, refuses a second run, and reads without one', async () => {
		const name = roomName('identity');
		const scribe = defineAgent({
			name: 'scribe',
			identity: 'Writes nothing down.',
			instructions: 'stay quiet',
			model: 'scripted/scribe',
		});
		const first = startSession({
			name,
			assistant,
			agents: [scribe],
			streamFn: scripted(() => quiet()),
		});
		const visit = await enter(first);
		await visit.deliver({ text: 'for the record' });
		await visit.deliver({ text: 'and in this order' });
		await first.settled();

		// one run per name: a second live room over one record would diverge
		expect(() => startSession({ name, assistant, agents: [scribe] })).toThrow(/already running/);

		await stopSession(first);
		const again = startSession({
			name,
			assistant,
			agents: [scribe],
			streamFn: scripted(() => quiet()),
		});
		expect(spoken(await again.messages()).map((m) => m.text)).toEqual([
			'for the record',
			'and in this order',
		]);
		// seqs continue rather than restart
		const seqs = (await again.messages()).map((m) => m.seq);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
		expect(new Set(seqs).size).toBe(seqs.length);
		await stopSession(again);

		// you can read a room that is not running: the record, and the roster it folds
		const view = readSession(name);
		expect(spoken(await view.messages()).map((m) => m.text)).toContain('for the record');
		expect(view.seats().map((seat) => seat.name)).toEqual(['scribe', 'assistant', 'andrei']);
		expect(view.seats().every((seat) => seat.kind === 'human' || seat.status === 'idle')).toBe(
			true,
		);

		const fresh = startSession({
			name: roomName('identity'),
			assistant,
			agents: [scribe],
			streamFn: scripted(() => quiet()),
		});
		expect(await fresh.messages()).toHaveLength(0);
	});

	it('streams events in order, surfaces errors as events, and aborts to a quiet room', async () => {
		const solo = defineAgent({
			name: 'solo',
			identity: 'Speaks once.',
			instructions: 'speak',
			model: 'scripted/solo',
		});
		const ordered = startSession({
			name: roomName('events'),
			assistant,
			agents: [solo],
			streamFn: scripted((_context, _agent, call) => (call === 1 ? speak('hi') : quiet())),
		});
		const orderedVisit = await enter(ordered);
		const events = collect(ordered);
		await orderedVisit.deliver({ text: 'say hi' });
		await ordered.settled();
		// one event per message on the record, whoever wrote it, and the exchange
		// that message opened around it. One answer needs no summary, so the room
		// goes quiet in the same tick the exchange closes: nothing is owed.
		expect(events.map((e) => e.type)).toEqual([
			'message',
			'exchange_opened',
			'activation_start',
			'message',
			'activation_end',
			'exchange_closed',
			'quiet',
		]);
		expect(events.flatMap((e) => (e.type === 'message' ? [e.message.from] : []))).toEqual([
			'andrei',
			'solo',
		]);

		// an activation that throws is an error event, never a silent decline
		const faulty = startSession({
			name: roomName('error'),
			assistant,
			agents: [solo],
			streamFn: scripted(() => {
				throw new Error('boom');
			}),
		});
		const faultVisit = await visitSession(faulty, andrei);
		const faultEvents = collect(faulty);
		const failed = new Promise<void>((resolve) => {
			faulty.subscribe((e) => {
				if (e.type === 'activation_end') resolve();
			});
		});
		await faultVisit.deliver({ text: 'trigger' });
		await failed;
		expect(faultEvents.some((e) => e.type === 'error' && e.agent === 'solo')).toBe(true);
		expect(spoken(await faulty.messages())).toHaveLength(1);
		// the failed activation is one attempt: the wake is pending again after the
		// backoff, so the room is still working, and only an abort settles it now
		faulty.abort();
		await faulty.settled();

		// abort quiets an active room, keeping what was already said
		const hung = startSession({
			name: roomName('abort'),
			assistant,
			agents: [solo],
			streamFn: scripted(() => new Promise<never>(() => {})),
		});
		const hungVisit = await visitSession(hung, andrei);
		const hungEvents = collect(hung);
		await hungVisit.deliver({ text: 'hang' });
		hung.abort();
		await hung.settled();
		expect(hungEvents.some((e) => e.type === 'error')).toBe(false);
		expect(spoken(await hung.messages())).toHaveLength(1);

		// an abort with a steer still queued must not rebuild the activation it cancelled
		let racingCalls = 0;
		const racingStarted = deferred();
		const racing = startSession({
			name: roomName('abort-steer'),
			assistant,
			agents: [solo],
			streamFn: scripted(() => {
				racingCalls += 1;
				racingStarted.resolve();
				return new Promise<never>(() => {});
			}),
		});
		const racingVisit = await visitSession(racing, andrei);
		await racingVisit.deliver({ text: 'hang' });
		await racingStarted.promise;
		await racingVisit.deliver({ text: 'mid-turn note' }); // queues a steer into the hung run
		racing.abort();
		await racing.settled();
		expect(racingCalls).toBe(1);
		expect(spoken(await racing.messages())).toHaveLength(2);
	});

	it('fails a say that races past the record, delivering what was missed', async () => {
		// Two seats answer the same broadcast; the slower one commits blind.
		// The losing say must fail back with the winner's message, and the
		// retry — now with the point in view — must commit cleanly.
		const firstSaid = deferred();
		const first = defineAgent({
			name: 'first',
			identity: 'Fast.',
			instructions: 'answer',
			model: 'scripted/first',
		});
		const second = defineAgent({
			name: 'second',
			identity: 'Slow.',
			instructions: 'answer',
			model: 'scripted/second',
		});
		const secondContexts: string[] = [];
		const session = startSession({
			name: roomName('race'),
			assistant,
			agents: [first, second],
			streamFn: scripted(
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
			),
		});
		const events = collect(session);
		const visit = await enter(session);
		session.subscribe((event) => {
			if (event.type === 'message' && event.message.from === 'first') firstSaid.resolve();
		});
		await visit.deliver({ text: 'thoughts?' });
		await session.settled();

		const texts = spoken(await session.messages()).map((m) => m.text);
		expect(texts).toEqual(['thoughts?', 'the point', 'a genuinely different angle']);
		const conflicts = events.filter((e) => e.type === 'conflict');
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0]).toMatchObject({ author: 'second' });
		const missed = conflicts[0]?.type === 'conflict' ? conflicts[0].missed[0] : undefined;
		expect(missed && isSpoken(missed) && missed.text).toBe('the point');
		// the failure reached the model as a tool result carrying the missed line
		expect(secondContexts[1]).toContain('Not delivered');
		expect(secondContexts[1]).toContain('the point');

		// standing down after a conflict leaves no mark, like any decline
		const yieldSaid = deferred();
		const yielding = startSession({
			name: roomName('race-yield'),
			assistant,
			agents: [first, second],
			streamFn: scripted(
				byAgent({
					first: (_context, _agent, call) => (call === 1 ? speak('the point') : quiet()),
					second: async (_context, _agent, call) => {
						if (call !== 1) return quiet('point already made');
						await yieldSaid.promise;
						return speak('me too');
					},
				}),
			),
		});
		const yieldVisit = await enter(yielding);
		const yieldEvents = collect(yielding);
		yielding.subscribe((event) => {
			if (event.type === 'message' && event.message.from === 'first') yieldSaid.resolve();
		});
		await yieldVisit.deliver({ text: 'thoughts?' });
		await yielding.settled();

		expect(spoken(await yielding.messages())).toHaveLength(2);
		const end = yieldEvents.find((e) => e.type === 'activation_end' && e.agent === 'second');
		expect(end).toMatchObject({ spoke: false });
	});

	it("keeps each seat's turns in a downstream Pi session, parented to the room", async () => {
		const repo = new InMemorySessionRepo();
		const solo = defineAgent({
			name: 'solo',
			identity: 'Speaks once.',
			instructions: 'speak',
			model: 'scripted/solo',
		});
		const name = roomName('downstream');
		const session = startSession({
			name,
			assistant,
			agents: [solo],
			repo,
			streamFn: scripted((_context, _agent, call) => (call === 1 ? speak('hi') : quiet())),
		});
		await (await enter(session)).deliver({ text: 'say hi' });
		await session.settled();

		const seat = session.seats().find((s) => s.name === 'solo');
		expect(seat?.kind === 'agent' && seat.sessionId).toBe(`${name}:solo`);

		const metadata = (await repo.list()).find((m) => m.id === `${name}:solo`);
		expect(metadata?.parentSessionId).toBe(name);
		const piSeat = await repo.open(metadata as NonNullable<typeof metadata>);
		const entries = await piSeat.findEntries();
		// an activation boundary plus the run's full turns — context, say call, tool result, close
		expect(entries.some((e) => e.type === 'custom' && e.customType === 'ambion/activation')).toBe(
			true,
		);
		const turns = entries.filter((e) => e.type === 'message');
		expect(turns.length).toBeGreaterThanOrEqual(3);
		expect(JSON.stringify(turns)).toContain('"say"');
	});

	it('lands a repeated delivery key once', async () => {
		const echo = defineAgent({
			name: 'echo',
			identity: 'Echoes.',
			instructions: 'echo',
			model: 'scripted/echo',
		});
		const session = startSession({
			name: roomName('keys'),
			assistant,
			agents: [echo],
			streamFn: scripted(() => quiet()),
		});
		const events = collect(session);
		const visit = await enter(session);
		await visit.deliver({ text: 'once', key: 'delivery-1' });
		await visit.deliver({ text: 'once, retried', key: 'delivery-1' });
		await session.settled();

		const said = spoken(await session.messages());
		expect(said.map((m) => [m.seq, m.text, m.key])).toEqual([[2, 'once', 'delivery-1']]);
		// one message, one event, one activation
		expect(events.filter((e) => e.type === 'message' && e.message.kind === 'said')).toHaveLength(1);
		expect(events.filter((e) => e.type === 'activation_start')).toHaveLength(1);
		// a seat's say carries Pi's tool call id, and a person's delivery its key
		expect(said[0]?.key).toBe('delivery-1');
		await stopSession(session);
	});

	it('refuses a composition that seats a name the record knows as a person', async () => {
		const repo = new InMemorySessionRepo();
		const name = roomName('clash');
		const first = startSession({ name, assistant, repo, streamFn: scripted(() => quiet()) });
		await visitSession(first, andrei);
		await stopSession(first);

		const impostor = defineAgent({
			name: 'andrei',
			identity: "An agent wearing a person's name.",
			instructions: 'confuse',
			model: 'scripted/impostor',
		});
		const again = startSession({
			name,
			assistant,
			agents: [impostor],
			repo,
			streamFn: scripted(() => quiet()),
		});
		// the record is replayed by the first call, and that call is refused
		await expect(again.messages()).rejects.toThrow(/one name names one participant/);
		await expect(visitSession(again, andrei)).rejects.toThrow(/one name names one participant/);
		await expect(stopSession(again)).rejects.toThrow(/one name names one participant/);
	});

	it('frees the name a refused start took, without a stop', async () => {
		const repo = new InMemorySessionRepo();
		const name = roomName('refused');
		const first = startSession({ name, assistant, repo, streamFn: scripted(() => quiet()) });
		await visitSession(first, andrei);
		await stopSession(first);

		const impostor = defineAgent({
			name: 'andrei',
			identity: "An agent wearing a person's name.",
			instructions: 'confuse',
			model: 'scripted/impostor',
		});
		const refused = startSession({
			name,
			assistant,
			agents: [impostor],
			repo,
			streamFn: scripted(() => quiet()),
		});
		await expect(refused.messages()).rejects.toThrow(/one name names one participant/);
		// nothing runs under the name, and the host never stopped the handle it holds:
		// a composition that stands takes the name and reads the record the first run left
		const again = startSession({ name, assistant, repo, streamFn: scripted(() => quiet()) });
		expect((await again.messages()).map((m) => m.from)).toEqual(['andrei', 'andrei']);
		await stopSession(again);
	});

	it('refuses a delivery directed at the assistant, which wakes for nothing said', async () => {
		const alone = defineAgent({
			name: 'alone',
			identity: 'The one agent.',
			instructions: 'answer',
			model: 'scripted/alone',
		});
		const session = startSession({
			name: roomName('directed'),
			assistant,
			agents: [alone],
			streamFn: scripted(() => quiet()),
		});
		const visit = await enter(session);
		await expect(visit.deliver({ to: assistant, text: 'Write it up for me.' })).rejects.toThrow(
			/wakes for nothing said/,
		);
		// and nothing landed: the record holds the arrival alone
		expect((await session.messages()).map((m) => m.kind)).toEqual(['arrived']);
		await stopSession(session);
	});

	it('tells the seat side to stop, over the wire, when it cuts a lease', async () => {
		const hangs = deferred();
		const solo = defineAgent({
			name: 'solo',
			identity: 'Never stops.',
			instructions: 'wait',
			model: 'scripted/solo',
		});
		// a transport of the host's own: the room reaches it through the wire alone
		const cuts: string[] = [];
		const inProcess = inProcessTransport();
		const runtime = createRuntime({
			transport: {
				connect: (room, seat, host) => {
					const port = inProcess.connect(room, seat, host);
					return {
						wake: (wake) => port.wake(wake),
						cut: (activation) => {
							cuts.push(activation);
							return port.cut(activation);
						},
					};
				},
			},
		});
		const session = startSession({
			name: roomName('cut'),
			assistant,
			agents: [solo],
			runtime,
			streamFn: scripted(async () => {
				hangs.resolve();
				return new Promise<never>(() => {});
			}),
		});
		const visit = await enter(session);
		await visit.deliver({ text: 'wait for me' });
		await hangs.promise;
		session.abort();
		await session.quiet();
		// the room ended the lease and told the seat, and the seat stopped: the room is idle
		expect(cuts).toEqual(['2:solo']);
		expect(session.seats().find((s) => s.name === 'solo')).toMatchObject({ status: 'idle' });
		await stopSession(session);
	});

	it('answers a commit from a lease that ended stale, before what the record moved past', async () => {
		const solo = defineAgent({
			name: 'solo',
			identity: 'Speaks once.',
			instructions: 'speak',
			model: 'scripted/solo',
		});
		// the seats hear no wake, so the test holds the seat's side of the wire itself
		const runtime = createRuntime({
			transport: { connect: () => ({ wake: async () => {}, cut: async () => {} }) },
		});
		const session = startSession({
			name: roomName('stale'),
			assistant,
			agents: [solo],
			runtime,
			streamFn: scripted(() => quiet()),
		});
		const events = collect(session);
		const visit = await enter(session);
		await visit.deliver({ text: 'first' });
		const room = runtime.running.get(session.name);
		if (room === undefined) throw new Error('the room is not running');
		expect(await room.lease({ activation: '2:solo', phase: 'running' })).toMatchObject({ ok: {} });
		// the record moves past what the activation read, and then its lease ends
		await visit.deliver({ text: 'second' });
		await room.lease({ activation: '2:solo', phase: 'ended', reason: 'released' });
		const late = await room.commit({
			activation: '2:solo',
			key: 'late',
			readThrough: 2,
			intent: { kind: 'said', text: 'too late' },
		});
		// stale, not missed: nothing this activation writes lands, whatever the record did,
		// so the room reports no conflict for a seat that has nothing to redraft
		expect(late).toEqual({ stale: 'the lease ended' });
		expect(events.some((event) => event.type === 'conflict')).toBe(false);
		await stopSession(session);
	});

	it('refuses a duplicate agent name', () => {
		const twin = defineAgent({
			name: 'solo',
			identity: 'An agent wearing a name already taken.',
			instructions: 'confuse',
			model: 'scripted/twin',
		});
		expect(() =>
			startSession({
				name: roomName('dupe'),
				assistant,
				agents: [twin, twin],
				streamFn: scripted(() => quiet()),
			}),
		).toThrow(/one name names one participant/);
	});
});
