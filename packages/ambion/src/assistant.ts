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
 * to seat as one, the threshold a summary is written above, and the two
 * tools. Who is owed and when the next draft starts are folds over the log
 * (`fold.ts`), and the room's `reconcile` sends the wake.
 */
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { refusal } from './render.ts';
import type { Hands } from './seat.ts';
import type { AgentDefinition, Message, Seq } from './types.ts';
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

/**
 * One summarising activation's own state. The range is read off the view when the
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
	/** The message landed: the activation writes once. */
	written?: true;
}

/**
 * The assistant's one hand at a close, and it reaches the record and nothing
 * else. It commits on the same queue a say commits on, under the same
 * `readThrough`, so a summary drafted against a record that has moved is
 * refused — and the refusal reaches the assistant inside its own activation,
 * carrying what it missed, so the redraft happens now rather than at the next
 * quiescence.
 */
export function summariseTool(hands: Hands, closing: Draft): AgentTool {
	const person = closing.person;
	return {
		name: 'summarise',
		label: 'summarise',
		description:
			`Write the one message ${person} reads for this exchange. Call it once. ` +
			'Ending your turn without calling it leaves the range whole, for whoever reads it.',
		parameters: Type.Object({ text: Type.String() }),
		execute: async (toolCallId, rawParams) => {
			closing.calls += 1;
			const stop = standDown(stoppingReason(closing));
			if (stop) return stop;
			const text = (rawParams as { text: string }).text.trim();
			if (text === '') {
				throw new Error(`The message is empty. Write what ${person} reads, or end your turn.`);
			}
			const response = await hands.room.commit({
				activation: hands.activation.id,
				key: toolCallId,
				readThrough: closing.through,
				intent: {
					kind: 'summary',
					to: person,
					text,
					covers: { from: closing.from, through: closing.through },
				},
			});
			if ('missed' in response) throw widen(hands, closing, response.missed);
			if ('committed' in response) closing.written = true;
			return hands.landed(response);
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
export function standDown(
	why: string | undefined,
): AgentToolResult<Record<string, never>> | undefined {
	if (why === undefined) return undefined;
	return {
		content: [{ type: 'text', text: `${why} This turn is over.` }],
		details: {},
		terminate: true,
	};
}

function stoppingReason(draft: Draft): string | undefined {
	if (draft.written) return `${draft.person}'s message is written.`;
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
function widen(hands: Hands, draft: Draft, missed: Message[]): Error {
	draft.through = missed.at(-1)?.seq ?? draft.through;
	draft.refusals += 1;
	// The room kept moving past every draft: the range stays owed, and the
	// lease says why the activation ended.
	if (draft.refusals >= ASSISTANT_DRAFTS) hands.activation.refused = true;
	return new Error(
		refusal(
			'Not written — the room moved while you were drafting. It is now yours to cover too:',
			missed,
			`Write ${draft.person}'s message again, over the range as it now stands.`,
		),
	);
}

// -- composing ---------------------------------------------------------------

/**
 * One composing activation's own state: whose question opened the exchange,
 * and how many colleagues it has seated. Nothing here outlives the activation.
 */
export interface Composing {
	/** The person whose question opened the exchange. */
	person: string;
	/** The seq of that question. */
	from: Seq;
	/** How many the reserve held at the open: the most this activation can seat. */
	limit: number;
	seated: number;
	calls: number;
}

/**
 * The assistant's hand at the open of an exchange, and it reaches the reserve
 * and the record and nothing else. It commits outside rule 5's lock: the
 * assistant decides on the question, and what the seats said while it decided
 * does not change what the question needs. The room refuses a name that is
 * not in the reserve, and says which names are. The tool bounds its activation
 * the way `summarise` bounds one: the reserve is finite, each name seats once,
 * and a model that keeps calling after the reserve is empty, or keeps naming
 * what is not there, has the activation ended for it.
 */
export function seatTool(hands: Hands, composing: Composing): AgentTool {
	return {
		name: 'seat',
		label: 'seat',
		description:
			'Seat one agent from the reserve. It joins the room at once and reads the question. ' +
			'Ending your turn without calling it leaves the roster as it stands.',
		parameters: Type.Object({
			name: Type.String({ description: 'An agent name from the reserve.' }),
		}),
		execute: async (toolCallId, rawParams) => {
			composing.calls += 1;
			const stop = standDown(composeStoppingReason(composing));
			if (stop) return stop;
			const name = (rawParams as { name: string }).name.trim();
			const response = await hands.room.commit({
				activation: hands.activation.id,
				key: toolCallId,
				intent: { kind: 'seated', name },
			});
			if ('committed' in response) composing.seated += 1;
			return hands.landed(response);
		},
	};
}

function composeStoppingReason(composing: Composing): string | undefined {
	if (composing.seated >= composing.limit) return 'Everybody who was on call is in the room.';
	if (composing.calls > composing.limit + ASSISTANT_CALLS)
		return 'You have tried this enough times.';
	return undefined;
}
