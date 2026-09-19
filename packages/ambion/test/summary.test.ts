import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { afterEach, describe, expect, it } from 'vitest';
import { renderRecord } from '../src/execution/render.ts';
import type { AgentDefinition } from '../src/index.ts';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	defineTool,
	isSpoken,
	type Message,
	type Room,
	type RoomNotification,
	type Runtime,
	type SummaryMessage,
	startRoom,
} from '../src/index.ts';
import { seatSessionId } from '../src/transport.ts';
import { fakeClock } from './support/clock.ts';
import {
	assistantEnded,
	closedExchange,
	collect,
	currentExchange,
	deferred,
	messageBefore,
	messagesOf,
	roomName as name,
	participantsOf,
	tick,
	waitForRoom,
} from './support/room.ts';
import {
	byAgent,
	contextText,
	insists,
	isClosing,
	quiet,
	type Script,
	scripted,
	seat,
	speak,
	summarise,
	toolNames,
} from './support/scripted.ts';
import { gatedJournals, memory } from './support/storage.ts';

/** The ordinary assistant: it writes once, then ends its activation. */
const writes =
	(text: string): Script =>
	(_context, _name, call) =>
		call === 1 ? summarise(text) : quiet();

/** An activation that fails outright: no draft, nothing written, and an error on the stream. */
const broken: Script = () =>
	fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'the model failed' });

// -- the room ----------------------------------------------------------------

const roomName = () => name('assistant');

const product = defineAgent({
	name: 'product',
	identity: 'The one product in this room.',
	instructions: 'answer what is asked',
	model: 'scripted/product',
});

/** The seat that meets people at the door, and works on what nobody asked for. */
const greeter = defineAgent({
	name: 'greeter',
	identity: 'Meets people at the door.',
	instructions: 'check what is blocked on whoever just arrived',
	model: 'scripted/greeter',
});

const colleague = defineAgent({
	name: 'colleague',
	identity: 'The second product.',
	instructions: 'answer what is asked',
	model: 'scripted/colleague',
});

/** The room's assistant: it writes for everybody who visits, each in their own way. */
const assistant = defineAgent({
	name: 'assistant',
	identity: 'Writes the one message a person reads.',
	instructions: 'Answer what was asked, once.',
	model: 'scripted/assistant',
});

const priya = defineHuman({
	name: 'priya',
	identity: 'Project manager. Owns the programme.',
	preferences: 'Lead with the decision she has to make. Leave out who said what.',
});

const sam = defineHuman({
	name: 'sam',
	identity: 'Site foreman.',
	preferences: 'Lead with what he has to do tomorrow.',
});

/** A person who has said nothing about how they read. */
const dan = defineHuman({ name: 'dan', identity: 'Quantity surveyor.' });

const started: Room[] = [];

/** One clock the tests move by hand, and one runtime over it. */
const clock = fakeClock();
const runtime = createRuntime({ clock });

async function open(options: {
	script: Script;
	agents?: Parameters<typeof startRoom>[0]['agents'];
	seats?: Parameters<typeof startRoom>[0]['seats'];
	assistant?: AgentDefinition;
	runtime?: Runtime;
}): Promise<Room> {
	const session = await startRoom({
		name: roomName(),
		goal: 'Decide the pour date and keep the plan honest.',
		summary: (options.assistant ?? assistant).name,
		agents: [...(options.agents ?? [product]), options.assistant ?? assistant],
		seats: {
			...(options.seats ??
				Object.fromEntries(
					(options.agents ?? [product]).map((agent) => [agent.name, 'broadcast' as const]),
				)),
			[(options.assistant ?? assistant).name]:
				options.seats?.[(options.assistant ?? assistant).name] ?? 'none',
		},
		streamFn: scripted(options.script),
		runtime: options.runtime ?? runtime,
	});
	started.push(session);
	return session;
}

afterEach(async () => {
	for (const session of started.splice(0)) await session.stop();
});

/** The assistant writes after the room is quiet, so a test waits for what it wrote. */
function nextSummary(session: Room): Promise<SummaryMessage> {
	return new Promise((resolve) => {
		const off = session.subscribe((event) => {
			if (event.type !== 'message' || event.message.kind !== 'summary') return;
			off();
			resolve(event.message);
		});
	});
}

/** Quiet: no seat is taking an activation, and the assistant owes nobody a message. */
function quiescent(session: Room): Promise<void> {
	return waitForRoom(session);
}

const summaries = (record: Message[]) => record.filter((m) => m.kind === 'summary');
const said = (record: Message[]) => record.filter(isSpoken).map((m) => m.text);

// -- what the products say ---------------------------------------------------

/** Two answers to one question, then silence. */
const twoAnswers: Script = (_context, _name, call) => {
	if (call === 1) return speak('Thursday is out: the inspector needs 48h notice.');
	if (call === 2) return speak('Saturday works if the rebar lands Wednesday.');
	return quiet();
};

/** One answer, which is already the message a person reads. */
const oneAnswer: Script = (_context, _name, call) => {
	if (call === 1) return speak('Thursday is out: the inspector needs 48h notice.');
	return quiet();
};

/** Two answers to the first question, then one to each that follows. */
const answersEach: Script = (_context, _name, call) => {
	if (call === 3 || call === 5) return quiet();
	return speak(`answer ${call}`);
};

/** Two answers to every question it is asked. */
const twoAnswersEach: Script = (_context, _name, call) =>
	call % 3 === 0 ? quiet() : speak(`answer ${call}`);

/** An assistant that writes once per activation, however many activations it takes. */
const writesEach =
	(text: string): Script =>
	(_context, _name, call) =>
		summarise(`${text} ${call}`);

/** A product that is still reading when the room changes under it. */
function heldUntil(held: Promise<void>): Script {
	return async (_context, _name, call) => {
		if (call === 1) {
			await held;
			return quiet('still reading');
		}
		if (call === 2) return speak('answer 1');
		if (call === 3) return speak('answer 2');
		return quiet();
	};
}

describe('closing summaries', () => {
	it('writes one message for an exchange the room answered more than once', async () => {
		const contexts: string[] = [];
		const prompts: string[] = [];
		const tools: string[] = [];
		const session = await open({
			script: byAgent({
				product: twoAnswers,
				assistant: (context, _name, call) => {
					contexts.push(contextText(context));
					prompts.push(context.systemPrompt ?? '');
					tools.push((context.tools ?? []).map((tool) => tool.name).join(','));
					return call === 1
						? summarise('Thursday is out. Saturday holds if the rebar lands Wednesday.')
						: quiet();
				},
			}),
		});
		const written = nextSummary(session);
		const ended = assistantEnded(session);

		const visit = await session.visit(priya);
		await visit.send({ text: 'Can I tell the client Thursday for the pour?' });
		const summary = await written;
		await ended;

		expect(summary.from).toBe('assistant');
		expect(summary.to).toBe('priya');
		expect(summary.text).toContain('Saturday');
		const record = await messagesOf(session);
		// it stands through the last message before it, and leaves none behind
		expect(summary.covers.through).toBe(messageBefore(record, summary.seq));
		expect(summary.covers.from).toBe(record.find((m) => isSpoken(m))?.seq);
		expect(record.map((m) => m.kind)).toEqual(['arrived', 'said', 'said', 'said', 'summary']);

		// what an assistant is given: the range it covers, and one tool that reaches the record
		expect(tools).toEqual(['say']);
		expect(contexts[0]).toContain('Can I tell the client Thursday');
		expect(contexts[0]).toContain('the inspector needs 48h notice');
		// what its person owns reaches it in the roster, so an assistant holds no copy
		expect(contexts[0]).toContain('Project manager. Owns the programme.');
		// and it is addressed as the assistant it is, not as a seat that speaks
		expect(prompts[0]).toContain("'assistant', an agent seated in the room");
		expect(prompts[0]).toContain('using the say tool');
		expect(prompts[0]).not.toContain('Speaking is the say tool');
		// it is told whom it writes for, and how that person reads
		expect(prompts[0]).toContain('You are writing for priya.');
		expect(prompts[0]).toContain('Leave out who said what.');
		// The last line names the range this activation closes, counted the way
		// the reader counts. The record above is five messages, and the range
		// runs from the second to the fourth, whatever places the journal gave
		// them: one counter gives out every place, so a place is not a number
		// a reader can find.
		expect(contexts[0]).toContain(
			"priya's exchange is over: messages 2 to 4. Write the one message with say",
		);
	});

	it('lets the writer decline a summary even when only one answer exists', async () => {
		const session = await open({
			script: byAgent({ product: oneAnswer, assistant: () => quiet() }),
		});

		const visit = await session.visit(priya);
		await visit.send({ text: 'Can I tell the client Thursday?' });
		await quiescent(session);

		expect(summaries(await messagesOf(session))).toHaveLength(0);
	});

	it('wakes nobody, and every seat reads it at the next activation', async () => {
		const contexts: string[] = [];
		const prompts: string[] = [];
		const session = await open({
			script: byAgent({
				product: (context, name, call) => {
					contexts.push(contextText(context));
					prompts.push(context.systemPrompt ?? '');
					if (call > 3) return quiet();
					return twoAnswers(context, name, call);
				},
				assistant: writes('Thursday is out; Saturday holds.'),
			}),
		});
		const events = collect(session);
		const written = nextSummary(session);

		const visit = await session.visit(priya);
		await visit.send({ text: 'Can I tell the client Thursday?' });
		const summary = await written;
		await quiescent(session);

		// nothing an assistant writes activates a seat
		const landed = events.findIndex((e) => e.type === 'message' && e.message === summary);
		expect(events.slice(landed).filter((e) => e.type === 'activation_start')).toHaveLength(0);

		await visit.send({ text: 'And the pump?' });
		await quiescent(session);

		// the range left the seat's context, and the summary stands for it
		const read = contexts.at(-1) ?? '';
		expect(read).toContain('── 3 messages, summarised for priya below ──');
		expect(read).toContain('[assistant → priya] Thursday is out; Saturday holds.');
		expect(read).not.toContain('the inspector needs 48h notice');
		// the roster names the seat that writes for people, and nobody brings one
		expect(read).toContain('- assistant (idle, wakes for nothing said):');
		expect(read).not.toContain('brings');
		// a record that holds a summary tells its seats how to read a fold; one that does not, does not
		expect(prompts[0]).not.toContain('summarised for <name> below');
		expect(prompts.at(-1)).toContain('summarised for <name> below');
		// the record keeps every message, and nothing was rewritten
		expect(said(await messagesOf(session))).toContain(
			'Thursday is out: the inspector needs 48h notice.',
		);
	});

	it('owns the question that lands while a seat works on what nobody asked for', async () => {
		const greeting = deferred();
		const session = await open({
			agents: [product, greeter],
			seats: { [product.name]: 'broadcast', [greeter.name]: 'presence' },
			script: byAgent({
				product: twoAnswers,
				greeter: async (_context, _name, call) => {
					if (call === 1) await greeting.promise;
					return quiet();
				},
				assistant: writes('Thursday is out; Saturday holds.'),
			}),
		});
		const written = nextSummary(session);

		// arriving wakes the seat that watches the door, and opens no exchange
		const visit = await session.visit(priya);
		await visit.send({ text: 'Can I tell the client Thursday?' });
		greeting.resolve();
		const summary = await written;

		expect(summary.to).toBe('priya');
		const record = await messagesOf(session);
		expect(summary.covers.from).toBe(record.find((m) => isSpoken(m))?.seq);
	});

	it('keeps a draft on its closed exchange while a later question arrives', async () => {
		const held = deferred();
		const contexts: string[] = [];
		const session = await open({
			script: byAgent({
				product: answersEach,
				assistant: async (context, _name, call) => {
					contexts.push(contextText(context));
					if (call === 1) await held.promise;
					return call === 1 ? summarise('the first answer') : quiet();
				},
			}),
		});
		const events = collect(session);

		const visit = await session.visit(priya);
		await visit.send({ text: 'Can I tell the client Thursday?' });
		await waitForRoom(session, 'settled');
		// the assistant has read its range and is drafting against it
		await tick();

		const written = nextSummary(session);
		await visit.send({ text: 'And the pump?' });
		await waitForRoom(session, 'settled');
		held.resolve();
		const summary = await written;
		await quiescent(session);

		const record = await messagesOf(session);
		expect(summaries(record)).toHaveLength(1);
		expect(events.filter((e) => e.type === 'conflict')).toEqual([]);
		expect(summary.text).toBe('the first answer');
		expect(summary.covers.from).toBe(record.find((m) => isSpoken(m))?.seq);
		const later = record.find((message) => isSpoken(message) && message.text === 'And the pump?');
		expect(later).toBeDefined();
		if (later === undefined) throw new Error('Expected the later question.');
		expect(summary.covers.through).toBeLessThan(later.seq);
		const closed = events.find(
			(event) => event.type === 'exchange_closed' && event.exchange.from === summary.covers.from,
		);
		expect(closed).toBeDefined();
		if (closed?.type !== 'exchange_closed') throw new Error('Expected the recorded close.');
		expect(summary.covers).toEqual({
			from: closed.exchange.from,
			through: closed.exchange.through,
		});
		expect(contexts[0]).not.toContain('And the pump?');
	});

	it('keeps later messages visible when a result publishes out of order', async () => {
		const first = deferred();
		const drafts: string[] = [];
		const session = await open({
			script: byAgent({
				product: answersEach,
				assistant: async (context, _name, call) => {
					drafts.push(contextText(context));
					if (call === 1) await first.promise;
					return summarise(`draft ${call}`);
				},
			}),
		});
		const events = collect(session);

		const visit = await session.visit(priya);
		await visit.send({ text: 'Can I tell the client Thursday?' });
		await waitForRoom(session, 'settled');
		await tick();

		// two arrivals move the record under the assistant, and wake nobody
		const his = await session.visit(sam);
		await his.leave();
		const written = nextSummary(session);
		first.resolve();
		const summary = await written;
		await quiescent(session);
		expect(events.filter((e) => e.type === 'conflict')).toEqual([]);
		expect(drafts.length).toBeGreaterThan(0);
		const record = await messagesOf(session);
		const between = record.find((message) => message.kind === 'left' && message.from === 'sam');
		expect(between).toBeDefined();
		if (between === undefined)
			throw new Error('Expected Sam to leave between the close and summary.');
		expect(summary.covers.through).toBeLessThan(between.seq);
		expect(renderRecord(record, [], clock.now())).toContain('sam left');
	});

	it('stands down without writing, and is not owed a summary for it', async () => {
		const calls: string[] = [];
		const session = await open({
			agents: [product, greeter],
			seats: { [product.name]: 'broadcast', [greeter.name]: 'presence' },
			script: byAgent({
				product: twoAnswers,
				assistant: (_context, name) => {
					calls.push(name);
					// one answer in two voices reads as one answer: nothing to consolidate
					return quiet();
				},
			}),
		});
		const events = collect(session);

		const visit = await session.visit(priya);
		await visit.send({ text: 'Can I tell the client Thursday?' });
		await quiescent(session);

		// somebody arriving wakes the seat that watches the door, and quietens again
		await session.visit(sam);
		await quiescent(session);

		expect(calls).toHaveLength(1);
		expect(summaries(await messagesOf(session))).toHaveLength(0);
		expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
		expect(
			events.filter((e) => e.type === 'activation_end' && e.agent === 'assistant'),
		).toMatchObject([{ spoke: false }]);
	});

	it('drafts again after the backoff when its activation fails outright', async () => {
		const session = await open({
			agents: [product, greeter],
			seats: { [product.name]: 'broadcast', [greeter.name]: 'presence' },
			script: byAgent({
				product: twoAnswers,
				assistant: (context, name, call) => {
					if (call === 1) return broken(context, name, call);
					return call === 2 ? summarise('written the second time') : quiet();
				},
			}),
		});
		const events = collect(session);
		const drafted = assistantEnded(session);

		const visit = await session.visit(priya);
		await visit.send({ text: 'Can I tell the client Thursday?' });
		await drafted;
		expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
		expect(summaries(await messagesOf(session))).toHaveLength(0);

		// a failed activation leaves the summary owed; an arrival is not the backoff passing
		const written = nextSummary(session);
		await session.visit(sam);
		await waitForRoom(session, 'settled');
		expect(summaries(await messagesOf(session))).toHaveLength(0);
		// the room's own alarm writes it, once the backoff has passed
		await clock.advance(30_000);
		const summary = await written;

		expect(summary.text).toBe('written the second time');
		expect(summary.covers.from).toBe((await messagesOf(session)).find((m) => isSpoken(m))?.seq);
	});

	it('writes for the person whose question opened the exchange, and for nobody else', async () => {
		const working = deferred();
		const session = await open({
			agents: [product, colleague],
			script: byAgent({
				product: heldUntil(working.promise),
				assistant: writes("Priya's message."),
			}),
		});
		const written = nextSummary(session);

		const hers = await session.visit(priya);
		const his = await session.visit(sam);
		await hers.send({ text: 'Can I tell the client Thursday?' });
		// a message into a working room steers the seats; it owns nothing
		await his.send({ text: 'Rain all Thursday. I am not pouring into that.' });
		working.resolve();
		const summary = await written;
		await quiescent(session);

		expect(summary.to).toBe('priya');
		expect(summaries(await messagesOf(session))).toHaveLength(1);
	});

	it('writes for a person who left before the room settled, the way they read', async () => {
		const working = deferred();
		const prompts: string[] = [];
		const session = await open({
			script: byAgent({
				product: heldUntil(working.promise),
				assistant: (context, name, call) => {
					prompts.push(context.systemPrompt ?? '');
					return writes('The answer, waiting for her.')(context, name, call);
				},
			}),
		});
		const written = nextSummary(session);

		const visit = await session.visit(priya);
		await visit.send({ text: 'Can I tell the client Thursday?' });
		await visit.leave();
		working.resolve();
		const summary = await written;

		expect(summary.to).toBe('priya');
		expect(summary.covers.through).toBe(messageBefore(await messagesOf(session), summary.seq));
		// how she reads outlives her visit, with the exchange she opened
		expect(prompts[0]).toContain('Leave out who said what.');
	});

	it('reads each person their own way, and reads nobody else’s way to them', async () => {
		const prompts: string[] = [];
		const session = await open({
			script: byAgent({
				product: twoAnswersEach,
				assistant: (context, name, call) => {
					// one entry per activation: the calls inside one share a prompt
					const prompt = context.systemPrompt ?? '';
					if (prompts.at(-1) !== prompt) prompts.push(prompt);
					return writesEach('the answer')(context, name, call);
				},
			}),
		});

		const hers = await session.visit(priya);
		const his = await session.visit(sam);
		const theirs = await session.visit(dan);
		await hers.send({ text: 'Can I tell the client Thursday?' });
		await quiescent(session);
		await his.send({ text: 'What do my crews do at seven?' });
		await quiescent(session);
		await theirs.send({ text: 'What does the move cost?' });
		await quiescent(session);

		const written = summaries(await messagesOf(session));
		expect(written.map((m) => m.to)).toEqual(['priya', 'sam', 'dan']);
		expect(written.map((m) => m.from)).toEqual(['assistant', 'assistant', 'assistant']);
		expect(prompts).toHaveLength(3);
		// one seat, three readers: each activation carries one person's preferences
		expect(prompts[0]).toContain('How priya reads:');
		expect(prompts[0]).toContain('Leave out who said what.');
		expect(prompts[0]).not.toContain('tomorrow');
		expect(prompts[1]).toContain('How sam reads:');
		expect(prompts[1]).toContain('Lead with what he has to do tomorrow.');
		expect(prompts[1]).not.toContain('Leave out who said what.');
		// a person who said nothing about how they read is written for in the house style
		expect(prompts[2]).toContain('You are writing for dan.');
		expect(prompts[2]).not.toContain('reads:');
		// and no product reads how anybody reads
		expect(prompts[2]).not.toContain('tomorrow');
	});

	it('writes for the second person owed once it has written for the first', async () => {
		const held = deferred();
		const drafts = new Map<string, number>();
		const session = await open({
			script: byAgent({
				product: twoAnswersEach,
				assistant: async (context) => {
					const person = /(\w+)'s exchange is over/.exec(contextText(context))?.[1] ?? '';
					const draft = (drafts.get(person) ?? 0) + 1;
					drafts.set(person, draft);
					// Priya's first draft is held while Sam's exchange runs, so the room
					// refuses it and her second covers what landed. Sam's lands first time.
					if (person === 'priya' && draft === 1) await held.promise;
					const drafting = person === 'priya' ? draft <= 2 : draft === 1;
					return drafting ? summarise(`the message ${person} reads`) : quiet();
				},
			}),
		});
		const seen = collect(session);

		const hers = await session.visit(priya);
		const his = await session.visit(sam);
		await hers.send({ text: 'Can I tell the client Thursday?' });
		await waitForRoom(session, 'settled');
		await tick();
		// the assistant is drafting for priya; sam's exchange opens, runs and closes under it
		await his.send({ text: 'What do my crews do at seven?' });
		await waitForRoom(session, 'settled');
		held.resolve();
		await quiescent(session);

		const written = summaries(await messagesOf(session));
		expect(written.map((m) => m.to)).toEqual(['priya', 'sam']);
		// one seat, so the two activations ran one after the other
		const starts = seen.filter((e) => e.type === 'activation_start' && e.agent === 'assistant');
		const ends = seen.filter((e) => e.type === 'activation_end' && e.agent === 'assistant');
		expect(starts).toHaveLength(2);
		expect(seen.indexOf(starts[1] as RoomNotification)).toBeGreaterThan(
			seen.indexOf(ends[0] as RoomNotification),
		);
		// and sam's range starts at his own question
		const questions = (await messagesOf(session)).filter((m) => isSpoken(m) && m.from === 'sam');
		expect(written[1]?.covers.from).toBe(questions[0]?.seq);
	});

	it("keeps the assistant's turns in a downstream session of its own, like any seat", async () => {
		const opened = await memory.open();
		const transcriptRuntime = createRuntime({ storage: opened.storage });
		const session = await open({
			runtime: transcriptRuntime,
			script: byAgent({ product: twoAnswers, assistant: writes('The one message.') }),
		});
		const written = nextSummary(session);
		const ended = assistantEnded(session);

		const visit = await session.visit(priya);
		await visit.send({ text: 'Can I tell the client Thursday?' });
		await written;
		await ended;

		// The room lists it as the seat it is: an agent seated at none.
		const seat = (await participantsOf(session)).find((s) => s.name === 'assistant');
		expect(seat).toMatchObject({ kind: 'agent', attention: 'none' });
		const seatSession = (await participantsOf(session)).find((value) => value.name === 'assistant');
		if (seatSession?.kind !== 'agent') throw new Error('The assistant seat is absent.');
		const entries = await (
			await transcriptRuntime.transcripts.open(seatSessionId(session.name, seatSession.name))
		).findEntries();
		expect(entries.some((e) => e.type === 'custom' && e.customType === 'ambion/activation')).toBe(
			true,
		);
	});

	it('refuses an assistant whose name an agent already holds, and a visitor who takes its name', async () => {
		const clash = defineAgent({
			name: 'product',
			identity: 'Writes the one message a person reads.',
			instructions: 'summarise',
			model: 'scripted/assistant',
		});
		await expect(open({ script: byAgent({}), assistant: clash })).rejects.toThrow(
			/one name names one participant/,
		);

		const session = await open({ script: byAgent({}) });
		const twin = defineHuman({ name: 'assistant', identity: 'Not the assistant.' });
		await expect(session.visit(twin)).rejects.toThrow(/is an agent in this room/);
	});

	it('is seated when the room starts, and an agent-only room never activates it', async () => {
		const session = await open({ script: byAgent({ product: () => speak('working alone') }) });
		const events = collect(session);
		await waitForRoom(session);
		await quiescent(session);

		const seat = (await participantsOf(session)).find((s) => s.name === 'assistant');
		expect(seat).toMatchObject({
			kind: 'agent',
			attention: 'none',
			status: 'idle',
		});
		expect(
			events.filter((e) => e.type === 'activation_start' && e.agent === 'assistant'),
		).toHaveLength(0);
	});

	it('covers one exchange, and never reaches back over the one before it', async () => {
		const session = await open({
			script: byAgent({ product: twoAnswersEach, assistant: writesEach('the answer') }),
		});

		const visit = await session.visit(priya);
		await visit.send({ text: 'Can I tell the client Thursday?' });
		await quiescent(session);
		await visit.send({ text: 'And what does Saturday need?' });
		await quiescent(session);

		const record = await messagesOf(session);
		const written = summaries(record);
		expect(written).toHaveLength(2);
		const questions = record.filter((m) => isSpoken(m) && m.from === 'priya');
		// the second stands for her second question, not for everything since her first
		expect(written[1]?.covers.from).toBe(questions[1]?.seq);
		expect(written[1]?.covers.from).toBeGreaterThan(written[0]?.seq ?? 0);
		expect(written[0]?.covers.from).toBe(questions[0]?.seq);
	});

	it('resolves close before the optional summary response', async () => {
		const session = await open({
			script: byAgent({ product: twoAnswers, assistant: writes('Thursday is out.') }),
		});
		const events = collect(session);

		const visit = await session.visit(priya);
		const exchange = await visit.send({ text: 'Can I tell the client Thursday?' });
		const conversation = await exchange.waitForClose();
		const close = closedExchange(session, exchange.from);
		const response = await exchange.waitForSummary();
		expect(response).toMatchObject({ kind: 'summary', to: priya.name });
		expect(close).toMatchObject({ owner: priya.name, from: exchange.from });
		expect(conversation.every((message) => message.kind !== 'summary')).toBe(true);
		expect(summaries(await messagesOf(session))).toHaveLength(1);
		const wrote = events.findIndex((e) => e.type === 'message' && e.message.kind === 'summary');
		const closed = events.findIndex((e) => e.type === 'exchange_closed');
		expect(wrote).toBeGreaterThan(closed);
	});

	it('refuses an empty say, so an empty message never stands inside a range', async () => {
		const contexts: string[] = [];
		const session = await open({
			script: byAgent({
				product: (context, _name, call) => {
					contexts.push(contextText(context));
					if (call === 1) return speak('   ');
					if (call === 2) return speak('Thursday is out.');
					return quiet();
				},
			}),
		});

		const visit = await session.visit(priya);
		await visit.send({ text: 'Can I tell the client Thursday?' });
		await quiescent(session);

		expect(said(await messagesOf(session))).toEqual([
			'Can I tell the client Thursday?',
			'Thursday is out.',
		]);
		expect(contexts.at(-1)).toContain('The message is empty');
	});

	it('keeps a failed summary pending until retry exhaustion', async () => {
		const session = await open({
			script: byAgent({ product: twoAnswers, assistant: broken }),
		});
		const events = collect(session);
		const drafted = assistantEnded(session);

		const visit = await session.visit(priya);
		const exchange = await visit.send({ text: 'Can I tell the client Thursday?' });
		await drafted;

		// the activation failed, so the summary is owed and the range is still whole
		expect(summaries(await messagesOf(session))).toHaveLength(0);

		// Every attempt fails, so the room reaches the cap and gives up. The
		// exchange remains durable, but its response rejects as failed.
		await clock.advance(30_000);
		await clock.advance(60_000);
		await waitForRoom(session);
		expect(events.filter((e) => e.type === 'abandoned')).toHaveLength(1);
		expect(summaries(await messagesOf(session))).toHaveLength(0);
		await expect(exchange.waitForSummary()).rejects.toThrow(/interrupted/i);
	});

	it('writes off a draft the host revoked, and publishes no response', async () => {
		const drafting = deferred();
		const hangs: Script = () => {
			drafting.resolve();
			return new Promise<never>(() => {});
		};
		const session = await open({ script: byAgent({ product: twoAnswers, assistant: hangs }) });
		const events = collect(session);
		const starts = () =>
			events.filter((e) => e.type === 'activation_start' && e.agent === 'assistant').length;

		const visit = await session.visit(priya);
		const exchange = await visit.send({ text: 'Can I tell the client Thursday?' });
		await drafting.promise;
		await session.abort();
		await waitForRoom(session);
		expect(summaries(await messagesOf(session))).toHaveLength(0);
		expect(await currentExchange(session)).toBeUndefined();
		await expect(exchange.waitForSummary()).rejects.toThrow(/interrupted/i);
		// the revocation stands: nothing wakes the assistant for the same close again
		expect(starts()).toBe(1);
		await clock.advance(200_000);
		expect(starts()).toBe(1);
		expect(await messagesOf(session)).toEqual(expect.any(Array));
	});

	it('rejects exchange completion when the room stops before publication', async () => {
		const session = await open({
			script: byAgent({ product: twoAnswers, assistant: writes('The one message.') }),
		});
		const events = collect(session);

		const visit = await session.visit(priya);
		const exchange = await visit.send({ text: 'Can I tell the client Thursday?' });
		// Shutdown while the room still owes a summary: the activation is aborted,
		// and completion for this unfinished exchange rejects.
		const waiting = exchange.waitForClose();
		await session.stop();
		await expect(waiting).rejects.toThrow(/stopped|interrupted/i);
		await expect(exchange.waitForSummary()).rejects.toThrow(/stopped|interrupted/i);
		expect(events.filter((e) => e.type === 'exchange_closed')).toHaveLength(0);
	});

	it('keeps the designated assistant apart from people', async () => {
		const session = await open({ script: byAgent({}) });
		await session.visit(priya);
		await waitForRoom(session);

		const seats = await participantsOf(session);
		expect(seats.find((s) => s.name === 'assistant')).toMatchObject({
			kind: 'agent',
			attention: 'none',
		});
		expect(seats.find((s) => s.name === 'priya')).toEqual({
			kind: 'human',
			name: 'priya',
			identity: 'Project manager. Owns the programme.',
			presence: 'present',
		});
	});
});

describe('an exchange', () => {
	/** The room's own exchange: it opens and closes on its own, whatever the assistant makes of it. */
	it('opens on a question, closes on quiescence, and holds the range it covered', async () => {
		const session = await open({ script: byAgent({ product: twoAnswers }) });
		const events = collect(session);

		const visit = await session.visit(priya);
		expect(await currentExchange(session)).toBeUndefined();
		await visit.send({ text: 'Can I tell the client Thursday?' });
		// it is open while the room works, and it names who asked
		expect((await currentExchange(session))?.owner).toBe('priya');
		await quiescent(session);

		expect(await currentExchange(session)).toBeUndefined();
		const record = await messagesOf(session);
		const question = record.find(isSpoken);
		const opened = events.filter((e) => e.type === 'exchange_opened');
		const closed = events.filter((e) => e.type === 'exchange_closed');
		expect(opened).toHaveLength(1);
		expect(closed).toHaveLength(1);
		expect(opened[0]).toMatchObject({ exchange: { owner: 'priya', from: question?.seq } });
		expect(closed[0]).toMatchObject({
			exchange: { owner: 'priya', from: question?.seq, through: record.at(-1)?.seq },
		});
		// the assistant is not scripted here, so it reads and stays quiet
		expect(summaries(record)).toHaveLength(0);
	});

	it('opens for nobody but a person, and never twice at once', async () => {
		const session = await open({
			agents: [product, greeter],
			seats: { [product.name]: 'broadcast', [greeter.name]: 'presence' },
			script: byAgent({
				product: answersEach,
				// It meets the arrival once; a seat that speaks on every activation
				// would keep waking the other one, and the room would never settle.
				greeter: (_context, _name, call) => (call === 1 ? speak('who just arrived?') : quiet()),
			}),
		});
		const events = collect(session);

		// arriving wakes the seat that watches the door and opens nothing
		const visit = await session.visit(priya);
		await quiescent(session);
		expect(events.filter((e) => e.type === 'exchange_opened')).toHaveLength(0);
		expect(await currentExchange(session)).toBeUndefined();

		// a second message into an open exchange steers it and changes nothing
		await visit.send({ text: 'first' });
		const owner = await currentExchange(session);
		await visit.send({ text: 'second' });
		expect(await currentExchange(session)).toEqual(owner);
		await quiescent(session);
		expect(events.filter((e) => e.type === 'exchange_opened')).toHaveLength(1);
		expect(events.filter((e) => e.type === 'exchange_closed')).toHaveLength(1);
	});

	/** Resolves when the named seat's next activation ends. */
	const _activationEnded = (session: Room, agent: string) =>
		new Promise<void>((resolve) => {
			const off = session.subscribe((event) => {
				if (event.type !== 'activation_end' || event.agent !== agent) return;
				off();
				resolve();
			});
		});

	/** A room over a storage that holds the writes the test names. */
	const gated = async (
		held: (type: string, data: { text?: string }) => Promise<void> | undefined,
	) =>
		createRuntime({
			clock,
			storage: gatedJournals((await memory.open()).storage, (type, data) =>
				held(type ?? '', (data as { body: { text?: string } }).body),
			),
		});

	/**
	 * A question asked the moment the named seat stops, before the room has
	 * decided on the quiet: the close the room decides is for the record
	 * without it, and the question waits on the storage until the test lets
	 * it land.
	 */
	const askedAsStops = (session: Room, seat: string, ask: () => Promise<unknown>) =>
		new Promise<{ landed: Promise<unknown> }>((resolve) => {
			const off = session.subscribe((event) => {
				if (event.type !== 'activation_end' || event.agent !== seat) return;
				off();
				resolve({ landed: ask() });
			});
		});

	const surveyor = defineAgent({
		name: 'surveyor',
		identity: 'Quantity surveyor.',
		instructions: 'x',
		model: 'scripted/surveyor',
	});

	const ranges = (events: RoomNotification[]) =>
		events.flatMap((e) =>
			e.type === 'exchange_closed' ? [[e.exchange.from, e.exchange.through]] : [],
		);
	const openings = (events: RoomNotification[]) =>
		events.flatMap((e) => (e.type === 'exchange_opened' ? [e.exchange.from] : []));

	it('keeps a message committed before close in the exchange that was already open', async () => {
		const gate = deferred();
		const working = deferred();
		const session = await open({
			runtime: await gated((_type, data) => (data.text === 'second?' ? gate.promise : undefined)),
			script: byAgent({
				product: async (_context, _name, call) => {
					if (call !== 1) return quiet();
					await working.promise;
					return quiet();
				},
			}),
		});
		const events = collect(session);
		const visit = await session.visit(priya);
		await visit.send({ text: 'first?' });
		const asked = askedAsStops(session, 'product', () => visit.send({ text: 'second?' }));
		working.resolve();
		const { landed: second } = await asked;
		await tick();
		await tick();
		gate.resolve();
		await second;
		await quiescent(session);

		const record = await messagesOf(session);
		const [first, next] = record.filter(isSpoken);
		// The stale close decision is reconsidered: the later committed question
		// remains inside the exchange that was already open.
		expect(ranges(events)).toEqual([[first?.seq, next?.seq]]);
		expect(openings(events)).toEqual([first?.seq]);
		expect(
			events.filter((e) => e.type === 'activation_start' && e.agent === 'product'),
		).toHaveLength(2);
	});

	it('does not split an exchange when a stale close races with a later question', async () => {
		const gate = deferred();
		const working = deferred();
		const session = await open({
			runtime: await gated((_type, data) => (data.text === 'second?' ? gate.promise : undefined)),
			agents: [product, surveyor],
			seats: { [product.name]: 'named' },
			script: byAgent({
				product: async () => {
					await working.promise;
					return quiet();
				},
				// composes nobody for the first question; the second gets no composing activation
				assistant: () => quiet(),
			}),
		});
		const events = collect(session);
		const visit = await session.visit(priya);
		await visit.send({ to: product.name, text: 'first?' });
		// the second question wakes nobody, and it is asked the moment the product stops
		const asked = askedAsStops(session, 'product', () => visit.send({ text: 'second?' }));
		working.resolve();
		const { landed: second } = await asked;
		await tick();
		await tick();
		gate.resolve();
		await second;
		await quiescent(session);

		const record = await messagesOf(session);
		const [first, next] = record.filter(isSpoken);
		// The later question stays in the first exchange because its close decision
		// was stale when it reached the journal.
		expect(ranges(events)).toEqual([[first?.seq, next?.seq]]);
		expect(openings(events)).toEqual([first?.seq]);
		expect(record.some((m) => m.kind === 'seated')).toBe(false);
		expect(await currentExchange(session)).toBeUndefined();
	});

	it('keeps a broadcast message in the open exchange even when no idle agent wakes', async () => {
		const gate = deferred();
		const working = deferred();
		const session = await open({
			runtime: await gated((_type, data) => (data.text === 'hey' ? gate.promise : undefined)),
			agents: [product, surveyor],
			seats: { [product.name]: 'named' },
			script: byAgent({
				product: async () => {
					await working.promise;
					return quiet();
				},
			}),
		});
		const events = collect(session);
		const visit = await session.visit(priya);
		await visit.send({ to: product.name, text: 'first?' });
		// a word into the room is asked the moment the product stops, and lands before the
		// close; the product has named attention, so only the assistant could activate.
		const asked = askedAsStops(session, 'product', () => visit.send({ text: 'hey' }));
		working.resolve();
		const { landed: said } = await asked;
		await tick();
		await tick();
		gate.resolve();
		await said;
		await quiescent(session);

		const record = await messagesOf(session);
		const [first, next] = record.filter(isSpoken);
		// The word was committed before the stale close could land, so it remains
		// in the existing exchange and does not trigger another composition.
		expect(openings(events)).toEqual([first?.seq]);
		expect(ranges(events)).toEqual([[first?.seq, next?.seq]]);
		expect(record.some((m) => m.kind === 'seated')).toBe(false);
		expect((await participantsOf(session)).find((s) => s.name === 'assistant')).toMatchObject({
			status: 'idle',
		});
		expect(await currentExchange(session)).toBeUndefined();
	});

	it('closes before the summary that stands for it', async () => {
		const session = await open({
			script: byAgent({ product: twoAnswers, assistant: writes('Thursday is out.') }),
		});
		const events = collect(session);

		const visit = await session.visit(priya);
		const exchange = await visit.send({ text: 'Can I tell the client Thursday?' });
		await quiescent(session);

		const order = events.map((e) => e.type);
		const closed = order.indexOf('exchange_closed');
		const summary = events.findIndex((e) => e.type === 'message' && e.message.kind === 'summary');
		// The exchange is over before the optional response is published.
		expect(closed).toBeGreaterThan(order.lastIndexOf('activation_end', closed));
		expect(summary).toBeGreaterThan(closed);
		await expect(exchange.waitForSummary()).resolves.toMatchObject({ kind: 'summary' });
		expect(summaries(await messagesOf(session))).toHaveLength(1);
	});
});

describe('a fold', () => {
	const at = new Date().toISOString();
	const say = (seq: number, from: string, text: string, to?: string): Message => ({
		kind: 'said',
		seq,
		at,
		from,
		...(to === undefined ? {} : { to }),
		text,
	});
	const stands = (seq: number, assistant: string, person: string, from: number, through: number) =>
		({
			kind: 'summary',
			seq,
			at,
			from: assistant,
			to: person,
			text: `the message ${person} reads`,
			covers: { from, through },
		}) satisfies Message;

	it('names the person its summary was written for', () => {
		const record = [
			say(1, 'priya', 'Can I tell the client Thursday?'),
			say(2, 'product', 'No.', 'priya'),
			say(3, 'colleague', 'Nor from here.', 'priya'),
			stands(4, 'assistant', 'priya', 1, 3),
		];

		expect(renderRecord(record, [], Date.parse(at))).toContain(
			'── 3 messages, summarised for priya below ──',
		);
	});

	/**
	 * A historical broad summary can overlap a newer summary. The fold still
	 * names each result by its recipient.
	 */
	it('keeps two overlapping ranges apart', () => {
		const record = [
			say(1, 'priya', 'Can I tell the client Thursday?'),
			say(2, 'product', 'No.', 'priya'),
			say(3, 'colleague', 'Nor from here.', 'priya'),
			say(4, 'sam', 'What do you need from me?'),
			say(5, 'product', 'A date.', 'sam'),
			say(6, 'colleague', 'And the plant.', 'sam'),
			stands(7, 'assistant', 'sam', 4, 6),
			stands(8, 'assistant', 'priya', 1, 7),
		];

		const lines = renderRecord(record, [], Date.parse(at)).split('\n');

		expect(lines).toEqual([
			'── 3 messages, summarised for priya below ──',
			'── 3 messages, summarised for sam below ──',
			'[assistant → sam] the message sam reads  (just now)',
			'[assistant → priya] the message priya reads  (just now)',
		]);
	});
});

describe('a room without a summary writer', () => {
	it('opens and closes an exchange, and owes no summary', async () => {
		// Nothing holds a room to an assistant. The room closes the exchange
		// the way it always does, and no close names a seat, so nothing is
		// owed and nobody drafts.
		const session = await startRoom({
			name: roomName(),
			agents: [product],
			runtime,
			streamFn: scripted(byAgent({ product: insists('Thursday is out.') })),
		});
		const events = collect(session);

		const visit = await session.visit(priya);
		await visit.send({ text: 'Can I tell the client Thursday?' });
		await quiescent(session);

		const record = await messagesOf(session);
		expect(record.filter((m) => m.kind === 'summary')).toEqual([]);
		expect(record.map((m) => m.kind)).toEqual(['arrived', 'said', 'said']);
		expect(events.filter((e) => e.type === 'exchange_closed')).toHaveLength(1);
		expect((await participantsOf(session)).map((s) => s.name)).toEqual(['product', 'priya']);
		await session.stop();
	});
});

describe('a summary writer with domain tools', () => {
	it('uses ordinary tools while responding and only say while summarizing', async () => {
		const book = defineTool({
			name: 'book-inspector',
			description: 'Book the inspector.',
			parameters: Type.Object({}),
			execute: () => 'booked',
		});
		const held: { closing: boolean; tools: string[]; prompt: string }[] = [];
		let seated = false;
		let published = false;
		const session = await open({
			script: byAgent({
				product: insists('Thursday is out.'),
				colleague: insists('Nor from here.'),
				assistant: (context) => {
					const closing = isClosing(context);
					held.push({ closing, tools: toolNames(context), prompt: context.systemPrompt ?? '' });
					if (!closing && !seated) {
						seated = true;
						return seat('colleague');
					}
					if (closing && !published) {
						published = true;
						return summarise('The one message.');
					}
					return quiet();
				},
			}),
			assistant: defineAgent({
				name: 'assistant',
				identity: 'Coordinates the answer.',
				instructions: 'Collaborate.',
				model: 'scripted/assistant',
				bundles: [{ tools: [book], guidance: 'Book guidance.' }],
			}),
			agents: [product, colleague],
			seats: { product: 'broadcast', assistant: 'broadcast' },
		});
		await (await session.visit(priya)).send({ text: 'Can I tell the client Thursday?' });
		await quiescent(session);
		const ordinary = held.filter((view) => !view.closing);
		const closing = held.filter((view) => view.closing);
		expect(ordinary.length).toBeGreaterThan(0);
		expect(closing.length).toBeGreaterThan(0);
		for (const view of ordinary) {
			expect(view.tools).toEqual(['say', 'seat', 'unseat', 'book-inspector']);
			expect(view.prompt).toContain('Book guidance.');
		}
		for (const view of closing) {
			expect(view.tools).toEqual(['say']);
			expect(view.prompt).not.toContain('Book guidance.');
		}
		expect(summaries(await messagesOf(session))).toHaveLength(1);
	});
});

describe('defineHuman', () => {
	it('keeps how a person reads, and drops a blank', () => {
		expect(priya.preferences).toBe(
			'Lead with the decision she has to make. Leave out who said what.',
		);
		expect(dan.preferences).toBeUndefined();
		expect(
			defineHuman({ name: 'eve', identity: 'Eve.', preferences: '   ' }).preferences,
		).toBeUndefined();
	});
});

describe('ordinary and closing work on one agent', () => {
	it('keeps a later exchange open while its writer finishes the earlier summary', async () => {
		const closingStarted = deferred();
		const finishClosing = deferred();
		const closingContexts: string[] = [];
		const answered = new Set<string>();
		const session = await open({
			agents: [],
			seats: { assistant: 'broadcast' },
			script: byAgent({
				assistant: async (context) => {
					const record = contextText(context);
					if (isClosing(context)) {
						closingContexts.push(record);
						if (closingContexts.length === 1) {
							closingStarted.resolve();
							await finishClosing.promise;
						}
						return summarise(`Summary ${closingContexts.length}.`);
					}
					const question = record.includes('Second question?')
						? 'Second question?'
						: 'First question?';
					if (answered.has(question)) return quiet();
					answered.add(question);
					return speak(`Answer to ${question}`);
				},
			}),
		});
		const visit = await session.visit(priya);
		const first = await visit.send({ text: 'First question?' });
		await closingStarted.promise;
		const second = await visit.send({ text: 'Second question?' });
		await session.reconcile();
		expect(await currentExchange(session)).toMatchObject({ from: second.from });
		let settled = false;
		const discussion = second.waitForClose().then((messages) => {
			settled = true;
			return messages;
		});
		await tick();
		expect(settled).toBe(false);
		finishClosing.resolve();
		expect(
			(await discussion).some(
				(message) => isSpoken(message) && message.text === 'Answer to Second question?',
			),
		).toBe(true);
		expect(await first.waitForSummary()).toMatchObject({ kind: 'summary', text: 'Summary 1.' });
		expect(await second.waitForSummary()).toMatchObject({ kind: 'summary', text: 'Summary 2.' });
		await quiescent(session);
		expect(closingContexts).toHaveLength(2);
		expect(closingContexts[0]).not.toContain('Second question?');
		expect(closingContexts[1]).not.toContain('First question?');
	});
});
