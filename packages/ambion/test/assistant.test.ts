import type { SessionRepo } from '@earendil-works/pi-agent-core';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { afterEach, describe, expect, it } from 'vitest';
import {
	attentive,
	defineAgent,
	defineHuman,
	defineTool,
	InMemorySessionRepo,
	isSpoken,
	type Message,
	type Session,
	type SessionEvent,
	type SummaryMessage,
	startSession,
	stopSession,
	visitSession,
} from '../src/index.ts';
import { renderRecord } from '../src/render.ts';
import { assistantEnded, collect, deferred, roomName as name, tick } from './support/room.ts';
import {
	byAgent,
	contextText,
	quiet,
	type Script,
	scripted,
	speak,
	summarise,
} from './support/scripted.ts';

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

const started: Session[] = [];

function open(options: {
	script: Script;
	agents?: Parameters<typeof startSession>[0]['agents'];
	assistant?: Parameters<typeof startSession>[0]['assistant'];
	repo?: SessionRepo;
}): Session {
	const session = startSession({
		name: roomName(),
		goal: 'Decide the pour date and keep the plan honest.',
		assistant: options.assistant ?? assistant,
		agents: options.agents ?? [product],
		streamFn: scripted(options.script),
		...(options.repo ? { repo: options.repo } : {}),
	});
	started.push(session);
	return session;
}

afterEach(async () => {
	for (const session of started.splice(0)) await stopSession(session);
});

/** The assistant writes after the room is quiet, so a test waits for what it wrote. */
function nextSummary(session: Session): Promise<SummaryMessage> {
	return new Promise((resolve) => {
		const off = session.subscribe((event) => {
			if (event.type !== 'message' || event.message.kind !== 'summary') return;
			off();
			resolve(event.message);
		});
	});
}

/** Quiet: no seat is taking an activation, and the assistant owes nobody a message. */
function quiescent(session: Session): Promise<void> {
	return session.quiet();
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
		call % 2 === 1 ? summarise(`${text} ${call}`) : quiet();

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

describe('the assistant', () => {
	it('writes one message for an exchange the room answered more than once', async () => {
		const contexts: string[] = [];
		const prompts: string[] = [];
		const hands: string[] = [];
		const session = open({
			script: byAgent({
				product: twoAnswers,
				assistant: (context, _name, call) => {
					contexts.push(contextText(context));
					prompts.push(context.systemPrompt ?? '');
					hands.push((context.tools ?? []).map((tool) => tool.name).join(','));
					return call === 1
						? summarise('Thursday is out. Saturday holds if the rebar lands Wednesday.')
						: quiet();
				},
			}),
		});
		const written = nextSummary(session);
		const ended = assistantEnded(session);

		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'Can I tell the client Thursday for the pour?' });
		const summary = await written;
		await ended;

		expect(summary.from).toBe('assistant');
		expect(summary.to).toBe('priya');
		expect(summary.text).toContain('Saturday');
		// contiguous: it lands immediately after the range it stands for
		expect(summary.covers.through).toBe(summary.seq - 1);

		const record = await session.messages();
		expect(summary.covers.from).toBe(record.find((m) => isSpoken(m))?.seq);
		expect(record.map((m) => m.kind)).toEqual(['arrived', 'said', 'said', 'said', 'summary']);

		// what an assistant is handed: the range it covers, and one hand that reaches the record
		expect(hands).toEqual(['summarise', 'summarise']);
		expect(contexts[0]).toContain('Can I tell the client Thursday');
		expect(contexts[0]).toContain('the inspector needs 48h notice');
		// what its person owns reaches it in the roster, so an assistant holds no copy
		expect(contexts[0]).toContain('Project manager. Owns the programme.');
		// and it is addressed as the assistant it is, not as a seat that speaks
		expect(prompts[0]).toContain("'assistant', the assistant in the session");
		expect(prompts[0]).toContain('Writing is the summarise tool');
		expect(prompts[0]).not.toContain('Speaking is the say tool');
		// it is told whom it writes for, and how that person reads
		expect(prompts[0]).toContain('You are writing for priya.');
		expect(prompts[0]).toContain('Leave out who said what.');
		// the last line names the range this activation closes
		expect(contexts[0]).toContain(
			`priya's exchange is over: messages ${summary.covers.from} to ${summary.covers.through}`,
		);
	});

	it('leaves one answer as it was given, in the voice that gave it', async () => {
		const session = open({
			script: byAgent({ product: oneAnswer, assistant: writes('nobody asked for this') }),
		});

		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'Can I tell the client Thursday?' });
		await quiescent(session);

		expect(summaries(await session.messages())).toHaveLength(0);
	});

	it('wakes nobody, and every seat reads it at the next activation', async () => {
		const contexts: string[] = [];
		const prompts: string[] = [];
		const session = open({
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

		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'Can I tell the client Thursday?' });
		const summary = await written;
		await quiescent(session);

		// nothing an assistant writes activates a seat
		const landed = events.findIndex((e) => e.type === 'message' && e.message === summary);
		expect(events.slice(landed).filter((e) => e.type === 'activation_start')).toHaveLength(0);

		await visit.deliver({ text: 'And the pump?' });
		await quiescent(session);

		// the range left the seat's context, and the summary stands for it
		const read = contexts.at(-1) ?? '';
		expect(read).toContain('── 3 messages, summarised for priya below ──');
		expect(read).toContain('[assistant → priya] Thursday is out; Saturday holds.');
		expect(read).not.toContain('the inspector needs 48h notice');
		// the roster names the seat that writes for people, and nobody brings one
		expect(read).toContain('- assistant (idle, wakes for nothing said, the assistant):');
		expect(read).not.toContain('brings');
		// a record that holds a summary tells its seats how to read a fold; one that does not, does not
		expect(prompts[0]).not.toContain('summarised for <name> below');
		expect(prompts.at(-1)).toContain('summarised for <name> below');
		// the record keeps every message, and nothing was rewritten
		expect(said(await session.messages())).toContain(
			'Thursday is out: the inspector needs 48h notice.',
		);
	});

	it('owns the question that lands while a seat works on what nobody asked for', async () => {
		const greeting = deferred();
		const session = open({
			agents: [product, attentive(greeter)],
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
		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'Can I tell the client Thursday?' });
		greeting.resolve();
		const summary = await written;

		expect(summary.to).toBe('priya');
		const record = await session.messages();
		expect(summary.covers.from).toBe(record.find((m) => isSpoken(m))?.seq);
	});

	it('refuses a draft the room moved past, and redrafts inside the same activation', async () => {
		const held = deferred();
		const refusals: string[] = [];
		const session = open({
			script: byAgent({
				product: answersEach,
				assistant: async (context, _name, call) => {
					if (call === 1) await held.promise;
					if (call === 2) refusals.push(contextText(context));
					return call > 2 ? quiet() : summarise(`draft ${call}`);
				},
			}),
		});
		const events = collect(session);

		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'Can I tell the client Thursday?' });
		await session.settled();
		// the assistant has read its range and is drafting against it
		await tick();

		const written = nextSummary(session);
		await visit.deliver({ text: 'And the pump?' });
		await session.settled();
		held.resolve();
		const summary = await written;
		await quiescent(session);

		const conflicts = events.filter((e) => e.type === 'conflict');
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0]).toMatchObject({ author: 'assistant' });
		// the refusal reached the assistant as a tool result, carrying what it missed
		expect(refusals[0]).toContain('Not written');
		expect(refusals[0]).toContain('And the pump?');

		const record = await session.messages();
		expect(summaries(record)).toHaveLength(1);
		// the redraft covers what it covered before, plus whatever won the race
		expect(summary.text).toBe('draft 2');
		expect(summary.covers.from).toBe(record.find((m) => isSpoken(m))?.seq);
		expect(summary.covers.through).toBe(summary.seq - 1);
	});

	it('stops drafting after the second refusal, and writes when the room is quiet', async () => {
		const first = deferred();
		const second = deferred();
		const drafts: string[] = [];
		const session = open({
			script: byAgent({
				product: answersEach,
				// an assistant that never gives up: what stops it is the runtime, not the script
				// an assistant that never gives up: what stops it is the runtime, not the script
				assistant: async (context, _name, call) => {
					drafts.push(contextText(context));
					if (call === 1) await first.promise;
					if (call === 2) await second.promise;
					return summarise(`draft ${call}`);
				},
			}),
		});
		const events = collect(session);

		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'Can I tell the client Thursday?' });
		await session.settled();
		await tick();

		// two arrivals move the record under the assistant, and wake nobody
		const his = await visitSession(session, sam);
		first.resolve();
		await tick();
		await his.leave();
		second.resolve();
		const stoodDown = assistantEnded(session);
		await stoodDown;

		expect(events.filter((e) => e.type === 'conflict')).toHaveLength(2);
		expect(summaries(await session.messages())).toHaveLength(0);
		// the activation ended after the second refusal, and did not draft for ever
		expect(drafts).toHaveLength(3);

		// the range is still owed, and the next quiescence writes it
		const written = nextSummary(session);
		await visit.deliver({ text: 'And the pump?' });
		const summary = await written;

		expect(summary.text).toBe('draft 4');
		expect(summary.covers.from).toBe((await session.messages()).find((m) => isSpoken(m))?.seq);
	});

	it('stands down without writing, and is not owed a summary for it', async () => {
		const calls: string[] = [];
		const session = open({
			agents: [product, attentive(greeter)],
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

		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'Can I tell the client Thursday?' });
		await quiescent(session);

		// somebody arriving wakes the seat that watches the door, and quietens again
		await visitSession(session, sam);
		await quiescent(session);

		expect(calls).toHaveLength(1);
		expect(summaries(await session.messages())).toHaveLength(0);
		expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
		expect(
			events.filter((e) => e.type === 'activation_end' && e.agent === 'assistant'),
		).toMatchObject([{ spoke: false }]);
	});

	it('drafts again at the next quiescence when its activation fails outright', async () => {
		const session = open({
			agents: [product, attentive(greeter)],
			script: byAgent({
				product: twoAnswers,
				assistant: (context, name, call) => {
					if (call === 1) return broken(context, name, call);
					return call === 2 ? summarise('written the second time') : quiet();
				},
			}),
		});
		const events = collect(session);

		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'Can I tell the client Thursday?' });
		await quiescent(session);
		expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
		expect(summaries(await session.messages())).toHaveLength(0);

		// a failed activation leaves the summary owed, and the next quiet room writes it
		const written = nextSummary(session);
		await visitSession(session, sam);
		const summary = await written;

		expect(summary.text).toBe('written the second time');
		expect(summary.covers.from).toBe((await session.messages()).find((m) => isSpoken(m))?.seq);
	});

	it('writes for the person whose question opened the exchange, and for nobody else', async () => {
		const working = deferred();
		const session = open({
			agents: [product, colleague],
			script: byAgent({
				product: heldUntil(working.promise),
				assistant: writes("Priya's message."),
			}),
		});
		const written = nextSummary(session);

		const hers = await visitSession(session, priya);
		const his = await visitSession(session, sam);
		await hers.deliver({ text: 'Can I tell the client Thursday?' });
		// a message into a working room steers the seats; it owns nothing
		await his.deliver({ text: 'Rain all Thursday. I am not pouring into that.' });
		working.resolve();
		const summary = await written;
		await quiescent(session);

		expect(summary.to).toBe('priya');
		expect(summaries(await session.messages())).toHaveLength(1);
	});

	it('writes for a person who left before the room settled, the way they read', async () => {
		const working = deferred();
		const prompts: string[] = [];
		const session = open({
			script: byAgent({
				product: heldUntil(working.promise),
				assistant: (context, name, call) => {
					prompts.push(context.systemPrompt ?? '');
					return writes('The answer, waiting for her.')(context, name, call);
				},
			}),
		});
		const written = nextSummary(session);

		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'Can I tell the client Thursday?' });
		await visit.leave();
		working.resolve();
		const summary = await written;

		expect(summary.to).toBe('priya');
		expect(summary.covers.through).toBe(summary.seq - 1);
		// how she reads outlives her visit, with the exchange she opened
		expect(prompts[0]).toContain('Leave out who said what.');
	});

	it('reads each person their own way, and reads nobody else’s way to them', async () => {
		const prompts: string[] = [];
		const session = open({
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

		const hers = await visitSession(session, priya);
		const his = await visitSession(session, sam);
		const theirs = await visitSession(session, dan);
		await hers.deliver({ text: 'Can I tell the client Thursday?' });
		await quiescent(session);
		await his.deliver({ text: 'What do my crews do at seven?' });
		await quiescent(session);
		await theirs.deliver({ text: 'What does the move cost?' });
		await quiescent(session);

		const written = summaries(await session.messages());
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
		const session = open({
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

		const hers = await visitSession(session, priya);
		const his = await visitSession(session, sam);
		await hers.deliver({ text: 'Can I tell the client Thursday?' });
		await session.settled();
		await tick();
		// the assistant is drafting for priya; sam's exchange opens, runs and closes under it
		await his.deliver({ text: 'What do my crews do at seven?' });
		await session.settled();
		held.resolve();
		await quiescent(session);

		const written = summaries(await session.messages());
		expect(written.map((m) => m.to)).toEqual(['priya', 'sam']);
		// one seat, so the two activations ran one after the other
		const starts = seen.filter((e) => e.type === 'activation_start' && e.agent === 'assistant');
		const ends = seen.filter((e) => e.type === 'activation_end' && e.agent === 'assistant');
		expect(starts).toHaveLength(2);
		expect(seen.indexOf(starts[1] as SessionEvent)).toBeGreaterThan(
			seen.indexOf(ends[0] as SessionEvent),
		);
		// and sam's range starts at his own question
		const questions = (await session.messages()).filter((m) => isSpoken(m) && m.from === 'sam');
		expect(written[1]?.covers.from).toBe(questions[0]?.seq);
	});

	it("keeps the assistant's turns in a downstream session of its own, like any seat", async () => {
		const repo = new InMemorySessionRepo();
		const session = open({
			repo,
			script: byAgent({ product: twoAnswers, assistant: writes('The one message.') }),
		});
		const written = nextSummary(session);
		const ended = assistantEnded(session);

		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'Can I tell the client Thursday?' });
		await written;
		await ended;

		const metadata = (await repo.list()).find((m) => m.id === `${session.name}:assistant`);
		expect(metadata).toBeDefined();
		// and the room lists it as the seat it is: an agent, seated none, the assistant
		const seat = session.seats().find((s) => s.name === 'assistant');
		expect(seat).toMatchObject({ kind: 'agent', assistant: true, attention: 'none' });
		const piSeat = metadata && (await repo.open(metadata));
		const entries = (await piSeat?.findEntries()) ?? [];
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
		expect(() => open({ script: byAgent({}), assistant: clash })).toThrow(
			/one name names one participant/,
		);

		const session = open({ script: byAgent({}) });
		const twin = defineHuman({ name: 'assistant', identity: 'Not the assistant.' });
		await expect(visitSession(session, twin)).rejects.toThrow(/is an agent in this session/);
	});

	it('is seated when the room starts, and an agent-only room never activates it', async () => {
		const session = open({ script: byAgent({ product: () => speak('working alone') }) });
		const events = collect(session);
		await session.settled();
		await quiescent(session);

		const seat = session.seats().find((s) => s.name === 'assistant');
		expect(seat).toMatchObject({
			kind: 'agent',
			assistant: true,
			attention: 'none',
			status: 'idle',
		});
		expect(
			events.filter((e) => e.type === 'activation_start' && e.agent === 'assistant'),
		).toHaveLength(0);
	});

	it('covers one exchange, and never reaches back over the one before it', async () => {
		const session = open({
			script: byAgent({ product: twoAnswersEach, assistant: writesEach('the answer') }),
		});

		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'Can I tell the client Thursday?' });
		await quiescent(session);
		await visit.deliver({ text: 'And what does Saturday need?' });
		await quiescent(session);

		const record = await session.messages();
		const written = summaries(record);
		expect(written).toHaveLength(2);
		const questions = record.filter((m) => isSpoken(m) && m.from === 'priya');
		// the second stands for her second question, not for everything since her first
		expect(written[1]?.covers.from).toBe(questions[1]?.seq);
		expect(written[1]?.covers.from).toBeGreaterThan(written[0]?.seq ?? 0);
		expect(written[0]?.covers.from).toBe(questions[0]?.seq);
	});

	it('goes quiet when the summary lands, and settles before it', async () => {
		const session = open({
			script: byAgent({ product: twoAnswers, assistant: writes('Thursday is out.') }),
		});
		const events = collect(session);

		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'Can I tell the client Thursday?' });
		await session.settled();
		// settled reports the seats alone: the assistant has not written yet
		expect(summaries(await session.messages())).toHaveLength(0);

		await session.quiet();
		expect(summaries(await session.messages())).toHaveLength(1);
		const wrote = events.findIndex((e) => e.type === 'message' && e.message.kind === 'summary');
		const quiet = events.findIndex((e) => e.type === 'quiet');
		expect(quiet).toBeGreaterThan(wrote);
	});

	it('refuses an empty say, so an empty message never stands inside a range', async () => {
		const contexts: string[] = [];
		const session = open({
			script: byAgent({
				product: (context, _name, call) => {
					contexts.push(contextText(context));
					if (call === 1) return speak('   ');
					if (call === 2) return speak('Thursday is out.');
					return quiet();
				},
			}),
		});

		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'Can I tell the client Thursday?' });
		await quiescent(session);

		expect(said(await session.messages())).toEqual([
			'Can I tell the client Thursday?',
			'Thursday is out.',
		]);
		expect(contexts.at(-1)).toContain('The message is empty');
	});

	it('is quiet with a summary owed, because owing one is not working on one', async () => {
		const session = open({
			script: byAgent({ product: twoAnswers, assistant: broken }),
		});

		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'Can I tell the client Thursday?' });
		await quiescent(session);

		// the activation failed, so the summary is owed and the range is still whole
		expect(summaries(await session.messages())).toHaveLength(0);
		// and a host asking again is not made to wait for work nobody is doing
		await expect(session.quiet()).resolves.toBeUndefined();
	});

	it('does not report that a stopped room went quiet', async () => {
		const session = open({
			script: byAgent({ product: twoAnswers, assistant: writes('The one message.') }),
		});
		const events = collect(session);

		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'Can I tell the client Thursday?' });
		// Shutdown while the room still owes a summary: the activations are aborted,
		// whoever waited on quiet is drained, and nothing is quiet afterwards.
		const waiting = session.quiet();
		await stopSession(session);
		await waiting;
		const after = events.length;
		await tick();
		await tick();

		expect(events.slice(after).map((e) => e.type)).not.toContain('quiet');
	});

	it('names the assistant on the seat a host reads, and on no person', async () => {
		const session = open({ script: byAgent({}) });
		await visitSession(session, priya);
		await session.settled();

		const seats = session.seats();
		expect(seats.filter((s) => s.kind === 'agent' && s.assistant).map((s) => s.name)).toEqual([
			'assistant',
		]);
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
		const session = open({ script: byAgent({ product: twoAnswers }) });
		const events = collect(session);

		const visit = await visitSession(session, priya);
		expect(session.exchange()).toBeUndefined();
		await visit.deliver({ text: 'Can I tell the client Thursday?' });
		// it is open while the room works, and it names who asked
		expect(session.exchange()?.owner).toBe('priya');
		await quiescent(session);

		expect(session.exchange()).toBeUndefined();
		const record = await session.messages();
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
		const session = open({
			agents: [product, attentive(greeter)],
			script: byAgent({
				product: answersEach,
				// It meets the arrival once; a seat that speaks on every activation
				// would keep waking the other one, and the room would never settle.
				greeter: (_context, _name, call) => (call === 1 ? speak('who just arrived?') : quiet()),
			}),
		});
		const events = collect(session);

		// arriving wakes the seat that watches the door and opens nothing
		const visit = await visitSession(session, priya);
		await quiescent(session);
		expect(events.filter((e) => e.type === 'exchange_opened')).toHaveLength(0);
		expect(session.exchange()).toBeUndefined();

		// a second message into an open exchange steers it and changes nothing
		await visit.deliver({ text: 'first' });
		const owner = session.exchange();
		await visit.deliver({ text: 'second' });
		expect(session.exchange()).toEqual(owner);
		await quiescent(session);
		expect(events.filter((e) => e.type === 'exchange_opened')).toHaveLength(1);
		expect(events.filter((e) => e.type === 'exchange_closed')).toHaveLength(1);
	});

	it('closes before the summary that stands for it', async () => {
		const session = open({
			script: byAgent({ product: twoAnswers, assistant: writes('Thursday is out.') }),
		});
		const events = collect(session);

		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'Can I tell the client Thursday?' });
		await quiescent(session);

		const order = events.map((e) => e.type);
		const closed = order.indexOf('exchange_closed');
		const summary = events.findIndex((e) => e.type === 'message' && e.message.kind === 'summary');
		// the exchange is over, then what stands for it, then the room is quiet
		expect(closed).toBeGreaterThan(order.lastIndexOf('activation_end', closed));
		expect(summary).toBeGreaterThan(closed);
		expect(order.indexOf('quiet')).toBeGreaterThan(summary);
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
	 * A race widens the range a refused draft covers, so one summary can stand
	 * for another. The fold above each one still names the person it is for.
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

describe('startSession', () => {
	it('refuses a room with no assistant', () => {
		const noAssistant = { name: roomName(), agents: [product] } as unknown as Parameters<
			typeof startSession
		>[0];
		expect(() => startSession(noAssistant)).toThrow(/must come from defineAgent/);
	});

	it('refuses an assistant with hands', () => {
		const book = defineTool({
			name: 'book_inspector',
			description: 'Book the inspector.',
			parameters: Type.Object({}),
			execute: () => 'booked',
		});
		expect(() =>
			open({
				script: byAgent({}),
				assistant: defineAgent({
					name: 'assistant',
					identity: 'Writes the one message a person reads.',
					instructions: 'summarise',
					model: 'scripted/assistant',
					tools: [book],
				}),
			}),
		).toThrow(/never acts in it/);
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
