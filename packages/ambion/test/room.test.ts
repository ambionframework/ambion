import type { Context } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { runningRoom } from '../src/host/runtime.ts';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	isSpoken,
	type Message,
	pi,
	type Room,
	readRoom,
	startRoom,
} from '../src/index.ts';
import { inProcessTransport, seatSessionId } from '../src/transport.ts';
import {
	andrei,
	assistant,
	collect,
	deferred,
	enter,
	messagesOf,
	participantsOf,
	roomName,
	waitForRoom,
} from './support/room.ts';
import { byAgent, contextText, quiet, scripted, speak } from './support/scripted.ts';
import { memory } from './support/storage.ts';

/** The record's spoken half, which is what most of these tests are about. */
const spoken = (messages: readonly Message[]) => messages.filter(isSpoken);

// -- the milestone tests -----------------------------------------------------

describe('startRoom', () => {
	it('activates idle agents in parallel, steers a working colleague, wakes an idle one', async () => {
		const gammaIdle = deferred();
		const alphaSaid = deferred();
		const alpha = defineAgent({
			name: 'alpha',
			identity: 'Answers questions.',
			executor: pi({ instructions: 'answer', model: 'scripted/alpha' }),
		});
		const beta = defineAgent({
			name: 'beta',
			identity: 'Acknowledges answers.',
			executor: pi({ instructions: 'ack', model: 'scripted/beta' }),
		});
		const gamma = defineAgent({
			name: 'gamma',
			identity: 'Rarely relevant.',
			executor: pi({ instructions: 'quiet', model: 'scripted/gamma' }),
		});
		const betaContexts: string[] = [];
		let betaAcked = false;
		const session = await startRoom({
			name: roomName('parallel'),
			seats: {
				[alpha.name]: 'broadcast',
				[beta.name]: 'broadcast',
				[gamma.name]: 'broadcast',
				[assistant.name]: 'none',
			},
			agents: [alpha, beta, gamma, assistant],
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
		await visit.send({ text: 'What is the answer?' });
		await waitForRoom(session);

		const texts = spoken(await messagesOf(session)).map((m) => `${m.from}: ${m.text}`);
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
			executor: pi({ instructions: 'echo', model: 'scripted/echo' }),
		});
		const session = await startRoom({
			name: roomName('reset'),
			seats: { [echo.name]: 'broadcast', [assistant.name]: 'none' },
			agents: [echo, assistant],
			// a say costs a second call for the tool result, so the two deliveries
			// speak on 1 and 3; arrivals are quiet and wake nobody.
			streamFn: scripted((context, _agent, call) => {
				contexts.push(context);
				return call % 2 === 1 ? speak(`echo ${call}`) : quiet();
			}),
		});
		const visit = await enter(session);
		await visit.send({ text: 'one' });
		await waitForRoom(session);
		await visit.send({ text: 'two' });
		await waitForRoom(session);

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
			executor: pi({ instructions: 'stay quiet', model: 'scripted/shy' }),
		});
		const session = await startRoom({
			name: roomName('silence'),
			seats: { [shy.name]: 'broadcast', [assistant.name]: 'none' },
			agents: [shy, assistant],
			streamFn: scripted(() => quiet('not for me')),
		});
		const events = collect(session);
		await (await enter(session)).send({ text: 'anyone?' });
		await waitForRoom(session);

		expect(spoken(await messagesOf(session))).toHaveLength(1);
		expect(events.some((e) => e.type === 'message' && e.message.from === 'shy')).toBe(false);
		const end = events.find((e) => e.type === 'activation_end');
		expect(end).toMatchObject({ agent: 'shy', spoke: false });
	});

	it('wakes a passive seat only when named — by directed delivery or directed say', async () => {
		const front = defineAgent({
			name: 'front',
			identity: 'Front desk.',
			executor: pi({ instructions: 'route questions', model: 'scripted/front' }),
		});
		const archivist = defineAgent({
			name: 'archivist',
			identity: 'The expert in the corner.',
			executor: pi({ instructions: 'answer archive questions', model: 'scripted/archivist' }),
		});
		const session = await startRoom({
			name: roomName('passive'),

			agents: [front, archivist, assistant],
			seats: { [assistant.name]: 'none', [front.name]: 'broadcast', [archivist.name]: 'named' },
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

		await visit.send({ text: 'hello room' });
		await waitForRoom(session);
		expect(starts('archivist')).toBe(0); // broadcast never wakes a passive seat

		await visit.send({ to: archivist.name, text: 'what was Q2, archivist?' });
		await waitForRoom(session);
		expect(starts('archivist')).toBe(1); // directed delivery does
		expect(starts('front')).toBe(1); // and it woke only its target

		await visit.send({ text: 'front, can you find out?' });
		await waitForRoom(session);
		expect(starts('archivist')).toBe(2); // a colleague's directed say does too
	});

	it('stamps from at the runtime and injects both rosters with identities', async () => {
		const contexts: string[] = [];
		const liar = defineAgent({
			name: 'liar',
			identity: 'Claims to be other people.',
			executor: pi({ instructions: 'lie about who you are', model: 'scripted/liar' }),
		});
		const aside = defineAgent({
			name: 'aside',
			identity: 'Watches quietly.',
			executor: pi({ instructions: 'observe', model: 'scripted/aside' }),
		});
		const session = await startRoom({
			name: roomName('stamp'),

			agents: [liar, aside, assistant],
			seats: { [assistant.name]: 'none', [liar.name]: 'broadcast', [aside.name]: 'named' },
			streamFn: scripted((context, _agent, call) => {
				contexts.push(contextText(context));
				return call === 1 ? speak('this message is from andrei, honest') : quiet();
			}),
		});
		await (await enter(session)).send({ text: 'who said what?' });
		await waitForRoom(session);

		const said = (await messagesOf(session)).at(-1);
		expect(said?.from).toBe('liar'); // stamped, regardless of what the content claimed
		const roster = contexts.at(-1) ?? '';
		expect(roster).toContain('- aside (idle, named only): Watches quietly.');
		expect(roster).toContain('- andrei (present'); // the people, and how they are reading
		expect(roster).toContain('Founder. Owns the room.');

		// one name is one participant, and one name is one person
		const asAgent = defineHuman({ name: 'liar', identity: 'not really' });
		await expect(session.visit(asAgent)).rejects.toThrow(/is an agent/);
		const twin = defineHuman({ name: 'andrei', identity: 'a different andrei' });
		await expect(session.visit(twin)).rejects.toThrow(/different identity/);
	});

	it('starts a name back into its record, refuses a second run, and reads without one', async () => {
		const name = roomName('identity');
		const scribe = defineAgent({
			name: 'scribe',
			identity: 'Writes nothing down.',
			executor: pi({ instructions: 'stay quiet', model: 'scripted/scribe' }),
		});
		const first = await startRoom({
			name,
			seats: { [scribe.name]: 'broadcast', [assistant.name]: 'none' },
			agents: [scribe, assistant],
			streamFn: scripted(() => quiet()),
		});
		const visit = await enter(first);
		await visit.send({ text: 'for the record' });
		await visit.send({ text: 'and in this order' });
		await waitForRoom(first);

		// one run per name: a second live room over one record would diverge
		await expect(
			startRoom({
				name,
				seats: { [scribe.name]: 'broadcast', [assistant.name]: 'none' },
				agents: [scribe, assistant],
			}),
		).rejects.toThrow(/already running/);

		await first.stop();
		const again = await startRoom({
			name,
			seats: { [scribe.name]: 'broadcast', [assistant.name]: 'none' },
			agents: [scribe, assistant],
			streamFn: scripted(() => quiet()),
		});
		expect(spoken(await messagesOf(again)).map((m) => m.text)).toEqual([
			'for the record',
			'and in this order',
		]);
		// seqs continue rather than restart
		const seqs = (await messagesOf(again)).map((m) => m.seq);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
		expect(new Set(seqs).size).toBe(seqs.length);
		await again.stop();

		// you can read a room that is not running: the record, and the roster it folds
		const view = await readRoom(name);
		expect(spoken(view.messages).map((m) => m.text)).toContain('for the record');
		expect(view.participants.map((seat) => seat.name)).toEqual(['scribe', 'assistant', 'andrei']);
		expect(view.participants.every((seat) => seat.kind === 'human' || seat.status === 'idle')).toBe(
			true,
		);

		const fresh = await startRoom({
			name: roomName('identity'),
			seats: { [scribe.name]: 'broadcast', [assistant.name]: 'none' },
			agents: [scribe, assistant],
			streamFn: scripted(() => quiet()),
		});
		expect(await messagesOf(fresh)).toHaveLength(0);
	});

	it('streams events in order, surfaces errors as events, and aborts to a quiet room', async () => {
		const solo = defineAgent({
			name: 'solo',
			identity: 'Speaks once.',
			executor: pi({ instructions: 'speak', model: 'scripted/solo' }),
		});
		const ordered = await startRoom({
			name: roomName('events'),
			seats: { [solo.name]: 'broadcast', [assistant.name]: 'none' },
			agents: [solo, assistant],
			streamFn: scripted((_context, _agent, call) => (call === 1 ? speak('hi') : quiet())),
		});
		const orderedVisit = await enter(ordered);
		const events = collect(ordered);
		await orderedVisit.send({ text: 'say hi' });
		await waitForRoom(ordered);
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
		]);
		expect(events.flatMap((e) => (e.type === 'message' ? [e.message.from] : []))).toEqual([
			'andrei',
			'solo',
		]);

		// an activation that throws is an error event, never a silent decline
		const faulty = await startRoom({
			name: roomName('error'),
			seats: { [solo.name]: 'broadcast', [assistant.name]: 'none' },
			agents: [solo, assistant],
			streamFn: scripted(() => {
				throw new Error('boom');
			}),
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

		// abort quiets an active room, keeping what was already said
		const hung = await startRoom({
			name: roomName('abort'),
			seats: { [solo.name]: 'broadcast', [assistant.name]: 'none' },
			agents: [solo, assistant],
			streamFn: scripted(() => new Promise<never>(() => {})),
		});
		const hungVisit = await hung.visit(andrei);
		const hungEvents = collect(hung);
		await hungVisit.send({ text: 'hang' });
		await hung.abort();
		await waitForRoom(hung);
		expect(hungEvents.some((e) => e.type === 'error')).toBe(false);
		expect(spoken(await messagesOf(hung))).toHaveLength(1);

		// an abort with a steer still queued must not rebuild the activation it cancelled
		let racingCalls = 0;
		const racingStarted = deferred();
		const racing = await startRoom({
			name: roomName('abort-steer'),
			seats: { [solo.name]: 'broadcast', [assistant.name]: 'none' },
			agents: [solo, assistant],
			streamFn: scripted(() => {
				racingCalls += 1;
				racingStarted.resolve();
				return new Promise<never>(() => {});
			}),
		});
		const racingVisit = await racing.visit(andrei);
		await racingVisit.send({ text: 'hang' });
		await racingStarted.promise;
		await racingVisit.send({ text: 'mid-turn note' }); // queues a steer into the hung run
		await racing.abort();
		await waitForRoom(racing);
		expect(racingCalls).toBe(1);
		expect(spoken(await messagesOf(racing))).toHaveLength(2);
	});

	it('fails a say that races past the record, delivering what was missed', async () => {
		// Two seats answer the same broadcast; the slower one commits blind.
		// The losing say must fail back with the winner's message, and the
		// retry — now with the point in view — must commit cleanly.
		const firstSaid = deferred();
		const first = defineAgent({
			name: 'first',
			identity: 'Fast.',
			executor: pi({ instructions: 'answer', model: 'scripted/first' }),
		});
		const second = defineAgent({
			name: 'second',
			identity: 'Slow.',
			executor: pi({ instructions: 'answer', model: 'scripted/second' }),
		});
		const secondContexts: string[] = [];
		const session = await startRoom({
			name: roomName('race'),
			seats: { [first.name]: 'broadcast', [second.name]: 'broadcast', [assistant.name]: 'none' },
			agents: [first, second, assistant],
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
		await visit.send({ text: 'thoughts?' });
		await waitForRoom(session);

		const texts = spoken(await messagesOf(session)).map((m) => m.text);
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
		const yielding = await startRoom({
			name: roomName('race-yield'),
			seats: { [first.name]: 'broadcast', [second.name]: 'broadcast', [assistant.name]: 'none' },
			agents: [first, second, assistant],
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
		await yieldVisit.send({ text: 'thoughts?' });
		await waitForRoom(yielding);

		expect(spoken(await messagesOf(yielding))).toHaveLength(2);
		const end = yieldEvents.find((e) => e.type === 'activation_end' && e.agent === 'second');
		expect(end).toMatchObject({ spoke: false });
	});

	it("keeps each seat's turns in a downstream Pi session, parented to the room", async () => {
		const opened = await memory.open();
		const runtime = createRuntime({ storage: opened.storage });
		const solo = defineAgent({
			name: 'solo',
			identity: 'Speaks once.',
			executor: pi({ instructions: 'speak', model: 'scripted/solo' }),
		});
		const name = roomName('downstream');
		const session = await startRoom({
			name,
			seats: { [solo.name]: 'broadcast', [assistant.name]: 'none' },
			agents: [solo, assistant],
			runtime,
			streamFn: scripted((_context, _agent, call) => (call === 1 ? speak('hi') : quiet())),
		});
		await (await enter(session)).send({ text: 'say hi' });
		await waitForRoom(session);

		const seat = (await participantsOf(session)).find((s) => s.name === 'solo');
		if (seat?.kind !== 'agent') throw new Error('The solo seat is absent.');
		const id = seatSessionId(name, seat.name);
		const piSeat = await runtime.transcripts.open(id);
		expect(await piSeat.getMetadata()).toMatchObject({
			id,
			parentSessionId: name,
		});
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
			executor: pi({ instructions: 'echo', model: 'scripted/echo' }),
		});
		const session = await startRoom({
			name: roomName('keys'),
			seats: { [echo.name]: 'broadcast', [assistant.name]: 'none' },
			agents: [echo, assistant],
			streamFn: scripted(() => quiet()),
		});
		const events = collect(session);
		const visit = await enter(session);
		await visit.send({ text: 'once', key: 'delivery-1' });
		await visit.send({ text: 'once', key: 'delivery-1' });
		await waitForRoom(session);

		const said = spoken(await messagesOf(session));
		expect(said.map((m) => [m.seq, m.text, m.key])).toEqual([[4, 'once', 'delivery-1']]);
		// one message, one event, one activation
		expect(events.filter((e) => e.type === 'message' && e.message.kind === 'said')).toHaveLength(1);
		expect(events.filter((e) => e.type === 'activation_start')).toHaveLength(1);
		// a seat's say carries Pi's tool call id, and a person's delivery its key
		expect(said[0]?.key).toBe('delivery-1');
		await session.stop();
	});

	it('refuses a composition that seats a name the record knows as a person', async () => {
		const opened = await memory.open();
		const runtime = createRuntime({ storage: opened.storage });
		const name = roomName('clash');
		const first = await startRoom({
			name,
			seats: { [assistant.name]: 'none' },
			agents: [assistant],
			runtime,
			streamFn: scripted(() => quiet()),
		});
		await first.visit(andrei);
		await first.stop();

		const impostor = defineAgent({
			name: 'andrei',
			identity: "An agent wearing a person's name.",
			executor: pi({ instructions: 'confuse', model: 'scripted/impostor' }),
		});
		await expect(
			startRoom({
				name,
				seats: { [impostor.name]: 'broadcast', [assistant.name]: 'none' },
				agents: [impostor, assistant],
				runtime,
				streamFn: scripted(() => quiet()),
			}),
		).rejects.toThrow(/one name names one participant/);
	});

	it('frees the name a refused start took, without a stop', async () => {
		const opened = await memory.open();
		const runtime = createRuntime({ storage: opened.storage });
		const name = roomName('refused');
		const first = await startRoom({
			name,
			seats: { [assistant.name]: 'none' },
			agents: [assistant],
			runtime,
			streamFn: scripted(() => quiet()),
		});
		await first.visit(andrei);
		await first.stop();

		const impostor = defineAgent({
			name: 'andrei',
			identity: "An agent wearing a person's name.",
			executor: pi({ instructions: 'confuse', model: 'scripted/impostor' }),
		});
		await expect(
			startRoom({
				name,
				seats: { [impostor.name]: 'broadcast', [assistant.name]: 'none' },
				agents: [impostor, assistant],
				runtime,
				streamFn: scripted(() => quiet()),
			}),
		).rejects.toThrow(/one name names one participant/);
		// nothing runs under the name, and the host never stopped the handle it holds:
		// a composition that stands takes the name and reads the record the first run left
		const again = await startRoom({
			name,
			seats: { [assistant.name]: 'none' },
			agents: [assistant],
			runtime,
			streamFn: scripted(() => quiet()),
		});
		expect((await messagesOf(again)).map((m) => m.from)).toEqual(['andrei', 'andrei']);
		await again.stop();
	});

	it('refuses a delivery directed at the assistant, which wakes for nothing said', async () => {
		const alone = defineAgent({
			name: 'alone',
			identity: 'The one agent.',
			executor: pi({ instructions: 'answer', model: 'scripted/alone' }),
		});
		const session = await startRoom({
			name: roomName('directed'),
			seats: { [alone.name]: 'broadcast', [assistant.name]: 'none' },
			agents: [alone, assistant],
			streamFn: scripted(() => quiet()),
		});
		const visit = await enter(session);
		await expect(visit.send({ to: assistant.name, text: 'Write it up for me.' })).rejects.toThrow(
			/wakes for nothing said/,
		);
		// and nothing landed: the record holds the arrival alone
		expect((await messagesOf(session)).map((m) => m.kind)).toEqual(['arrived']);
		await session.stop();
	});

	it('tells the seat side to stop, over the wire, when it cuts a lease', async () => {
		const hangs = deferred();
		const solo = defineAgent({
			name: 'solo',
			identity: 'Never stops.',
			executor: pi({ instructions: 'wait', model: 'scripted/solo' }),
		});
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
		const session = await startRoom({
			name: roomName('cut'),
			seats: { [solo.name]: 'broadcast', [assistant.name]: 'none' },
			agents: [solo, assistant],
			runtime,
			streamFn: scripted(async () => {
				hangs.resolve();
				return new Promise<never>(() => {});
			}),
		});
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
		await session.stop();
	});

	it('answers a commit from a lease that ended stale, before what the record moved past', async () => {
		const solo = defineAgent({
			name: 'solo',
			identity: 'Speaks once.',
			executor: pi({ instructions: 'speak', model: 'scripted/solo' }),
		});
		// the seats hear no wake, so the test holds the seat's side of the wire itself
		const runtime = createRuntime({
			transport: {
				connect: () => ({ wake: async () => {}, steer: async () => {}, cut: async () => {} }),
			},
		});
		const session = await startRoom({
			name: roomName('stale'),
			seats: { [solo.name]: 'broadcast', [assistant.name]: 'none' },
			agents: [solo, assistant],
			runtime,
			streamFn: scripted(() => quiet()),
		});
		const events = collect(session);
		const visit = await enter(session);
		await visit.send({ text: 'first' });
		const room = runningRoom(runtime, session.name);
		if (room === undefined) throw new Error('the room is not running');
		expect(await room.lease({ activation: 'message:4:solo:1', operation: 'renew' })).toEqual({
			stale: 'the lease ended',
		});
		const claimed = await room.lease({ activation: 'message:4:solo:1', operation: 'claim' });
		expect(claimed).toMatchObject({ ok: {} });
		expect(await room.lease({ activation: 'message:4:solo:1', operation: 'claim' })).toMatchObject({
			ok: {},
		});
		// A renewal writes an entry beside the record, and the record stands
		// where it stood. The seat reads `lastSeq` against what its view held to
		// decide whether to read again: a renewal that reported its own landing
		// as movement would read again, renew again, and never stop.
		const renewed = await room.lease({ activation: 'message:4:solo:1', operation: 'renew' });
		expect(renewed).toMatchObject({
			ok: { lastSeq: 'ok' in claimed ? claimed.ok.lastSeq : -1 },
		});
		// the record moves past what the activation read, and then its lease ends
		await visit.send({ text: 'second' });
		await room.lease({
			activation: 'message:4:solo:1',
			operation: 'release',
			reason: 'released',
			readThrough: 0,
		});
		const late = await room.commit({
			activation: 'message:4:solo:1',
			key: 'late',
			readThrough: 2,
			intent: { kind: 'said', text: 'too late' },
		});
		// stale, not missed: nothing this activation writes lands, whatever the record did,
		// so the room reports no conflict for a seat that has nothing to redraft
		expect(late).toEqual({ stale: 'the lease ended' });
		expect(events.some((event) => event.type === 'conflict')).toBe(false);
		await session.stop();
	});

	it('refuses omitted and invalid speech freshness through the room port', async () => {
		const runtime = createRuntime({
			transport: {
				connect: () => ({ wake: async () => {}, steer: async () => {}, cut: async () => {} }),
			},
		});
		const session = await startRoom({
			name: roomName('freshness'),
			seats: {
				...Object.fromEntries(
					[
						defineAgent({
							name: 'solo',
							identity: 'S.',
							executor: pi({ instructions: '.', model: 'scripted/solo' }),
						}),
					].map((agent) => [agent.name, 'broadcast' as const]),
				),
				[assistant.name]: 'none',
			},
			agents: [
				...[
					defineAgent({
						name: 'solo',
						identity: 'S.',
						executor: pi({ instructions: '.', model: 'scripted/solo' }),
					}),
				],
				assistant,
			],
			runtime,
			streamFn: scripted(() => quiet()),
		});
		const visit = await enter(session);
		await visit.send({ text: 'first' });
		const room = runningRoom(runtime, session.name);
		if (room === undefined) throw new Error('the room is not running');
		expect(await room.lease({ activation: 'message:4:solo:1', operation: 'claim' })).toMatchObject({
			ok: {},
		});
		const before = await messagesOf(session);
		for (const readThrough of [undefined, -1, 1.5, 99]) {
			const reply = await room.commit({
				activation: 'message:4:solo:1',
				key: `fresh-${readThrough}`,
				...(readThrough === undefined ? {} : { readThrough }),
				intent: { kind: 'said', text: 'x' },
			});
			expect(reply).toMatchObject({ refused: expect.any(String) });
		}
		expect(await messagesOf(session)).toEqual(before);
		const opened = await room.view('message:4:solo:1');
		if ('stale' in opened) throw new Error('Expected a live activation.');
		expect(
			await room.commit({
				activation: 'message:4:solo:1',
				key: 'fresh-valid',
				readThrough: opened.view.through,
				intent: { kind: 'said', text: 'valid' },
			}),
		).toMatchObject({ committed: { text: 'valid' } });
		await session.stop();
	});

	it('refuses a duplicate agent name', async () => {
		const twin = defineAgent({
			name: 'solo',
			identity: 'An agent wearing a name already taken.',
			executor: pi({ instructions: 'confuse', model: 'scripted/twin' }),
		});
		await expect(
			startRoom({
				name: roomName('dupe'),
				seats: { [twin.name]: 'broadcast', [twin.name]: 'broadcast', [assistant.name]: 'none' },
				agents: [twin, twin, assistant],
				streamFn: scripted(() => quiet()),
			}),
		).rejects.toThrow(/one name names one participant/);
	});
});

/**
 * The room keeps when it last sent each wake, so it sends one again only
 * after the resend window. `decide` says which of those the fold no longer
 * owes, and the pass drops them: the cache is bounded by what the room
 * still waits on, and never by how long the room has run.
 *
 * Nothing else reads a forgotten id — `decide` looks up only what the fold
 * says is due — so this is the one place the bound is visible.
 */
describe('what the room waits on', () => {
	const sentBy = (session: Room): Map<string, number> =>
		(session as unknown as { sentAt: Map<string, number> }).sentAt;

	it('drops a wake the fold stopped owing, and holds one it still owes', async () => {
		const held = deferred();
		const session = await startRoom({
			name: roomName('waits'),
			seats: {
				...Object.fromEntries(
					[
						defineAgent({
							name: 'solo',
							identity: 'S.',
							executor: pi({ instructions: 'x', model: 'm/solo' }),
						}),
					].map((agent) => [agent.name, 'broadcast' as const]),
				),
				[assistant.name]: 'none',
			},
			agents: [
				defineAgent({
					name: 'solo',
					identity: 'S.',
					executor: pi({ instructions: 'x', model: 'm/solo' }),
				}),
				assistant,
			],
			streamFn: scripted(
				byAgent({
					solo: async (_c, _n, call) => {
						if (call === 1) await held.promise;
						return quiet();
					},
				}),
			),
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
		await session.stop();
	});
});
