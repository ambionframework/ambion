/**
 * The assistant: the room's counterpart to the people in it. It reads how each
 * person reads, and when an exchange closes, it writes the one message the
 * person who opened it reads.
 *
 * **The assistant is a seat.** `startSession` seats it with the agents, the
 * room activates it the way it activates every other agent, its turns land in
 * its own downstream session, and the record's queue refuses it exactly as it
 * refuses a say. Two things make it the seat it is, and both are data rather
 * than machinery:
 *
 * - It is seated at the narrow end of attention, `none`, so nothing said in
 *   the room wakes it.
 * - A close wakes it, for the person who owns the closed exchange. That
 *   activation holds one tool, `summarise`, bound to the range it must stand
 *   for.
 * - An opened exchange wakes it too, when the room holds agents in reserve.
 *   That activation holds one tool, `seat`, bound to the reserve. The
 *   assistant bookends the exchange: it composes the room at the open and
 *   consolidates what the room said at the close.
 *
 * What is left in this file is what the assistant *is*: what a room refuses
 * to seat as one, the threshold a summary is written above, and what the
 * room holds of the assistant while it runs: who is owed, and the one draft
 * or composition in flight. How each person reads is on the record, with
 * their arrival. The two tools are hands the seat side gives it
 * (`seat/hands.ts`).
 */
import type { AgentDefinition, Message, Seq } from '../types.ts';
import { isAgent, isSpoken } from '../types.ts';

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
	// A workspace binds tools the assistant never holds: the hands it is given
	// never reach them, so the field would be live in the definition and
	// inert at runtime. Refusing it here catches that where it is written.
	if (assistant.workspace !== undefined) {
		throw new Error(
			`Assistant '${assistant.name}' names a workspace: the assistant shapes what a room does and never acts in it.`,
		);
	}
	return assistant;
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
	from: Seq,
	through: Seq,
	fromSeat: (name: string) => boolean,
): { from: Seq; through: Seq } | undefined {
	const said = record.filter(
		(m) => m.seq >= from && m.seq <= through && isSpoken(m) && fromSeat(m.from),
	);
	return said.length < 2 ? undefined : { from, through };
}

/** The range a summarising activation stands for, as the room picked it. */
export interface Draft {
	/** The person whose question opened the exchange, and who reads the message. */
	person: string;
	/** The question that opened the exchange. */
	from: Seq;
	/** The last seq it stands for, when the room picked it. */
	through: Seq;
}

/** Whose question a composing activation reads, and how many it may seat. */
export interface Composing {
	/** The person whose question opened the exchange. */
	person: string;
	/** The seq of that question. */
	from: Seq;
	/** How many the reserve held at the open: the most this activation can seat. */
	limit: number;
}

/**
 * The assistant in one room: who is owed a message, and the one it is
 * drafting now.
 *
 * A seat knows nothing about any of this. The assistant is a seat like every
 * other, and what makes it the assistant is held here — so the room asks *the
 * assistant* whether a name is it, rather than every seat carrying the answer.
 */
export class Assistant {
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
	/** The exchange the assistant is composing the room for, while its activation runs. */
	private composition: Composing | undefined;

	/** One seat, seated at `none` when the room starts, for the life of the run. */
	constructor(readonly name: string) {}

	/**
	 * A question opened an exchange, and the room holds agents in reserve. One
	 * seat, one activation: a question that lands while the assistant is live
	 * gets no composing activation, and the roster stands for that exchange.
	 */
	compose(person: string, from: Seq, limit: number, live: boolean): Composing | undefined {
		if (live) return undefined;
		this.composition = { person, from, limit };
		return this.composition;
	}

	/** What the assistant is composing for, while it is composing. */
	composing(): Composing | undefined {
		return this.composition;
	}

	/** Whether this name is the assistant. It answers about the assistant and nothing else. */
	is(name: string): boolean {
		return name === this.name;
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
		live: boolean,
	): Draft | undefined {
		this.waiting.clear();
		return this.pick(record, through, fromSeat, live);
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
		live: boolean,
	): Draft | undefined {
		return this.pick(record, through, fromSeat, live);
	}

	/**
	 * The next activation to take: the range the assistant would stand for, or
	 * nothing where one message already serves. A seat holds one activation,
	 * so a person whose close finds the assistant live stays owed until it
	 * is free.
	 */
	private pick(
		record: readonly Message[],
		through: Seq,
		fromSeat: (name: string) => boolean,
		live: boolean,
	): Draft | undefined {
		if (live) return undefined;
		for (const [person, from] of [...this.owed]) {
			if (this.waiting.has(person)) continue;
			this.owed.delete(person);
			const range = draftOver(record, from, through, fromSeat);
			if (!range) continue;
			this.draft = { person, ...range };
			return this.draft;
		}
		return undefined;
	}

	/**
	 * A summarising activation is over. It wrote, or it judged that one message
	 * already served; a race or a failure leaves the range owed, and the next
	 * quiet room is another chance. `failed` says the activation never reached
	 * the record, or the record kept moving past its drafts.
	 */
	activationEnded(outcome: { wrote: boolean; failed: boolean }): void {
		// A composing activation owes nothing afterwards: the roster stands as it
		// decided, and the next question composes again.
		this.composition = undefined;
		const draft = this.draft;
		this.draft = undefined;
		if (draft === undefined || outcome.wrote) return;
		// A race, or an activation that never reached the record, leaves it owed.
		// An assistant that stood down judged the room, and is owed nothing for it.
		if (outcome.failed) {
			this.owe(draft.person, draft.from);
			this.waiting.add(draft.person);
		}
	}
}
