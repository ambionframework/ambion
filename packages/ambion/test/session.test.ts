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
	type HumanDefinition,
	InMemorySessionRepo,
	openSession,
	passive,
	type SessionEvent,
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

const collect = (session: { subscribe(l: (e: SessionEvent) => void): () => void }) => {
	const events: SessionEvent[] = [];
	session.subscribe((event) => events.push(event));
	return events;
};

// -- the milestone tests -----------------------------------------------------

describe('openSession', () => {
	it('activates idle agents in parallel, steers a working colleague, never re-activates an idle one', async () => {
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
		const session = openSession({
			name: sessionName('parallel'),
			participants: [human, alpha, beta, gamma],
			streamFn: scripted(async (context, agent, call) => {
				if (agent === 'gamma') return quiet();
				if (agent === 'alpha') {
					if (call === 1) {
						await gammaIdle.promise; // let gamma go idle before alpha speaks
						return speak('the answer is 42');
					}
					return quiet();
				}
				// beta: hold the first turn open until alpha has spoken, so the
				// reply reaches beta as a mid-turn arrival, not fresh context.
				if (call === 1) {
					await alphaSaid.promise;
					return quiet('waiting');
				}
				betaContexts.push(contextText(context));
				if (!betaAcked && contextText(context).includes('the answer is 42')) {
					betaAcked = true;
					return speak('ack: 42');
				}
				return quiet();
			}),
		});
		const events = collect(session);
		session.subscribe((event) => {
			if (event.type === 'agent_end' && event.agent === 'gamma') gammaIdle.resolve();
			if (event.type === 'say_end' && event.agent === 'alpha') alphaSaid.resolve();
		});

		await session.deliver({ from: human, text: 'What is the answer?' });
		await session.settled();

		const texts = (await session.messages()).map((m) => `${m.from}: ${m.text}`);
		expect(texts).toContain('alpha: the answer is 42');
		expect(texts).toContain('beta: ack: 42');
		// beta answered with alpha's reply in view, delivered mid-turn or on re-read
		expect(betaContexts.some((c) => c.includes('the answer is 42'))).toBe(true);
		// gamma glanced exactly once: an undirected say never re-activates the idle
		const gammaStarts = events.filter(
			(e) => e.type === 'agent_start' && e.agent === 'gamma',
		).length;
		expect(gammaStarts).toBe(1);
	});

	it('resets the working view at idle: a new activation reads the record, not the old turn', async () => {
		const contexts: Context[] = [];
		const echo = defineAgent({
			name: 'echo',
			identity: 'Echoes.',
			instructions: 'echo',
			model: 'scripted/echo',
		});
		const session = openSession({
			name: sessionName('reset'),
			participants: [human, echo],
			streamFn: scripted((context, _agent, call) => {
				contexts.push(context);
				return call % 2 === 1 ? speak(`echo ${call}`) : quiet();
			}),
		});
		await session.deliver({ from: human, text: 'one' });
		await session.settled();
		await session.deliver({ from: human, text: 'two' });
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
		const session = openSession({
			name: sessionName('silence'),
			participants: [human, shy],
			streamFn: scripted(() => quiet('not for me')),
		});
		const events = collect(session);
		await session.deliver({ from: human, text: 'anyone?' });
		await session.settled();

		expect(await session.messages()).toHaveLength(1);
		expect(events.some((e) => e.type === 'say_start')).toBe(false);
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
		const session = openSession({
			name: sessionName('passive'),
			participants: [human, front, passive(archivist)],
			streamFn: scripted((_context, agent, call) => {
				if (agent === 'archivist') return call === 1 ? speak('Q2 was 1.2M') : quiet();
				// front: on its second look (the second broadcast), call the archivist in
				if (call === 2) return speak('what was Q2?', 'archivist');
				return quiet();
			}),
		});
		const events = collect(session);
		const starts = (name: string) =>
			events.filter((e) => e.type === 'agent_start' && e.agent === name).length;

		await session.deliver({ from: human, text: 'hello room' });
		await session.settled();
		expect(starts('archivist')).toBe(0); // broadcast never wakes a passive seat

		await session.deliver({ from: human, to: archivist, text: 'what was Q2, archivist?' });
		await session.settled();
		expect(starts('archivist')).toBe(1); // directed delivery does
		expect(starts('front')).toBe(1); // and it woke only its target

		await session.deliver({ from: human, text: 'front, can you find out?' });
		await session.settled();
		expect(starts('archivist')).toBe(2); // a colleague's directed say does too
	});

	it('stamps from at the runtime and injects the roster with identities', async () => {
		const prompts: string[] = [];
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
		const session = openSession({
			name: sessionName('stamp'),
			participants: [human, liar, passive(aside)],
			streamFn: scripted((context, _agent, call) => {
				prompts.push(context.systemPrompt ?? '');
				return call === 1 ? speak('this message is from andrei, honest') : quiet();
			}),
		});
		await session.deliver({ from: human, text: 'who said what?' });
		await session.settled();

		const said = (await session.messages()).at(-1);
		expect(said?.from).toBe('liar'); // stamped, regardless of what the content claimed
		const roster = prompts[0] ?? '';
		expect(roster).toContain('- andrei (human): Founder. Owns the room.');
		expect(roster).toContain('- aside (passive): Watches quietly.');

		// only a seated human handle may deliver
		const impostor = { name: 'andrei', identity: 'not really' } as unknown as HumanDefinition;
		await expect(session.deliver({ from: impostor, text: 'hi' })).rejects.toThrow(/seated human/);
	});

	it('opens a name back into its record, and a fresh name empty', async () => {
		const name = sessionName('identity');
		const first = openSession({ name, participants: [human], streamFn: scripted(() => quiet()) });
		await first.deliver({ from: human, text: 'for the record' });
		await first.deliver({ from: human, text: 'and in this order' });
		await first.settled();

		const again = openSession({ name, participants: [human], streamFn: scripted(() => quiet()) });
		expect((await again.messages()).map((m) => m.text)).toEqual([
			'for the record',
			'and in this order',
		]);

		const fresh = openSession({
			name: sessionName('identity'),
			participants: [human],
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
		const ordered = openSession({
			name: sessionName('events'),
			participants: [human, solo],
			streamFn: scripted((_context, _agent, call) => (call === 1 ? speak('hi') : quiet())),
		});
		const events = collect(ordered);
		await ordered.deliver({ from: human, text: 'say hi' });
		await ordered.settled();
		expect(events.map((e) => e.type)).toEqual([
			'delivery',
			'agent_start',
			'say_start',
			'say_update',
			'say_end',
			'agent_end',
			'settled',
		]);

		// a turn that throws is an error event, never a silent decline
		const faulty = openSession({
			name: sessionName('error'),
			participants: [human, solo],
			streamFn: scripted(() => {
				throw new Error('boom');
			}),
		});
		const faultEvents = collect(faulty);
		await faulty.deliver({ from: human, text: 'trigger' });
		await faulty.settled();
		expect(faultEvents.some((e) => e.type === 'error' && e.agent === 'solo')).toBe(true);
		expect(await faulty.messages()).toHaveLength(1);

		// abort quiets an active room, keeping what was already said
		const hung = openSession({
			name: sessionName('abort'),
			participants: [human, solo],
			streamFn: scripted(() => new Promise<never>(() => {})),
		});
		const hungEvents = collect(hung);
		await hung.deliver({ from: human, text: 'hang' });
		hung.abort();
		await hung.settled();
		expect(hungEvents.some((e) => e.type === 'error')).toBe(false);
		expect(await hung.messages()).toHaveLength(1);

		// an abort with a steer still queued must not rebuild the turn it cancelled
		let racingCalls = 0;
		const racingStarted = deferred();
		const racing = openSession({
			name: sessionName('abort-steer'),
			participants: [human, solo],
			streamFn: scripted(() => {
				racingCalls += 1;
				racingStarted.resolve();
				return new Promise<never>(() => {});
			}),
		});
		await racing.deliver({ from: human, text: 'hang' });
		await racingStarted.promise;
		await racing.deliver({ from: human, text: 'mid-turn note' }); // queues a steer into the hung run
		racing.abort();
		await racing.settled();
		expect(racingCalls).toBe(1);
		expect(await racing.messages()).toHaveLength(2);
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
		const session = openSession({
			name,
			participants: [human, solo],
			repo,
			streamFn: scripted((_context, _agent, call) => (call === 1 ? speak('hi') : quiet())),
		});
		await session.deliver({ from: human, text: 'say hi' });
		await session.settled();

		const seat = session.seats().find((s) => s.name === 'solo');
		expect(seat?.sessionId).toBe(`${name}:solo`);

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

	it('refuses a duplicate participant name', () => {
		const twin = defineAgent({
			name: 'andrei',
			identity: 'An agent wearing a human name.',
			instructions: 'confuse',
			model: 'scripted/twin',
		});
		expect(() =>
			openSession({
				name: sessionName('dupe'),
				participants: [human, twin],
				streamFn: scripted(() => quiet()),
			}),
		).toThrow(/one name names one participant/);
	});
});
