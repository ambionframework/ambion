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
 * - It takes the `ASSISTANT` role, which answers both of the exchange's
 *   events. A close wakes it, for the person who owns the closed exchange;
 *   that activation holds one tool, `summarise`, bound to the range it must
 *   stand for. An opened exchange wakes it too, when the room holds agents
 *   in reserve; that activation holds one tool, `seat`, bound to the
 *   reserve. The assistant bookends the exchange: it composes the room at
 *   the open and consolidates what the room said at the close.
 *
 * **The assistant is a role.** `ASSISTANT` names the two events and the tool
 * the seat holds at each, and a host seats one agent in it. The runtime
 * knows the role by what it answers, so nothing here names the assistant:
 * `reconcile` asks the roster which seat answers `closed`, and `view` asks
 * the seat's role which tool it holds.
 *
 * What is left in this file is the threshold a summary is written above. Who
 * is owed and when the next draft starts are folds over the journal
 * (`fold.ts`), and the room's `reconcile` sends the wake.
 */
import type { Message, Seq } from '../types.ts';
import { isSpoken } from '../types.ts';

/**
 * What a summary would stand for, or nothing when one message already serves:
 * one answer is left as it was given, in the voice that gave it, and an
 * exchange the agents said nothing into writes nothing at all.
 *
 * It counts what the room produced, not what people said into it, and it
 * counts messages rather than speakers — one product saying four things needs
 * consolidating as much as three products saying one each.
 */
export function draftOver(
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
