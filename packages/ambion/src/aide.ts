/**
 * The aide: a person's counterpart in a room. It holds their brief, and when
 * an exchange they opened closes, it writes the one message they read.
 *
 * **An aide is a seat.** It is seated when its person arrives, it takes turns
 * the way every other agent does, its turns land in its own downstream
 * session, and the record's lock refuses it exactly as it refuses a say. Two
 * things make it the seat it is, and both are data rather than machinery:
 *
 * - It is seated at the narrow end of attention, `none`, so nothing said in
 *   the room wakes it. Widening that and handing it a `say` is the whole cost
 *   of `aide.md` §12's rung 3, when somebody decides to build it.
 * - A closed exchange wakes it, and only its owner's. That turn holds one
 *   tool, `summarise`, bound to the range it must stand for.
 *
 * What is left in this file is what an aide *is*: the range a summary stands
 * for, the tool that commits one, and what a model is told the one message is
 * for. The turn itself is the room's, in `session.ts`, and it is the same turn
 * every seat takes.
 */
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import type { SeatRuntime } from './seat.ts';
import { delivered, refusal } from './turn.ts';
import type { Message, Seq, SummaryMessage } from './types.ts';
import { isSpoken } from './types.ts';

/** One draft, and one redraft after a race. Then the room keeps moving without it. */
const AIDE_DRAFTS = 2;

/**
 * How often an aide may call its tool in one turn. A model that keeps calling
 * a tool that keeps refusing would run for ever, and nothing else here bounds
 * a turn — the same gap `agent.md` §7 records for the room, closed where it
 * can be closed.
 */
const AIDE_CALLS = 4;

/**
 * One summarising turn's own state. The range is read off the record when the
 * turn starts, and it widens when a race refuses the draft, so the retry
 * stands for what won. Nothing here outlives the turn.
 */
export interface Draft {
	/** The question that opened the exchange. */
	from: Seq;
	/** The last seq it stands for. A refusal moves it. */
	through: Seq;
	refusals: number;
	calls: number;
	/** The turn ended without reaching the record, so the room still owes it. */
	failed: boolean;
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
): Draft | undefined {
	const said = record.filter(
		(m) => m.seq >= from && m.seq <= through && isSpoken(m) && fromSeat(m.from),
	);
	if (said.length < 2) return undefined;
	return { from, through, refusals: 0, calls: 0, failed: false };
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
	/** The draft reached the record: this seat spoke, in the one way an aide can. */
	written(): void;
}

/**
 * The aide's one hand, and it reaches the record and nothing else. It commits
 * under the same lock a say commits under, so a summary drafted against a
 * record that has moved is refused — and the refusal reaches the aide inside
 * its own turn, carrying what it missed, so the redraft happens now rather
 * than at the next quiescence.
 *
 * `defineHuman` refuses an aide that carries tools of its own, so §12's rule —
 * never call a tool that changes a product's state — stays a fact about the
 * definition rather than a promise about behaviour.
 */
export function summariseTool(
	aide: string,
	person: string,
	draft: Draft,
	room: SummaryRoom,
): AgentTool {
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
				{ name: aide, readThrough: draft.through },
				{
					kind: 'summary',
					at: new Date().toISOString(),
					from: aide,
					to: person,
					text,
					covers: { from: draft.from, through: draft.through },
				},
			);
			if ('missed' in claimed) throw widen(draft, person, claimed.missed, room.lastSeq());
			room.written();
			await room.publish(claimed.message);
			return delivered();
		},
	};
}

/**
 * Why this turn cannot come good, when it cannot. Telling a model to stop is
 * not enough — one that keeps calling the tool would draft for ever — so the
 * result ends the turn itself. `terminate` is Pi's own way for a tool to say
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
	if (draft.refusals >= AIDE_DRAFTS) {
		return 'The room is still moving. The range stays whole, and you write it when the room is quiet again.';
	}
	if (draft.calls > AIDE_CALLS) return 'You have tried this enough times.';
	return undefined;
}

/**
 * A refused draft widens the range it covers. The messages that won the race
 * are now inside it, so the redraft stands for them too and the summary stays
 * contiguous with what it covers.
 */
function widen(draft: Draft, person: string, missed: Message[], lastSeq: Seq): Error {
	draft.through = lastSeq;
	draft.refusals += 1;
	return new Error(
		refusal(
			'Not written — the room moved while you were drafting. It is now yours to cover too:',
			missed,
			`Write ${person}'s message again, over the range as it now stands.`,
		),
	);
}

/**
 * The aides in one room: who each writes for, which of them owes a message,
 * and which is drafting one now.
 *
 * A seat knows nothing about any of this. An aide is a seat like every other,
 * and what makes it an aide is held here — so the room asks *the aides* whether
 * a name writes for somebody, rather than every seat carrying the answer.
 */
export class Aides {
	/** The aide each person brought, keyed by the person. */
	private readonly byPerson = new Map<string, SeatRuntime>();
	/** The person each aide writes for, keyed by the aide's own name. */
	private readonly owners = new Map<string, string>();
	/**
	 * People owed a message, and the seq their range starts at. A race or a
	 * failed turn leaves one owed; the next quiet room writes it.
	 */
	private readonly owed = new Map<string, Seq>();
	/** The range each aide is closing, while its turn runs. */
	private readonly drafts = new Map<string, Draft>();

	/** Seat an aide for a person. One aide, one person, for the life of the run. */
	bring(seat: SeatRuntime, person: string): void {
		this.byPerson.set(person, seat);
		this.owners.set(seat.def.name, person);
	}

	has(person: string): boolean {
		return this.byPerson.has(person);
	}

	get size(): number {
		return this.byPerson.size;
	}

	/** The person this seat writes for, or nothing when it writes for nobody. */
	ownerOf(name: string): string | undefined {
		return this.owners.get(name);
	}

	/** Whether this name is somebody's aide. It answers about aides and nothing else. */
	isAide(name: string): boolean {
		return this.owners.has(name);
	}

	/** The aide a person brought, by that person's name. */
	forPerson(person: string): SeatRuntime | undefined {
		return this.byPerson.get(person);
	}

	/** What this aide is closing, while it is closing it. */
	draftOf(name: string): Draft | undefined {
		return this.drafts.get(name);
	}

	/**
	 * One person may be owed one message. A second exchange that closes while
	 * the first is still owed widens the range back to the earlier question,
	 * because that is what its person has not read.
	 */
	owe(person: string, from: Seq): void {
		if (!this.byPerson.has(person)) return;
		const already = this.owed.get(person);
		this.owed.set(person, already === undefined ? from : Math.min(already, from));
	}

	/**
	 * The turns to take now, one per person owed a message: the range each
	 * aide would stand for, or nothing where one message already serves. An
	 * aide already drafting is left alone, and stays owed.
	 */
	turnsDue(
		record: readonly Message[],
		through: Seq,
		fromSeat: (name: string) => boolean,
	): { seat: SeatRuntime; draft: Draft }[] {
		const due: { seat: SeatRuntime; draft: Draft }[] = [];
		for (const [person, from] of [...this.owed]) {
			const seat = this.byPerson.get(person);
			if (!seat || seat.active) continue;
			this.owed.delete(person);
			const draft = draftOver(record, from, through, fromSeat);
			if (!draft) continue;
			this.drafts.set(seat.def.name, draft);
			due.push({ seat, draft });
		}
		return due;
	}

	/**
	 * A summarising turn is over. It wrote, or it judged that one message
	 * already served; a race or a failed turn leaves the range owed, and the
	 * next quiet room is another chance.
	 */
	turnEnded(seat: SeatRuntime, wrote: boolean): void {
		const person = this.owners.get(seat.def.name);
		const draft = this.drafts.get(seat.def.name);
		this.drafts.delete(seat.def.name);
		if (person === undefined || draft === undefined || wrote) return;
		if (draft.refusals > 0 || draft.failed) this.owe(person, draft.from);
	}

	/** A cancelled draft writes nothing, which is the safe direction. */
	abort(): void {
		this.drafts.clear();
	}
}
