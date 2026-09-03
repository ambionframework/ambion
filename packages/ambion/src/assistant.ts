/**
 * The assistant: the room's counterpart to the people in it. It reads how each
 * person reads, and when an exchange closes, it writes the one message the
 * person who opened it reads.
 *
 * **The assistant is a seat.** `startSession` seats it with the agents, the
 * room activates it the way it activates every other agent, its turns land in
 * its own downstream session, and the record's lock refuses it exactly as it
 * refuses a say. Two things make it the seat it is, and both are data rather
 * than machinery:
 *
 * - It is seated at the narrow end of attention, `none`, so nothing said in
 *   the room wakes it.
 * - A closed exchange wakes it, for the person who owns that exchange. That
 *   activation holds one tool, `summarise`, bound to the range it must stand
 *   for.
 *
 * What is left in this file is what the assistant *is*: what a room refuses
 * to seat as one, the range a summary stands for, the tool that commits one,
 * and how each person reads. The activation itself is the room's, in
 * `session.ts`, and it is the same one every seat takes.
 */
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { refusal } from './render.ts';
import { delivered, isActive, type SeatRuntime } from './seat.ts';
import type { AgentDefinition, Message, Seq, SummaryMessage } from './types.ts';
import { isAgent, isSpoken } from './types.ts';

/** One draft, and one redraft after a race. Then the room keeps moving without it. */
const ASSISTANT_DRAFTS = 2;

/**
 * How often the assistant may call its tool in one activation. A model that keeps
 * calling a tool that keeps refusing would run for ever, and nothing else here
 * bounds an activation — the same gap `agent.md` §7 records for the room, closed where it
 * can be closed.
 */
const ASSISTANT_CALLS = 4;

/**
 * The assistant shapes what a room already does, and never makes anything
 * happen. It carries no tools of its own, so the rule is a fact about the
 * definition rather than a promise about behaviour: the one hand the runtime
 * gives it writes to the record and reaches nothing else. `startSession`
 * refuses anything else as the room's assistant.
 */
export function assertAssistant(assistant: unknown): AgentDefinition {
	if (!isAgent(assistant)) {
		throw new Error('The assistant must come from defineAgent.');
	}
	if (assistant.tools.length > 0) {
		throw new Error(
			`Assistant '${assistant.name}' holds tools: the assistant shapes what a room does and never acts in it.`,
		);
	}
	// A workspace binds tools the assistant never holds: `handsFor` returns
	// before it reaches them, so the field would be live in the definition and
	// inert at runtime. Refusing it here catches that where it is written.
	if (assistant.workspace !== undefined) {
		throw new Error(
			`Assistant '${assistant.name}' names a workspace: the assistant shapes what a room does and never acts in it.`,
		);
	}
	return assistant;
}

/**
 * One summarising activation's own state. The range is read off the record when the
 * activation starts, and it widens when a race refuses the draft, so the retry
 * stands for what won. Nothing here outlives the activation.
 */
export interface Draft {
	/** The person whose question opened the exchange, and who reads the message. */
	person: string;
	/** The question that opened the exchange. */
	from: Seq;
	/** The last seq it stands for. A refusal moves it. */
	through: Seq;
	refusals: number;
	calls: number;
}

/**
 * What a summary would stand for, or nothing when one message already serves:
 * one answer is left as it was given, in the voice that gave it, and an
 * exchange the agents said nothing into writes nothing at all.
 *
 * It counts what the room produced, not what people said into it, and it
 * counts messages rather than speakers — one product saying four things needs
 * consolidating as much as three products saying one each.
 */
function draftOver(
	record: readonly Message[],
	person: string,
	from: Seq,
	through: Seq,
	fromSeat: (name: string) => boolean,
): Draft | undefined {
	const said = record.filter(
		(m) => m.seq >= from && m.seq <= through && isSpoken(m) && fromSeat(m.from),
	);
	if (said.length < 2) return undefined;
	return { person, from, through, refusals: 0, calls: 0 };
}

/** What the summarise tool needs of the room: the record's lock, and little else. */
export interface SummaryRoom {
	/** Whether the room is closing: a draft that finishes after it commits nothing. */
	stopped(): boolean;
	/** The last seq the record holds. */
	lastSeq(): Seq;
	/** Rule 5: the same lock a say commits under. */
	claim(
		author: { name: string; readThrough: Seq },
		draft: Omit<SummaryMessage, 'seq'>,
	): { message: SummaryMessage } | { missed: Message[] };
	publish(message: Message): Promise<void>;
	/** The draft reached the record: this seat spoke, in the one way the assistant can. */
	written(): void;
}

/**
 * The assistant's one hand, and it reaches the record and nothing else. It commits
 * under the same lock a say commits under, so a summary drafted against a
 * record that has moved is refused — and the refusal reaches the assistant inside
 * its own activation, carrying what it missed, so the redraft happens now rather
 * than at the next quiescence.
 *
 * `startSession` refuses an assistant that carries tools of its own, so §12's rule —
 * never call a tool that changes a product's state — stays a fact about the
 * definition rather than a promise about behaviour.
 */
export function summariseTool(assistant: string, draft: Draft, room: SummaryRoom): AgentTool {
	const person = draft.person;
	return {
		name: 'summarise',
		label: 'summarise',
		description:
			`Write the one message ${person} reads for this exchange. Call it once. ` +
			'Ending your turn without calling it leaves the range whole, for whoever reads it.',
		parameters: Type.Object({ text: Type.String() }),
		execute: async (_toolCallId, rawParams) => {
			draft.calls += 1;
			const stop = standDown(draft, room.stopped());
			if (stop) return stop;
			const text = (rawParams as { text: string }).text.trim();
			if (text === '') {
				throw new Error(`The message is empty. Write what ${person} reads, or end your turn.`);
			}
			const claimed = room.claim(
				{ name: assistant, readThrough: draft.through },
				{
					kind: 'summary',
					at: new Date().toISOString(),
					from: assistant,
					to: person,
					text,
					covers: { from: draft.from, through: draft.through },
				},
			);
			if ('missed' in claimed) throw widen(draft, claimed.missed, room.lastSeq());
			room.written();
			await room.publish(claimed.message);
			return delivered();
		},
	};
}

/**
 * Why this activation cannot come good, when it cannot. Telling a model to stop is
 * not enough — one that keeps calling the tool would draft for ever — so the
 * result ends the activation itself. `terminate` is Pi's own way for a tool to say
 * that the loop is over, and the reason still reaches the transcript, where
 * rule 8 keeps it.
 */
function standDown(
	draft: Draft,
	stopped: boolean,
): AgentToolResult<Record<string, never>> | undefined {
	const why = stoppingReason(draft, stopped);
	if (why === undefined) return undefined;
	return {
		content: [{ type: 'text', text: `${why} This turn is over.` }],
		details: {},
		terminate: true,
	};
}

function stoppingReason(draft: Draft, stopped: boolean): string | undefined {
	if (stopped) return 'The room is closing.';
	if (draft.refusals >= ASSISTANT_DRAFTS) {
		return 'The room is still moving. The range stays whole, and you write it when the room is quiet again.';
	}
	if (draft.calls > ASSISTANT_CALLS) return 'You have tried this enough times.';
	return undefined;
}

/**
 * A refused draft widens the range it covers. The messages that won the race
 * are now inside it, so the redraft stands for them too and the summary stays
 * contiguous with what it covers.
 */
function widen(draft: Draft, missed: Message[], lastSeq: Seq): Error {
	draft.through = lastSeq;
	draft.refusals += 1;
	return new Error(
		refusal(
			'Not written — the room moved while you were drafting. It is now yours to cover too:',
			missed,
			`Write ${draft.person}'s message again, over the range as it now stands.`,
		),
	);
}

/**
 * The assistant in one room: how each person reads, who is owed a message,
 * and the one it is drafting now.
 *
 * A seat knows nothing about any of this. The assistant is a seat like every
 * other, and what makes it the assistant is held here — so the room asks *the
 * assistant* whether a name is it, rather than every seat carrying the answer.
 */
export class Assistant {
	/** How each person who visited this run reads. Run state: a restart begins empty. */
	private readonly preferences = new Map<string, string | undefined>();
	/**
	 * People owed a message, and the seq their range starts at. A race or a
	 * failed activation leaves one owed; the next quiet room writes it.
	 */
	private readonly owed = new Map<string, Seq>();
	/**
	 * People whose draft the last activation could not land. They wait for the
	 * seats to stop again: a draft that retried on its own end would retry for
	 * ever against a model that keeps failing.
	 */
	private readonly waiting = new Set<string>();
	/** The range the assistant is closing, while its activation runs. */
	private draft: Draft | undefined;

	/** One seat, seated at `none` when the room starts, for the life of the run. */
	constructor(readonly seat: SeatRuntime) {}

	/** Whether this name is the assistant. It answers about the assistant and nothing else. */
	is(name: string): boolean {
		return name === this.seat.def.name;
	}

	/** A person is in the room: how they read, as their latest visit says it. */
	serve(person: string, preferences: string | undefined): void {
		this.preferences.set(person, preferences);
	}

	preferencesOf(person: string): string | undefined {
		return this.preferences.get(person);
	}

	/** What the assistant is closing, while it is closing it. */
	closing(): Draft | undefined {
		return this.draft;
	}

	/**
	 * One person may be owed one message. A second exchange that closes while
	 * the first is still owed widens the range back to the earlier question,
	 * because that is what its person has not read.
	 */
	owe(person: string, from: Seq): void {
		const already = this.owed.get(person);
		this.owed.set(person, already === undefined ? from : Math.min(already, from));
	}

	/**
	 * The seats stopped, so every owed message is due, including one a failed
	 * draft left waiting: this quiet room is its next chance.
	 */
	dueAtQuiescence(
		record: readonly Message[],
		through: Seq,
		fromSeat: (name: string) => boolean,
	): Draft | undefined {
		this.waiting.clear();
		return this.pick(record, through, fromSeat);
	}

	/**
	 * A draft is over, and the seat is free. Somebody owed a message while it
	 * was drafting for somebody else is due now; the person it just failed
	 * stays waiting for the seats to stop again.
	 */
	dueAfterDraft(
		record: readonly Message[],
		through: Seq,
		fromSeat: (name: string) => boolean,
	): Draft | undefined {
		return this.pick(record, through, fromSeat);
	}

	/**
	 * The next activation to take: the range the assistant would stand for, or
	 * nothing where one message already serves. A seat holds one activation,
	 * so a person whose close finds the assistant drafting stays owed until it
	 * is free.
	 */
	private pick(
		record: readonly Message[],
		through: Seq,
		fromSeat: (name: string) => boolean,
	): Draft | undefined {
		if (isActive(this.seat)) return undefined;
		for (const [person, from] of [...this.owed]) {
			if (this.waiting.has(person)) continue;
			this.owed.delete(person);
			const draft = draftOver(record, person, from, through, fromSeat);
			if (!draft) continue;
			this.draft = draft;
			return draft;
		}
		return undefined;
	}

	/**
	 * A summarising activation is over. It wrote, or it judged that one message
	 * already served; a race or a failure leaves the range owed, and the next
	 * quiet room is another chance.
	 */
	activationEnded(outcome: { wrote: boolean; failed: boolean }): void {
		const draft = this.draft;
		this.draft = undefined;
		if (draft === undefined || outcome.wrote) return;
		// A race, or an activation that never reached the record, leaves it owed.
		// An assistant that stood down judged the room, and is owed nothing for it.
		if (draft.refusals > 0 || outcome.failed) {
			this.owe(draft.person, draft.from);
			this.waiting.add(draft.person);
		}
	}
}
