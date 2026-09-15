/**
 * The bound a seat holds: the tools the room gives an activation, bound to
 * it and to the room. A seat that speaks for itself holds `say` and the
 * agent's composed tools. The assistant holds one tool: `summarise` at a close, `seat` at
 * the open of an exchange. Every one commits through the room's `commit`
 * call and reads the room's answer through `landed`.
 */
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { SEAT, SUMMARISE, seatToolDescription, summaryToolDescription } from '../assistant.ts';
import { SAY } from '../define.ts';
import { refusal } from '../render.ts';
import { type AgentDefinition, isAmbionTool, type Seq } from '../types.ts';
import type { ActivationView, CommitResult, SeatRoom } from '../wire.ts';
import type { Activation } from './activation.ts';

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
 * reaches the agent context; a Pi-native tool passes through as it is, and its
 * signature has no room for one.
 */
function toPiTool(tool: unknown, agent: AgentDefinition): AgentTool {
	if (isAmbionTool(tool)) {
		return {
			name: tool.name,
			label: tool.label ?? tool.name,
			description: tool.description,
			parameters: tool.parameters,
			...(tool.prepareArguments === undefined ? {} : { prepareArguments: tool.prepareArguments }),
			...(tool.executionMode === undefined ? {} : { executionMode: tool.executionMode }),
			execute: async (_toolCallId, params, signal, onUpdate) => {
				const result = await tool.execute(params, {
					agent: { name: agent.name, identity: agent.identity },
					signal,
					callId: _toolCallId,
					onUpdate,
				});
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

/** What every tool the room binds reaches: the activation it belongs to, and the room. */
export interface Binding {
	readonly activation: Activation;
	readonly room: SeatRoom;
	/** What a tool makes of the room's answer: a mark on the record, a refusal, or a lease that ended. */
	landed(response: CommitResult): AgentToolResult<Record<string, never>>;
}

export function binding(activation: Activation, room: SeatRoom): Binding {
	return {
		activation,
		room,
		landed(response) {
			if ('committed' in response) {
				activation.spoke = true;
				return delivered();
			}
			if ('refused' in response) throw new Error(response.refused);
			if ('missed' in response) {
				throw new Error('The room moved. Read what landed, then decide again.');
			}
			// The lease ended under this tool: the room is closing, or the seat
			// ran past its lease. Nothing it writes now lands, so the turn is over.
			activation.abort();
			return standDown(`Your turn ended: ${response.stale}.`) as AgentToolResult<
				Record<string, never>
			>;
		},
	};
}

/** The one tool every seat that speaks for itself holds. */
function sayTool(bound: Binding): AgentTool {
	return {
		...SAY,
		label: SAY.name,
		description:
			'Speak on the record. Omit `to` to address the room; set `to` to a participant name ' +
			'to address them directly — a directed say to an agent also calls them in. ' +
			'Ending your turn without calling say is declining to speak.',
		execute: async (toolCallId, rawParams) => say(bound, toolCallId, rawParams),
	};
}

async function say(
	bound: Binding,
	toolCallId: string,
	rawParams: unknown,
): Promise<AgentToolResult<Record<string, never>>> {
	const params = rawParams as { to?: string; text: string };
	const to = params.to?.trim() ? params.to.trim() : undefined;
	const text = params.text.trim();
	// A message with nothing in it still takes a seq, renders in
	// every context after it, and stands inside whatever range a
	// summary covers. Saying nothing is ending the activation.
	if (text === '') {
		throw new Error('The message is empty. Say something, or end your turn instead.');
	}
	const response = await bound.room.commit({
		activation: bound.activation.id,
		key: toolCallId,
		readThrough: bound.activation.readThrough,
		intent: { kind: 'said', ...(to === undefined ? {} : { to }), text },
	});
	if ('missed' in response) {
		bound.activation.toolResultExpected(
			toolCallId,
			response.missed.at(-1)?.seq ?? bound.activation.readThrough,
		);
		throw new Error(
			refusal(
				'Not delivered — the room moved while you were speaking. New on the record:',
				response.missed,
				'Speak again only if your reply still adds something the room has not heard; otherwise end your turn.',
			),
		);
	}
	if ('committed' in response && response.committed.kind === 'said') {
		bound.activation.acknowledgeThrough(response.committed.seq);
	}
	return bound.landed(response);
}

/**
 * What an activation holds: the one tool its view names, built by the binder
 * that answers the name.
 *
 * A message causes an activation that speaks, so the view names `say`, and a
 * seat that speaks brings its composed tools. An event of the exchange causes an activation
 * that holds one tool and nothing else: what the seat does with it is the
 * whole of the activation.
 *
 * An ordinary message activation gives the seat its own tools.
 */
export function toolsFor(view: ActivationView, def: AgentDefinition, held: Binding): AgentTool[] {
	switch (view.spec.cause) {
		case 'message':
			return [sayTool(held), ...def.tools.map((tool) => toPiTool(tool, def))];
		case 'opened': {
			const composing: Composing = { ...view.spec.opening, seated: 0, calls: 0 };
			return [seatTool(held, composing)];
		}
		case 'closed': {
			const attempt: SummaryAttempt = { ...view.spec.closing, calls: 0 };
			return [summariseTool(held, attempt)];
		}
	}
}

// -- the assistant's bound ----------------------------------------------------

/**
 * One summarising activation's own state. The range is read off the closed
 * exchange when the activation starts. Nothing here outlives the activation.
 */
interface SummaryAttempt {
	/** The person whose question opened the exchange, and who reads the message. */
	readonly person: string;
	/** The question that opened the exchange. */
	readonly from: Seq;
	/** The last seq it stands for. */
	readonly through: Seq;
	calls: number;
	/** The message landed: the activation writes once. */
	written?: true;
}

/**
 * The assistant's one tool at a close, and it reaches the record and nothing
 * else. It commits against the fixed exchange that caused the activation.
 * Later record entries do not change that exchange.
 */
function summariseTool(bound: Binding, closing: SummaryAttempt): AgentTool {
	const person = closing.person;
	return {
		...SUMMARISE,
		label: SUMMARISE.name,
		description: summaryToolDescription(person),
		execute: async (toolCallId, rawParams) => {
			closing.calls += 1;
			const stop = standDown(stoppingReason(closing));
			if (stop) return stop;
			const text = (rawParams as { text: string }).text.trim();
			if (text === '') {
				throw new Error(`The message is empty. Write what ${person} reads, or end your turn.`);
			}
			const response = await bound.room.commit({
				activation: bound.activation.id,
				key: toolCallId,
				intent: {
					kind: 'summary',
					to: person,
					text,
					covers: { from: closing.from, through: closing.through },
				},
			});
			if ('committed' in response) closing.written = true;
			return bound.landed(response);
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

function stoppingReason(draft: SummaryAttempt): string | undefined {
	if (draft.written) return `${draft.person}'s message is written.`;
	if (draft.calls > ASSISTANT_CALLS) return 'You have tried this enough times.';
	return undefined;
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
 * The assistant's tool at the open of an exchange, and it reaches the reserve
 * and the record and nothing else. It commits outside rule 5's lock: the
 * assistant decides on the question, and what the seats said while it decided
 * does not change what the question needs. The room refuses a name that is
 * not in the reserve, and says which names are. The tool bounds its activation
 * the way `summarise` bounds one: the reserve is finite, each name seats once,
 * and a model that keeps calling after the reserve is empty, or keeps naming
 * what is not there, has the activation ended for it.
 */
function seatTool(bound: Binding, composing: Composing): AgentTool {
	return {
		...SEAT,
		label: SEAT.name,
		description: seatToolDescription,
		execute: async (toolCallId, rawParams) => {
			composing.calls += 1;
			const stop = standDown(composeStoppingReason(composing));
			if (stop) return stop;
			const name = (rawParams as { name: string }).name.trim();
			const response = await bound.room.commit({
				activation: bound.activation.id,
				key: toolCallId,
				intent: { kind: 'seated', name },
			});
			if ('committed' in response) composing.seated += 1;
			return bound.landed(response);
		},
	};
}

function composeStoppingReason(composing: Composing): string | undefined {
	if (composing.seated >= composing.limit) return 'Everybody who was on call is in the room.';
	if (composing.calls > composing.limit + ASSISTANT_CALLS)
		return 'You have tried this enough times.';
	return undefined;
}
