/**
 * A seat: one agent in one room, and what wakes it.
 *
 * A seat is the agent plus everything the room knows about it while it is
 * seated — where its attention sits on the scale, whether it is taking an activation,
 * how much of the record it has provably heard. The agent definition is a
 * value and says none of that: the same definition is the quiet corner in one
 * room and the one who meets people in another.
 *
 * The routing rule lives here too, because it is a fact about a seat rather
 * than about the room: every message has a reach, and a seat wakes when its
 * attention is at least that wide.
 */
import type {
	AgentTool,
	AgentToolResult,
	Session as PiSession,
} from '@earendil-works/pi-agent-core';
import type { Activation } from './activation.ts';
import type { AgentDefinition, Attention, Message } from './types.ts';
import { isAmbionTool, isSpoken } from './types.ts';
import { toolContext } from './workspace.ts';

export interface SeatRuntime {
	def: AgentDefinition;
	/** What wakes this seat. Chosen at seating, not by the definition. */
	attention: Attention;
	/**
	 * The activation this seat is taking, while it is taking one. Everything
	 * that lasts seconds lives there; everything here lasts as long as the seat
	 * is seated. A seat is active when it has one.
	 */
	activation?: Activation;
	/** The seat's own downstream Pi session, opened once and kept for the run. */
	piSeat?: Promise<PiSession>;
}

/** Whether this seat is taking an activation now. Runtime state, not a seating choice. */
export function isActive(seat: SeatRuntime): boolean {
	return seat.activation !== undefined;
}

/** The attention scale, narrowest first. A seat hears what it is wide enough for. */
const WIDTH: Record<Attention, number> = { none: 0, named: 1, broadcast: 2, presence: 3 };

/**
 * How wide a seat's attention has to be for this message to reach it: a
 * directed say reaches the one it names, anything else said reaches the room,
 * and a person arriving or leaving reaches the widest end.
 */
function reachOf(message: Message): Attention {
	if (!isSpoken(message)) return 'presence';
	return message.to === undefined ? 'broadcast' : 'named';
}

/**
 * One rule, read off the scale: a seat wakes when its attention is at least as
 * wide as the message's reach — and a directed message additionally wakes the
 * one it names and nobody else. Rule 1 routes, rule 6 decides who sits out,
 * and a presence message is routed like any other.
 */
export function wakes(
	seat: SeatRuntime,
	target: SeatRuntime | undefined,
	message: Message,
	fromAssistant: boolean,
): boolean {
	// Nothing an assistant writes wakes anybody: a room that woke because somebody's
	// assistant wanted something is a room run by a proxy. The guard is on the
	// author rather than on what it wrote, so it holds for anything an assistant
	// ever writes. Every seat still reads it.
	if (fromAssistant) return false;
	const reach = reachOf(message);
	if (WIDTH[seat.attention] < WIDTH[reach]) return false;
	return reach === 'named' ? seat === target : true;
}

/**
 * One Pi tool from what a seat declared. A `defineTool` tool is handed a
 * `ToolContext` built for the seat's agent on every call, which is how it
 * reaches a workspace; a Pi-native tool passes through as it is, and its
 * signature has no room for one.
 */
export function toPiTool(tool: unknown, agent: AgentDefinition): AgentTool {
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
export function delivered(): AgentToolResult<Record<string, never>> {
	return { content: [{ type: 'text', text: 'delivered' }], details: {} };
}
