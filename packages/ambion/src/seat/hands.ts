/**
 * The hands a seat holds: the tools the room gives an activation, bound to
 * it and to the room. A seat that speaks for itself holds `say`, the four
 * built-in tools when its agent names a workspace, and the agent's own
 * tools. The assistant holds one hand: `summarise` at a close, `seat` at
 * the open of an exchange. Every hand commits through the room's `commit`
 * call and reads the room's answer through `landed`.
 */
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { SAY, SEAT, SUMMARISE } from '../define.ts';
import { refusal } from '../render.ts';
import { builtinTools, toolContext } from '../tools/workspace.ts';
import { type AgentDefinition, isAmbionTool, type Message, type Seq } from '../types.ts';
import type { ActivationView, CommitResponse, SeatRoom } from '../wire.ts';
import type { Activation } from './activation.ts';

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
 * One Pi tool from what a seat declared. A `defineTool` tool is handed a
 * `ToolContext` built for the seat's agent on every call, which is how it
 * reaches a workspace; a Pi-native tool passes through as it is, and its
 * signature has no room for one.
 */
function toPiTool(tool: unknown, agent: AgentDefinition): AgentTool {
	if (isAmbionTool(tool)) {
		return {
			name: tool.name,
			label: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			execute: async (_toolCallId, params, signal) => {
				const result = await tool.execute(params, toolContext(agent, signal));
				return typeof result === 'string'
					? { content: [{ type: 'text', text: result }], details: {} }
					: result;
			},
		};
	}
	const raw = tool as AgentTool & { label?: string };
	if (typeof raw?.name !== 'string' || typeof raw?.execute !== 'function') {
		throw new Error('Tools must come from defineTool (Ambion or Pi).');
	}
	return raw.label ? raw : { ...raw, label: raw.name };
}

/** What a write tool returns when the record took it. */
function delivered(): AgentToolResult<Record<string, never>> {
	return { content: [{ type: 'text', text: 'delivered' }], details: {} };
}

/** What every hand a seat holds reaches: the activation it belongs to, and the room. */
export interface Hands {
	readonly activation: Activation;
	readonly room: SeatRoom;
	/** What a hand makes of the room's answer: a mark on the record, a refusal, or a lease that ended. */
	landed(response: CommitResponse): AgentToolResult<Record<string, never>>;
}

export function hands(activation: Activation, room: SeatRoom): Hands {
	return {
		activation,
		room,
		landed(response) {
			if ('committed' in response) {
				activation.heard(response.committed.seq);
				activation.spoke = true;
				return delivered();
			}
			if ('refused' in response) throw new Error(response.refused);
			if ('missed' in response) {
				throw new Error('The room moved. Read what landed, then decide again.');
			}
			// The lease ended under this hand: the room is closing, or the seat
			// ran past its lease. Nothing it writes now lands, so the turn is over.
			activation.abort();
			return standDown(`Your turn ended: ${response.stale}.`) as AgentToolResult<
				Record<string, never>
			>;
		},
	};
}

/** The one hand every seat that speaks for itself holds. */
function sayTool(hands: Hands): AgentTool {
	return {
		...SAY,
		label: SAY.name,
		description:
			'Speak on the record. Omit `to` to address the room; set `to` to a participant name ' +
			'to address them directly — a directed say to an agent also calls them in. ' +
			'Ending your turn without calling say is declining to speak.',
		execute: async (toolCallId, rawParams) => {
			const params = rawParams as { to?: string; text: string };
			const to = params.to?.trim() ? params.to.trim() : undefined;
			const text = params.text.trim();
			// A message with nothing in it still takes a seq, renders in
			// every context after it, and stands inside whatever range a
			// summary covers. Saying nothing is ending the activation.
			if (text === '') {
				throw new Error('The message is empty. Say something, or end your turn instead.');
			}
			const response = await hands.room.commit({
				activation: hands.activation.id,
				key: toolCallId,
				readThrough: hands.activation.readThrough,
				intent: { kind: 'said', ...(to === undefined ? {} : { to }), text },
			});
			if ('missed' in response) {
				// Now heard, the seat decides again against the record as it stands.
				hands.activation.heard(response.missed.at(-1)?.seq ?? 0);
				throw new Error(
					refusal(
						'Not delivered — the room moved while you were speaking. New on the record:',
						response.missed,
						'Speak again only if your reply still adds something the room has not heard; otherwise end your turn.',
					),
				);
			}
			return hands.landed(response);
		},
	};
}

/**
 * What an activation holds. A seat speaks, reaches its workspace through the
 * four built-in tools when it names one, and uses its own tools; the assistant
 * holds the one hand its view names, and it reaches the record. `startSession`
 * refuses an assistant that carries tools or a workspace of its own, so there
 * is nothing else to leave out.
 */
export function handsFor(view: ActivationView, def: AgentDefinition, held: Hands): AgentTool[] {
	if (view.tool === 'say') {
		return [sayTool(held), ...builtinTools(def), ...def.tools.map((tool) => toPiTool(tool, def))];
	}
	if (view.tool === 'summarise' && view.closing) {
		const draft: Draft = { ...view.closing, refusals: 0, calls: 0 };
		return [summariseTool(held, draft)];
	}
	if (view.tool === 'seat' && view.composing) {
		const composing: Composing = { ...view.composing, seated: 0, calls: 0 };
		return [seatTool(held, composing)];
	}
	return [];
}

// -- the assistant's hands ----------------------------------------------------

/**
 * One summarising activation's own state. The range is read off the view when the
 * activation starts, and it widens when a race refuses the draft, so the retry
 * stands for what won. Nothing here outlives the activation.
 */
interface Draft {
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
function summariseTool(hands: Hands, closing: Draft): AgentTool {
	const person = closing.person;
	return {
		...SUMMARISE,
		label: SUMMARISE.name,
		description:
			`Write the one message ${person} reads for this exchange. Call it once. ` +
			'Ending your turn without calling it leaves the range whole, for whoever reads it.',
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
function standDown(why: string | undefined): AgentToolResult<Record<string, never>> | undefined {
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
 * are now inside it, so the redraft stands for them too and the summary
 * leaves no message between it and what it covers.
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
interface Composing {
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
function seatTool(hands: Hands, composing: Composing): AgentTool {
	return {
		...SEAT,
		label: SEAT.name,
		description:
			'Seat one agent from the reserve. It joins the room at once and reads the question. ' +
			'Ending your turn without calling it leaves the roster as it stands.',
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
