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
 * to seat as one, and the threshold a summary is written above. The two
 * tools are hands the seat side gives it (`seat/hands.ts`). Who is owed and
 * when the next draft starts are folds over the journal (`fold.ts`), and the
 * room's `reconcile` sends the wake.
 */
import type { AgentDefinition, Message, Seq } from '../types.ts';
import { isAgent, isSpoken } from '../types.ts';

/**
 * The assistant shapes what a room already does, and never makes anything
 * happen. It carries no tools of its own, so the rule is a fact about the
 * definition and no promise about behaviour: the one tool the runtime
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
