import type { Context } from '@earendil-works/pi-ai';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'vitest';
import {
	attentive,
	defineAgent,
	defineHuman,
	isPresence,
	type Message,
	type PresenceMessage,
	passive,
	type Session,
	type SessionEvent,
	seated,
	startSession,
	stopSession,
	visitSession,
} from '../src/index.ts';
import { assistantEnded, collect, deferred, roomName as name, tick } from './support/room.ts';
import {
	byAgent,
	contextText,
	quiet,
	type Script,
	scripted,
	seat,
	speak,
	summarise,
	toolNames,
} from './support/scripted.ts';

/** Which activation the assistant is taking, read off the one hand it holds. */
const holding = (context: Context, tool: string) => toolNames(context).includes(tool);

/**
 * An assistant that seats the named agents at every open, one per call, and
 * writes one message at every close.
 */
function composes(names: string[], summary = 'the one message'): Script {
	return (context) => {
		if (holding(context, 'seat')) {
			const next = names.shift();
			return next ? seat(next) : quiet();
		}
		if (holding(context, 'summarise')) return summarise(summary);
		return quiet();
	};
}

/** What the model's last tool call returned, as text, when the last message is one. */
function lastToolResult(context: Context): string[] {
	const last = context.messages.at(-1);
	if (last?.role !== 'toolResult') return [];
	return [last.content.map((c) => (c.type === 'text' ? c.text : '')).join('')];
}

// -- the room ----------------------------------------------------------------

const roomName = () => name('roster');

const product = defineAgent({
	name: 'product',
	identity: 'The product seated from the start.',
	instructions: 'answer what is asked',
	model: 'scripted/product',
});

const surveyor = defineAgent({
	name: 'surveyor',
	identity: 'Quantity surveyor. Holds the tonnage.',
	instructions: 'answer about quantities',
	model: 'scripted/surveyor',
});

const architect = defineAgent({
	name: 'architect',
	identity: 'Architect. Holds the drawings.',
	instructions: 'answer about drawings',
	model: 'scripted/architect',
});

const greeter = defineAgent({
	name: 'greeter',
	identity: 'Meets people at the door.',
	instructions: 'notice who is here',
	model: 'scripted/greeter',
});

const assistant = defineAgent({
	name: 'assistant',
	identity: 'Composes the room, and writes the one message a person reads.',
	instructions: 'Seat who the question needs. Answer what was asked, once.',
	model: 'scripted/assistant',
});

const priya = defineHuman({ name: 'priya', identity: 'Project manager.' });

const started: Session[] = [];

type Options = Parameters<typeof startSession>[0];

function open(options: {
	script: Script;
	agents?: Options['agents'];
	available?: Options['available'];
}): Session {
	const session = startSession({
		name: roomName(),
		goal: 'Decide the pour date.',
		assistant,
		streamFn: scripted(options.script),
		...(options.agents ? { agents: options.agents } : {}),
		...(options.available ? { available: options.available } : {}),
	});
	started.push(session);
	return session;
}

afterEach(async () => {
	for (const session of started.splice(0)) await stopSession(session);
});

const kinds = (record: Message[]) => record.map((m) => m.kind);
const presence = (record: Message[]) => record.filter(isPresence);
const activated = (events: SessionEvent[]) =>
	events.filter((e) => e.type === 'activation_start').map((e) => e.agent);
const seatNames = (session: Session) =>
	session
		.seats()
		.filter((s) => s.kind === 'agent')
		.map((s) => s.name);

// -- what proves it ----------------------------------------------------------

describe('a room that starts with the assistant alone', () => {
	it('opens and closes an exchange for a question that wakes nobody', async () => {
		const session = open({ script: byAgent({}) });
		const events = collect(session);

		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'Is anybody there?' });
		await session.quiet();

		expect(seatNames(session)).toEqual(['assistant']);
		expect(activated(events)).toEqual([]);
		expect(
			events.map((e) => e.type).filter((t) => t.startsWith('exchange') || t === 'quiet'),
		).toEqual(['exchange_opened', 'exchange_closed', 'quiet']);
		expect(session.exchange()).toBeUndefined();
		expect(kinds(await session.messages())).toEqual(['arrived', 'said']);
	});

	it('closes an exchange nobody woke in a room where every seat is named', async () => {
		const session = open({ script: byAgent({}), agents: [passive(product)] });
		const events = collect(session);

		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'Anyone?' });
		await session.quiet();

		expect(activated(events)).toEqual([]);
		expect(session.exchange()).toBeUndefined();
	});
});

describe('the reserve', () => {
	it('refuses a name in both lists, and a person who visits as one', async () => {
		expect(() =>
			startSession({
				name: roomName(),
				assistant,
				agents: [product],
				available: [product],
				streamFn: scripted(byAgent({})),
			}),
		).toThrow(/Duplicate agent name 'product'/);

		const session = open({ script: byAgent({}), available: [surveyor] });
		await expect(
			visitSession(session, defineHuman({ name: 'surveyor', identity: 'A person.' })),
		).rejects.toThrow(/is an agent in this session/);
	});

	it('is what the assistant reads at an open, minus who is seated', async () => {
		const reserves: string[] = [];
		const hands: string[][] = [];
		const session = open({
			script: byAgent({
				assistant: (context) => {
					if (!holding(context, 'seat')) return quiet();
					reserves.push(contextText(context));
					hands.push(toolNames(context));
					return quiet();
				},
			}),
			agents: [product],
			available: [surveyor, seated(architect, 'named')],
		});

		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'How much steel is on site?' });
		await session.quiet();

		expect(hands).toEqual([['seat']]);
		expect(reserves[0]).toContain('The reserve: agents not in the room');
		expect(reserves[0]).toContain('- surveyor: Quantity surveyor. Holds the tonnage.');
		expect(reserves[0]).toContain('- architect: Architect. Holds the drawings.');
		expect(reserves[0]).toContain('priya asked at message 2. Seat who the question needs');
		// the seated product is in the roster, and never in the reserve
		expect(reserves[0]).not.toContain('- product:');
		expect(reserves[0]).toContain('- product (');
	});

	it('is never read by a seat, and wakes no assistant when empty', async () => {
		const contexts: string[] = [];
		const session = open({
			script: byAgent({
				product: (context) => {
					contexts.push(contextText(context));
					return quiet();
				},
			}),
			agents: [product],
		});
		const events = collect(session);

		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'Anything?' });
		await session.quiet();

		expect(activated(events)).toEqual(['product']);
		expect(contexts[0]).not.toContain('The reserve');
	});
});

describe('seating', () => {
	it('lands as a message stamped by the assistant, and wakes the seat it names', async () => {
		const surveyorContexts: string[] = [];
		const session = open({
			script: byAgent({
				assistant: composes(['surveyor']),
				surveyor: (context, _name, call) => {
					surveyorContexts.push(contextText(context));
					return call === 1 ? speak('11.7 tonnes on site.') : quiet();
				},
				product: () => quiet(),
			}),
			agents: [product],
			available: [surveyor, architect],
		});
		const events = collect(session);

		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'How much steel is on site?' });
		await session.quiet();

		const record = await session.messages();
		const seating = presence(record).find((m) => m.kind === 'seated') as PresenceMessage;
		expect(seating).toMatchObject({
			kind: 'seated',
			from: 'surveyor',
			by: 'assistant',
			identity: 'Quantity surveyor. Holds the tonnage.',
		});
		expect(kinds(record)).toEqual(['arrived', 'said', 'seated', 'said']);
		expect(seatNames(session)).toEqual(['product', 'assistant', 'surveyor']);

		// the newcomer woke once, on its seating, and read the question it was seated for
		expect(activated(events).filter((n) => n === 'surveyor')).toEqual(['surveyor']);
		expect(surveyorContexts[0]).toContain('How much steel is on site?');
		expect(surveyorContexts[0]).toContain('· surveyor seated by assistant');
		expect(surveyorContexts[0]).toContain("priya's question at message 2 is open.");
	});

	it('wakes nobody at broadcast: a seating has no words in it', async () => {
		const session = open({
			script: byAgent({ assistant: composes(['surveyor']) }),
			agents: [product],
			available: [surveyor],
		});
		const events = collect(session);

		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'How much steel is on site?' });
		await session.quiet();

		expect(kinds(await session.messages())).toEqual(['arrived', 'said', 'seated']);
		// the product woke once, for the question; the surveyor once, for its seating
		expect(activated(events).filter((n) => n !== 'assistant')).toEqual(['product', 'surveyor']);
	});

	it('wakes a seat at presence, and steers a seat still at work', async () => {
		const held = deferred();
		const productContexts: string[] = [];
		const session = open({
			script: byAgent({
				assistant: composes(['surveyor']),
				product: async (context, _name, call) => {
					productContexts.push(contextText(context));
					if (call === 1) {
						await held.promise;
						return quiet('still reading');
					}
					return call === 2 ? speak('Ask the surveyor for the number.', 'surveyor') : quiet();
				},
			}),
			agents: [product, attentive(greeter)],
			available: [surveyor],
		});
		const events = collect(session);

		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'How much steel is on site?' });
		// the assistant seats the surveyor while the product is still reading
		await new Promise<void>((resolve) => {
			const off = session.subscribe((event) => {
				if (event.type !== 'message' || event.message.kind !== 'seated') return;
				off();
				resolve();
			});
		});
		held.resolve();
		await session.quiet();

		// the greeter watches the door, so a colleague joining woke it
		expect(activated(events)).toContain('greeter');
		// the product heard the seating mid-activation, then addressed the newcomer
		expect(productContexts.at(-1)).toContain('· surveyor seated by assistant');
		const record = await session.messages();
		expect(record.some((m) => m.kind === 'said' && m.to === 'surveyor')).toBe(true);
	});

	it('keeps the exchange open through the composing activation, and the summary covers the newcomer', async () => {
		const session = open({
			script: byAgent({
				assistant: composes(['surveyor'], 'Steel: 11.7 tonnes, enough for the pour.'),
				// the seating and the newcomer's say may both land under its say, so it speaks again when refused
				product: (_context, _name, call) => (call <= 3 ? speak('The pour is Saturday.') : quiet()),
				surveyor: (_context, _name, call) => (call === 1 ? speak('11.7 tonnes on site.') : quiet()),
			}),
			agents: [product],
			available: [surveyor],
		});
		const events = collect(session);

		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'Is there enough steel for the pour?' });
		await session.quiet();

		const record = await session.messages();
		const summary = record.find((m) => m.kind === 'summary');
		const seating = record.find((m) => m.kind === 'seated');
		const answer = record.find((m) => m.kind === 'said' && m.from === 'surveyor');
		expect(summary).toBeDefined();
		expect(seating).toBeDefined();
		expect(answer).toBeDefined();
		// one exchange, and it covered the seating and what the newcomer said
		const closed = events.filter((e) => e.type === 'exchange_closed');
		expect(closed).toHaveLength(1);
		if (closed[0]?.type === 'exchange_closed' && summary?.kind === 'summary' && answer) {
			expect(closed[0].exchange.through).toBeGreaterThanOrEqual(answer.seq);
			expect(summary.covers.through).toBeGreaterThanOrEqual(answer.seq);
		}
		// settled resolved after the composing activation, so the close came after it
		const order = events.map((e) =>
			e.type === 'activation_end' ? `end:${e.agent}` : e.type === 'exchange_closed' ? 'closed' : '',
		);
		expect(order.indexOf('closed')).toBeGreaterThan(order.indexOf('end:assistant'));
	});

	it('is skipped for a question that lands while the assistant drafts', async () => {
		const held = deferred();
		const composing: number[] = [];
		const session = open({
			script: byAgent({
				assistant: async (context, _name, call) => {
					if (holding(context, 'seat')) {
						composing.push(call);
						return quiet();
					}
					if (holding(context, 'summarise')) {
						await held.promise;
						return summarise('one message');
					}
					return quiet();
				},
				product: (_context, _name, call) => (call <= 2 ? speak(`answer ${call}`) : quiet()),
			}),
			agents: [product],
			available: [surveyor],
		});

		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'First question?' });
		await session.settled();
		await tick();
		// the assistant is drafting priya's summary: a second question composes nothing
		expect(composing).toHaveLength(1);
		await visit.deliver({ text: 'Second question?' });
		await session.settled();
		expect(composing).toHaveLength(1);
		held.resolve();
		await session.quiet();
		// the next question, into a free assistant, composes again
		await visit.deliver({ text: 'Third question?' });
		await session.quiet();
		expect(composing).toHaveLength(2);
	});

	it('is not steered: what the seats say while the assistant decides never reaches it', async () => {
		const held = deferred();
		const contexts: string[] = [];
		const session = open({
			script: byAgent({
				assistant: async (context, _name, call) => {
					if (!holding(context, 'seat')) return quiet();
					contexts.push(contextText(context));
					if (call === 1) {
						await held.promise;
						return seat('surveyor');
					}
					return quiet();
				},
				product: (_context, _name, call) =>
					call === 1 ? speak('An answer, before the decision.') : quiet(),
			}),
			agents: [product],
			available: [surveyor],
		});

		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'How much steel is on site?' });
		// the product has answered; the assistant is still deciding
		await new Promise<void>((resolve) => {
			const off = session.subscribe((event) => {
				if (event.type !== 'activation_end' || event.agent !== 'product') return;
				off();
				resolve();
			});
		});
		held.resolve();
		await session.quiet();

		expect(contexts).toHaveLength(2);
		expect(contexts[1]).not.toContain('[new]');
		expect(contexts[1]).not.toContain('An answer, before the decision.');
		expect(kinds(await session.messages())).toContain('seated');
	});

	it('refuses a name outside the reserve, and ends the activation once the reserve is empty', async () => {
		const results: string[] = [];
		const seatings = ['nobody', 'surveyor', 'architect', 'greeter', 'surveyor'];
		const session = open({
			script: byAgent({
				assistant: (context, _name, call) => {
					if (!holding(context, 'seat')) return quiet();
					results.push(...lastToolResult(context));
					const next = seatings[call - 1];
					return next ? seat(next) : quiet();
				},
			}),
			available: [surveyor, architect, greeter],
		});
		const ended = assistantEnded(session);

		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'Everybody in.' });
		await ended;
		await session.quiet();

		expect(results[0]).toContain(
			"'nobody' is not in the reserve. Seat one of: surveyor, architect, greeter.",
		);
		expect(results.slice(1, 4)).toEqual(['delivered', 'delivered', 'delivered']);
		// the fifth call found the reserve empty: the tool ended the activation itself
		expect(results).toHaveLength(4);
		expect(seatNames(session)).toEqual(['assistant', 'surveyor', 'architect', 'greeter']);
	});
});

describe('the host', () => {
	it('seats and unseats by hand, and the record says so', async () => {
		const session = open({
			script: byAgent({
				surveyor: (_context, _name, call) => (call === 1 ? speak('11.7 tonnes.') : quiet()),
			}),
			agents: [product],
			available: [surveyor],
		});
		const events = collect(session);

		await session.seat(surveyor);
		await session.quiet();
		expect(seatNames(session)).toEqual(['product', 'assistant', 'surveyor']);
		// the seating woke the seat it named, with nobody's name in `by`; what
		// the surveyor then said woke the product, as any say does
		expect(activated(events)[0]).toBe('surveyor');
		const seating = presence(await session.messages()).find((m) => m.kind === 'seated');
		expect(seating).toMatchObject({ from: 'surveyor', identity: surveyor.identity });
		expect(seating?.by).toBeUndefined();

		await session.unseat(surveyor);
		expect(seatNames(session)).toEqual(['product', 'assistant']);
		expect(kinds(await session.messages())).toEqual(['seated', 'said', 'unseated']);

		await expect(session.unseat(assistant)).rejects.toThrow(/is the assistant/);
		await expect(session.unseat(surveyor)).rejects.toThrow(/is not seated/);
	});

	it('returns an unseated agent to the reserve, where the assistant finds it again', async () => {
		const reserves: string[] = [];
		const session = open({
			script: byAgent({
				assistant: (context) => {
					if (holding(context, 'seat')) reserves.push(contextText(context));
					return quiet();
				},
			}),
			available: [surveyor],
		});

		await session.seat(surveyor);
		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'First?' });
		await session.quiet();
		// seated by the host, so the reserve the assistant read was empty of it
		expect(reserves).toHaveLength(0);

		await session.unseat(surveyor);
		await visit.deliver({ text: 'Second?' });
		await session.quiet();
		expect(reserves).toHaveLength(1);
		expect(reserves[0]).toContain('- surveyor:');
	});

	it('aborts an activation in flight on unseat, and refuses a say directed at the departed', async () => {
		const held = deferred();
		const session = open({
			script: byAgent({
				product: async (_context, _name, call) => {
					if (call === 1) {
						await held.promise;
						return speak('Surveyor, what is the number?', 'surveyor');
					}
					return quiet();
				},
				surveyor: async () => {
					await new Promise(() => {});
					return quiet();
				},
			}),
			agents: [product, surveyor],
		});
		const events = collect(session);

		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'How much steel?' });
		await tick();
		expect(session.seats().find((s) => s.name === 'surveyor')).toMatchObject({ status: 'active' });

		await session.unseat(surveyor);
		expect(seatNames(session)).toEqual(['product', 'assistant']);
		held.resolve();
		await session.quiet();

		// the surveyor's activation was cut off, and the product's say at it was refused
		expect(events.some((e) => e.type === 'activation_end' && e.agent === 'surveyor')).toBe(true);
		const conflict = events.find((e) => e.type === 'conflict');
		expect(
			conflict?.type === 'conflict' && conflict.missed.some((m) => m.kind === 'unseated'),
		).toBe(true);
		expect((await session.messages()).some((m) => m.kind === 'said' && m.to === 'surveyor')).toBe(
			false,
		);
	});

	it('unseats what the run added at stop, and leaves the starting composition alone', async () => {
		const session = open({ script: byAgent({}), agents: [product], available: [surveyor] });
		await session.seat(surveyor);
		await session.quiet();

		await stopSession(session);
		started.pop();

		const { readSession } = await import('../src/index.ts');
		const record = await readSession(session.name).messages();
		expect(kinds(record)).toEqual(['seated', 'unseated']);
		expect(record.at(-1)).toMatchObject({ kind: 'unseated', from: 'surveyor' });
	});
});

describe('a failed draft', () => {
	it('waits for the seats to stop again, and a question that woke nobody is not that', async () => {
		const session = open({
			script: byAgent({
				assistant: (context) => {
					if (!holding(context, 'summarise')) return quiet();
					return fauxAssistantMessage('', {
						stopReason: 'error',
						errorMessage: 'the model failed',
					});
				},
				product: (_context, _name, call) => (call <= 4 ? speak(`answer ${call}`) : quiet()),
			}),
			agents: [passive(product)],
		});
		const events = collect(session);
		const assistantActs = () => activated(events).filter((n) => n === 'assistant').length;

		const visit = await visitSession(session, priya);
		// two answers, a close, and a draft that fails: priya is owed, and waiting
		await visit.deliver({ to: product, text: 'First?' });
		await session.quiet();
		expect(assistantActs()).toBe(1);

		// a question that wakes nobody settles the room, and that is not the seats stopping again
		await visit.deliver({ text: 'Anyone?' });
		await session.quiet();
		expect(assistantActs()).toBe(1);

		// the seats work and stop: now the draft is due again
		await visit.deliver({ to: product, text: 'Third?' });
		await session.quiet();
		expect(assistantActs()).toBe(2);
	});
});

describe('the threshold', () => {
	it('counts an agent that spoke and was unseated before the close', async () => {
		const held = deferred();
		const session = open({
			script: byAgent({
				assistant: composes([], 'Both answered.'),
				product: async (_context, _name, call) => {
					if (call === 1) await held.promise;
					// the departure landed while it read, so its first say is refused and it speaks again
					return call <= 2 ? speak('The pour is Saturday.') : quiet();
				},
				surveyor: (_context, _name, call) => (call === 1 ? speak('11.7 tonnes.') : quiet()),
			}),
			agents: [product, surveyor],
			available: [architect],
		});

		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'Enough steel for the pour?' });
		// the surveyor answers and stops; the product is still reading
		await new Promise<void>((resolve) => {
			const off = session.subscribe((event) => {
				if (event.type !== 'activation_end' || event.agent !== 'surveyor') return;
				off();
				resolve();
			});
		});
		await session.unseat(surveyor);
		held.resolve();
		await session.quiet();

		const record = await session.messages();
		// two agent answers, one of them from a seat no longer in the room: still one message
		expect(record.filter((m) => m.kind === 'said').map((m) => m.from)).toEqual([
			'priya',
			'surveyor',
			'product',
		]);
		expect(record.at(-1)).toMatchObject({ kind: 'summary', to: 'priya' });
	});
});
