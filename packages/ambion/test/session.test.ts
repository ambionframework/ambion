import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
} from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
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

// -- scripted model ----------------------------------------------------------

type Script = (
	context: Context,
	agent: string,
	call: number,
) => AssistantMessage | Promise<AssistantMessage>;

/** A deterministic streamFn: routes on the agent's name, counts calls per agent. */
function scripted(script: Script): StreamFn {
	const calls = new Map<string, number>();
	return (_model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const agent = /You are '([a-z0-9-]+)'/.exec(context.systemPrompt ?? '')?.[1] ?? 'unknown';
		const call = (calls.get(agent) ?? 0) + 1;
		calls.set(agent, call);
		let finished = false;
		const finish = (message: AssistantMessage) => {
			if (finished) return;
			finished = true;
			if (message.stopReason === 'error' || message.stopReason === 'aborted') {
				stream.push({ type: 'error', reason: message.stopReason, error: message });
			} else {
				stream.push({ type: 'start', partial: message });
				stream.push({
					type: 'done',
					reason: message.stopReason as 'stop' | 'toolUse',
					message,
				});
			}
		};
		const aborted = () =>
			finish(fauxAssistantMessage('', { stopReason: 'aborted', errorMessage: 'aborted' }));
		if (options?.signal?.aborted) {
			queueMicrotask(aborted);
			return stream;
		}
		options?.signal?.addEventListener('abort', aborted, { once: true });
		void (async () => {
			try {
				finish(await script(context, agent, call));
			} catch (error) {
				finish(fauxAssistantMessage('', { stopReason: 'error', errorMessage: String(error) }));
			}
		})();
		return stream;
	};
}

/**
 * Route a script by seat: one entry per agent that has lines, `quiet()` for the
 * rest. Keeping the seats apart is what keeps each one readable — a single
 * callback branching on `agent` buries the scenario in an if-chain.
 */
const byAgent = (seats: Record<string, Script>): Script => {
	const table = new Map(Object.entries(seats));
	return (context, agent, call) => (table.get(agent) ?? (() => quiet()))(context, agent, call);
};

const speak = (text: string, to?: string) =>
	fauxAssistantMessage([fauxToolCall('say', to ? { to, text } : { text })], {
		stopReason: 'toolUse',
	});

const quiet = (thought = 'nothing to add') => fauxAssistantMessage(thought, { stopReason: 'stop' });

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function contextText(context: Context): string {
	return context.messages
		.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
		.join('\n');
}

let unique = 0;
const sessionName = (prefix: string) => `${prefix}-${++unique}`;

const human = defineHuman({ name: 'andrei', identity: 'Founder. Owns the room.' });

/**
 * A visitor whose arrival has already been heard. Arriving is a message, so
 * it activates the room; draining it first keeps each test's script counting
 * the turns the test is actually about.
 */
async function enter(session: Session, who = human) {
	const visit = await visitSession(session, who);
	await session.settled();
	return visit;
}

/** The record's spoken half, which is what most of these tests are about. */
const spoken = (messages: Message[]) => messages.filter(isSpoken);

const collect = (session: { subscribe(l: (e: SessionEvent) => void): () => void }) => {
	const events: SessionEvent[] = [];
	session.subscribe((event) => events.push(event));
	return events;
};

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
			name: sessionName('parallel'),
			agents: [alpha, beta, gamma],
			streamFn: scripted(
				byAgent({
					alpha: async (_context, _agent, call) => {
						if (call !== 1) return quiet();
						await gammaIdle.promise; // let gamma go idle before alpha speaks
						return speak('the answer is 42');
					},
					// beta: hold the first turn open until alpha has spoken, so the
					// reply reaches beta as a mid-turn arrival, not fresh context.
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
			if (event.type === 'agent_end' && event.agent === 'gamma') gammaIdle.resolve();
			if (event.type === 'message' && event.message.from === 'alpha') alphaSaid.resolve();
		});

		const visit = await enter(session);
		await visit.deliver({ text: 'What is the answer?' });
		await session.settled();

		const texts = spoken(await session.messages()).map((m) => `${m.from}: ${m.text}`);
		expect(texts).toContain('alpha: the answer is 42');
		expect(texts).toContain('beta: ack: 42');
		expect(texts).toHaveLength(3); // woken seats declined: glances, not messages
		// beta answered with alpha's reply in view, delivered mid-turn or on re-read
		expect(betaContexts.some((c) => c.includes('the answer is 42'))).toBe(true);
		// a say wakes the idle room: gamma, idle when alpha spoke, glanced again —
		// and the round still settled, because woken seats with nothing to add decline
		const gammaStarts = events.filter(
			(e) => e.type === 'agent_start' && e.agent === 'gamma',
		).length;
		expect(gammaStarts).toBeGreaterThanOrEqual(2);
	});

	it('resets the working view at idle: a new activation reads the record, not the old turn', async () => {
		const contexts: Context[] = [];
		const echo = defineAgent({
			name: 'echo',
			identity: 'Echoes.',
			instructions: 'echo',
			model: 'scripted/echo',
		});
		const session = startSession({
			name: sessionName('reset'),
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
			name: sessionName('silence'),
			agents: [shy],
			streamFn: scripted(() => quiet('not for me')),
		});
		const events = collect(session);
		await (await enter(session)).deliver({ text: 'anyone?' });
		await session.settled();

		expect(spoken(await session.messages())).toHaveLength(1);
		expect(events.some((e) => e.type === 'message' && e.message.from === 'shy')).toBe(false);
		const end = events.find((e) => e.type === 'agent_end');
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
			name: sessionName('passive'),
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
			events.filter((e) => e.type === 'agent_start' && e.agent === name).length;

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
			name: sessionName('stamp'),
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
		const name = sessionName('identity');
		const scribe = defineAgent({
			name: 'scribe',
			identity: 'Writes nothing down.',
			instructions: 'stay quiet',
			model: 'scripted/scribe',
		});
		const first = startSession({ name, agents: [scribe], streamFn: scripted(() => quiet()) });
		const visit = await enter(first);
		await visit.deliver({ text: 'for the record' });
		await visit.deliver({ text: 'and in this order' });
		await first.settled();

		// one run per name: a second live room over one record would diverge
		expect(() => startSession({ name, agents: [scribe] })).toThrow(/already running/);

		await stopSession(first);
		const again = startSession({ name, agents: [scribe], streamFn: scripted(() => quiet()) });
		expect(spoken(await again.messages()).map((m) => m.text)).toEqual([
			'for the record',
			'and in this order',
		]);
		// seqs continue rather than restart
		const seqs = (await again.messages()).map((m) => m.seq);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
		expect(new Set(seqs).size).toBe(seqs.length);
		await stopSession(again);

		// you can read a room that is not running
		const view = readSession(name);
		expect(spoken(await view.messages()).map((m) => m.text)).toContain('for the record');
		expect(view.seats().every((seat) => seat.kind === 'human')).toBe(true);

		const fresh = startSession({
			name: sessionName('identity'),
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
			name: sessionName('events'),
			agents: [solo],
			streamFn: scripted((_context, _agent, call) => (call === 1 ? speak('hi') : quiet())),
		});
		const orderedVisit = await enter(ordered);
		const events = collect(ordered);
		await orderedVisit.deliver({ text: 'say hi' });
		await ordered.settled();
		// one event per message on the record, whoever wrote it
		expect(events.map((e) => e.type)).toEqual([
			'message',
			'agent_start',
			'message',
			'agent_end',
			'settled',
		]);
		expect(events.flatMap((e) => (e.type === 'message' ? [e.message.from] : []))).toEqual([
			'andrei',
			'solo',
		]);

		// a turn that throws is an error event, never a silent decline
		const faulty = startSession({
			name: sessionName('error'),
			agents: [solo],
			streamFn: scripted(() => {
				throw new Error('boom');
			}),
		});
		const faultVisit = await visitSession(faulty, human);
		const faultEvents = collect(faulty);
		await faultVisit.deliver({ text: 'trigger' });
		await faulty.settled();
		expect(faultEvents.some((e) => e.type === 'error' && e.agent === 'solo')).toBe(true);
		expect(spoken(await faulty.messages())).toHaveLength(1);

		// abort quiets an active room, keeping what was already said
		const hung = startSession({
			name: sessionName('abort'),
			agents: [solo],
			streamFn: scripted(() => new Promise<never>(() => {})),
		});
		const hungVisit = await visitSession(hung, human);
		const hungEvents = collect(hung);
		await hungVisit.deliver({ text: 'hang' });
		hung.abort();
		await hung.settled();
		expect(hungEvents.some((e) => e.type === 'error')).toBe(false);
		expect(spoken(await hung.messages())).toHaveLength(1);

		// an abort with a steer still queued must not rebuild the turn it cancelled
		let racingCalls = 0;
		const racingStarted = deferred();
		const racing = startSession({
			name: sessionName('abort-steer'),
			agents: [solo],
			streamFn: scripted(() => {
				racingCalls += 1;
				racingStarted.resolve();
				return new Promise<never>(() => {});
			}),
		});
		const racingVisit = await visitSession(racing, human);
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
			name: sessionName('race'),
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
		const conflicts = events.filter((e) => e.type === 'say_conflict');
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0]).toMatchObject({ agent: 'second' });
		const missed = conflicts[0]?.type === 'say_conflict' ? conflicts[0].missed[0] : undefined;
		expect(missed && isSpoken(missed) && missed.text).toBe('the point');
		// the failure reached the model as a tool result carrying the missed line
		expect(secondContexts[1]).toContain('Not delivered');
		expect(secondContexts[1]).toContain('the point');

		// standing down after a conflict leaves no mark, like any decline
		const yieldSaid = deferred();
		const yielding = startSession({
			name: sessionName('race-yield'),
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
		const end = yieldEvents.find((e) => e.type === 'agent_end' && e.agent === 'second');
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
		const name = sessionName('downstream');
		const session = startSession({
			name,
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

	it('refuses a duplicate agent name', () => {
		const twin = defineAgent({
			name: 'solo',
			identity: 'An agent wearing a name already taken.',
			instructions: 'confuse',
			model: 'scripted/twin',
		});
		expect(() =>
			startSession({
				name: sessionName('dupe'),
				agents: [twin, twin],
				streamFn: scripted(() => quiet()),
			}),
		).toThrow(/one name names one participant/);
	});
});
