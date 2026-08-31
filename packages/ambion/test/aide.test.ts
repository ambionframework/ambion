import type { SessionRepo, StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
} from '@earendil-works/pi-ai';
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

// -- scripted model ----------------------------------------------------------

type Script = (
	context: Context,
	name: string,
	call: number,
) => AssistantMessage | Promise<AssistantMessage>;

/** A deterministic streamFn, routed on the name in the prompt. An aide is named there too. */
function scripted(script: Script): StreamFn {
	const calls = new Map<string, number>();
	return (_model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const name = /You are '([a-z0-9-]+)'/.exec(context.systemPrompt ?? '')?.[1] ?? 'unknown';
		const call = (calls.get(name) ?? 0) + 1;
		calls.set(name, call);
		let finished = false;
		const finish = (message: AssistantMessage) => {
			if (finished) return;
			finished = true;
			if (message.stopReason === 'error' || message.stopReason === 'aborted') {
				stream.push({ type: 'error', reason: message.stopReason, error: message });
				return;
			}
			stream.push({ type: 'start', partial: message });
			stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
		};
		// A stream that ignores the signal keeps answering a cancelled turn for ever.
		const aborted = () =>
			finish(fauxAssistantMessage('', { stopReason: 'aborted', errorMessage: 'aborted' }));
		if (options?.signal?.aborted) {
			queueMicrotask(aborted);
			return stream;
		}
		options?.signal?.addEventListener('abort', aborted, { once: true });
		void Promise.resolve(script(context, name, call))
			.catch((error: unknown) =>
				fauxAssistantMessage('', { stopReason: 'error', errorMessage: String(error) }),
			)
			.then(finish);
		return stream;
	};
}

/** One entry per participant with lines. Everybody else reads and stays quiet. */
const byName = (lines: Record<string, Script>): Script => {
	const table = new Map(Object.entries(lines));
	return (context, name, call) => (table.get(name) ?? (() => quiet()))(context, name, call);
};

const speak = (text: string) =>
	fauxAssistantMessage([fauxToolCall('say', { text })], { stopReason: 'toolUse' });

const quiet = (thought = 'nothing to add') => fauxAssistantMessage(thought, { stopReason: 'stop' });

/** An aide writes by calling its own tool. It has no say, because it says nothing. */
const summarise = (text: string) =>
	fauxAssistantMessage([fauxToolCall('summarise', { text })], { stopReason: 'toolUse' });

/** The ordinary aide: it writes once, then ends its turn. */
const writes =
	(text: string): Script =>
	(_context, _name, call) =>
		call === 1 ? summarise(text) : quiet();

/** A turn that fails outright: no draft, nothing written, and an error on the stream. */
const broken: Script = () =>
	fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'the model failed' });

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function contextText(context: Context): string {
	return context.messages
		.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
		.join('\n');
}

// -- the room ----------------------------------------------------------------

let unique = 0;
const roomName = () => `aide-${++unique}`;

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

const priya = defineHuman({
	name: 'priya',
	identity: 'Project manager. Owns the programme.',
	aide: defineAgent({
		name: 'priya-aide',
		identity: "Holds Priya's brief.",
		instructions: 'Lead with the decision she has to make. Leave out who said what.',
		model: 'scripted/aide',
	}),
});

const sam = defineHuman({
	name: 'sam',
	identity: 'Site foreman.',
	aide: defineAgent({
		name: 'sam-aide',
		identity: "Holds Sam's brief.",
		instructions: 'Lead with what he has to do tomorrow.',
		model: 'scripted/aide',
	}),
});

/** The same person, with nobody to write for her. */
const alone = defineHuman({ name: 'priya', identity: 'Project manager. Owns the programme.' });

const started: Session[] = [];

function open(options: {
	script: Script;
	agents?: Parameters<typeof startSession>[0]['agents'];
	repo?: SessionRepo;
}): Session {
	const session = startSession({
		name: roomName(),
		goal: 'Decide the pour date and keep the plan honest.',
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

const collect = (session: Session) => {
	const seen: SessionEvent[] = [];
	session.subscribe((event) => seen.push(event));
	return seen;
};

/** An aide writes after the room is quiet, so a test waits for what it wrote. */
function nextSummary(session: Session): Promise<SummaryMessage> {
	return new Promise((resolve) => {
		const off = session.subscribe((event) => {
			if (event.type !== 'message' || event.message.kind !== 'summary') return;
			off();
			resolve(event.message);
		});
	});
}

/**
 * The named aide's turn is over, whatever it decided. A summary commits inside
 * the tool call, so the turn runs on for a moment after the message lands.
 */
function aideEnded(session: Session, aide = 'priya-aide'): Promise<void> {
	return new Promise((resolve) => {
		const off = session.subscribe((event) => {
			if (event.type !== 'agent_end' || event.agent !== aide) return;
			off();
			resolve();
		});
	});
}

/** Quiet, and long enough for an aide that was going to write to have written. */
async function quiescent(session: Session): Promise<void> {
	await session.settled();
	for (let waited = 0; waited < 6; waited += 1) await tick();
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

describe('the aide', () => {
	it('writes one message for an exchange the room answered more than once', async () => {
		const contexts: string[] = [];
		const hands: string[] = [];
		const session = open({
			script: byName({
				product: twoAnswers,
				'priya-aide': (context, _name, call) => {
					contexts.push(contextText(context));
					hands.push((context.tools ?? []).map((tool) => tool.name).join(','));
					return call === 1
						? summarise('Thursday is out. Saturday holds if the rebar lands Wednesday.')
						: quiet();
				},
			}),
		});
		const written = nextSummary(session);
		const ended = aideEnded(session);

		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'Can I tell the client Thursday for the pour?' });
		const summary = await written;
		await ended;

		expect(summary.from).toBe('priya-aide');
		expect(summary.to).toBe('priya');
		expect(summary.text).toContain('Saturday');
		// contiguous: it lands immediately after the range it stands for
		expect(summary.covers.through).toBe(summary.seq - 1);

		const record = await session.messages();
		expect(summary.covers.from).toBe(record.find((m) => isSpoken(m))?.seq);
		expect(record.map((m) => m.kind)).toEqual(['arrived', 'said', 'said', 'said', 'summary']);

		// what an aide is handed: the range it covers, and one hand that reaches the record
		expect(hands).toEqual(['summarise', 'summarise']);
		expect(contexts[0]).toContain('Can I tell the client Thursday');
		expect(contexts[0]).toContain('the inspector needs 48h notice');
	});

	it('leaves one answer as it was given, in the voice that gave it', async () => {
		const session = open({
			script: byName({ product: oneAnswer, 'priya-aide': writes('nobody asked for this') }),
		});

		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'Can I tell the client Thursday?' });
		await quiescent(session);

		expect(summaries(await session.messages())).toHaveLength(0);
	});

	it('writes nothing for a person who brought no aide', async () => {
		const prompts: string[] = [];
		const session = open({
			script: byName({
				product: (context, name, call) => {
					prompts.push(context.systemPrompt ?? '');
					return twoAnswers(context, name, call);
				},
			}),
		});

		const visit = await visitSession(session, alone);
		await visit.deliver({ text: 'Can I tell the client Thursday?' });
		await quiescent(session);

		expect(said(await session.messages())).toHaveLength(3);
		expect(summaries(await session.messages())).toHaveLength(0);
		// a room where nobody brought one reads exactly as it read before
		expect(prompts[0]).not.toContain('summarised below');
	});

	it('wakes nobody, and every seat reads it at the next activation', async () => {
		const contexts: string[] = [];
		const prompts: string[] = [];
		const session = open({
			script: byName({
				product: (context, name, call) => {
					contexts.push(contextText(context));
					prompts.push(context.systemPrompt ?? '');
					if (call > 3) return quiet();
					return twoAnswers(context, name, call);
				},
				'priya-aide': writes('Thursday is out; Saturday holds.'),
			}),
		});
		const events = collect(session);
		const written = nextSummary(session);

		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'Can I tell the client Thursday?' });
		const summary = await written;
		await quiescent(session);

		// nothing an aide writes activates a seat
		const landed = events.findIndex((e) => e.type === 'message' && e.message === summary);
		expect(events.slice(landed).filter((e) => e.type === 'agent_start')).toHaveLength(0);

		await visit.deliver({ text: 'And the pump?' });
		await quiescent(session);

		// the range left the seat's context, and the summary stands for it
		const read = contexts.at(-1) ?? '';
		expect(read).toContain('── 3 messages, summarised below ──');
		expect(read).toContain('[priya-aide → priya] Thursday is out; Saturday holds.');
		expect(read).not.toContain('the inspector needs 48h notice');
		expect(read).toContain('brings priya-aide');
		// a room where somebody brought one tells its seats how to read a fold
		expect(prompts[0]).toContain('summarised below');
		// the record keeps every message, and nothing was rewritten
		expect(said(await session.messages())).toContain(
			'Thursday is out: the inspector needs 48h notice.',
		);
	});

	it('owns the question that lands while a seat works on what nobody asked for', async () => {
		const greeting = deferred();
		const session = open({
			agents: [product, attentive(greeter)],
			script: byName({
				product: twoAnswers,
				greeter: async (_context, _name, call) => {
					if (call === 1) await greeting.promise;
					return quiet();
				},
				'priya-aide': writes('Thursday is out; Saturday holds.'),
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

	it('refuses a draft the room moved past, and redrafts inside the same turn', async () => {
		const held = deferred();
		const refusals: string[] = [];
		const session = open({
			script: byName({
				product: answersEach,
				'priya-aide': async (context, _name, call) => {
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
		// the aide has read its range and is drafting against it
		await tick();

		const written = nextSummary(session);
		await visit.deliver({ text: 'And the pump?' });
		await session.settled();
		held.resolve();
		const summary = await written;
		await quiescent(session);

		const conflicts = events.filter((e) => e.type === 'conflict');
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0]).toMatchObject({ author: 'priya-aide' });
		// the refusal reached the aide as a tool result, carrying what it missed
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
			script: byName({
				product: answersEach,
				// an aide that never gives up: what stops it is the runtime, not the script
				// an aide that never gives up: what stops it is the runtime, not the script
				'priya-aide': async (context, _name, call) => {
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

		// two arrivals move the record under the aide, and wake nobody
		const his = await visitSession(session, sam);
		first.resolve();
		await tick();
		await his.leave();
		second.resolve();
		const stoodDown = aideEnded(session);
		await stoodDown;

		expect(events.filter((e) => e.type === 'conflict')).toHaveLength(2);
		expect(summaries(await session.messages())).toHaveLength(0);
		// the turn ended after the second refusal rather than drafting for ever
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
			script: byName({
				product: twoAnswers,
				'priya-aide': (_context, name) => {
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
		expect(events.filter((e) => e.type === 'agent_end' && e.agent === 'priya-aide')).toMatchObject([
			{ spoke: false },
		]);
	});

	it('drafts again at the next quiescence when its turn fails outright', async () => {
		const session = open({
			agents: [product, attentive(greeter)],
			script: byName({
				product: twoAnswers,
				'priya-aide': (context, name, call) => {
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

		// a failed turn leaves the summary owed, and the next quiet room writes it
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
			script: byName({
				product: heldUntil(working.promise),
				'priya-aide': writes("Priya's message."),
				'sam-aide': writes("Sam's message."),
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

	it('outlives its person’s visit by one exchange', async () => {
		const working = deferred();
		const session = open({
			script: byName({
				product: heldUntil(working.promise),
				'priya-aide': writes('The answer, waiting for her.'),
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
	});

	it("keeps an aide's turns in a downstream Pi session named for its person", async () => {
		const repo = new InMemorySessionRepo();
		const session = open({
			repo,
			script: byName({ product: twoAnswers, 'priya-aide': writes('The one message.') }),
		});
		const written = nextSummary(session);
		const ended = aideEnded(session);

		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'Can I tell the client Thursday?' });
		await written;
		await ended;

		const metadata = (await repo.list()).find((m) => m.id === `${session.name}:priya`);
		expect(metadata).toBeDefined();
		const piSeat = metadata && (await repo.open(metadata));
		const entries = (await piSeat?.findEntries()) ?? [];
		expect(entries.some((e) => e.type === 'custom' && e.customType === 'ambion/activation')).toBe(
			true,
		);
	});

	it('refuses an aide whose name the room already holds', async () => {
		const clash = defineHuman({
			name: 'mara',
			identity: 'Design lead.',
			aide: defineAgent({
				name: 'product',
				identity: 'Holds her brief.',
				instructions: 'summarise',
				model: 'scripted/aide',
			}),
		});
		const session = open({ script: byName({}) });

		await expect(visitSession(session, clash)).rejects.toThrow(/one name names one participant/);
	});

	it('names the aide on the seat a host reads', async () => {
		const session = open({ script: byName({}) });
		await visitSession(session, priya);
		await session.settled();

		const seat = session.seats().find((s) => s.name === 'priya');
		expect(seat?.kind === 'human' && seat.aide).toBe('priya-aide');
	});
});

describe('defineHuman', () => {
	it('refuses an aide with hands', () => {
		const book = defineTool({
			name: 'book_inspector',
			description: 'Book the inspector.',
			parameters: Type.Object({}),
			execute: () => 'booked',
		});
		expect(() =>
			defineHuman({
				name: 'priya',
				identity: 'Project manager.',
				aide: defineAgent({
					name: 'priya-aide',
					identity: 'Holds her brief.',
					instructions: 'summarise',
					model: 'scripted/aide',
					tools: [book],
				}),
			}),
		).toThrow(/never acts in it/);
	});

	it('refuses an aide that takes its person’s name', () => {
		expect(() =>
			defineHuman({
				name: 'priya',
				identity: 'Project manager.',
				aide: defineAgent({
					name: 'priya',
					identity: 'Holds her brief.',
					instructions: 'summarise',
					model: 'scripted/aide',
				}),
			}),
		).toThrow(/name of its own/);
	});
});
