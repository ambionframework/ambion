/**
 * A seat: one agent in one room, and what wakes it.
 *
 * A seat is the agent plus everything the room knows about it while it is
 * seated — where its attention sits on the scale, whether it is taking a turn,
 * how much of the record it has provably heard. The agent definition is a
 * value and says none of that: the same definition is the quiet corner in one
 * room and the one who meets people in another.
 *
 * The routing rule lives here too, because it is a fact about a seat rather
 * than about the room: every message has a reach, and a seat wakes when its
 * attention is at least that wide.
 */
import type { Agent, AgentTool, Session as PiSession } from '@earendil-works/pi-agent-core';
import type { Draft } from './aide.ts';
import type { AgentDefinition, Attention, Message, Seq } from './types.ts';
import { isAmbionTool, isSpoken } from './types.ts';

export interface SeatRuntime {
	def: AgentDefinition;
	/** What wakes this seat. Chosen at seating, not by the definition. */
	attention: Attention;
	/**
	 * The person this seat writes for, when it is their aide. It is what makes
	 * a seat an aide: nothing it writes wakes anybody, a closed exchange of
	 * theirs is what wakes it, and the summary it writes is addressed to them.
	 */
	owner?: string;
	/**
	 * The exchange this activation is closing, on a summarising turn. It holds
	 * one tool instead of its own, and the range that tool commits against.
	 */
	closing?: Draft;
	active: boolean;
	spoke: boolean;
	/** Pi's abort() cancels the run but not its queues; this stops the rebuild loop too. */
	aborted: boolean;
	/**
	 * How much of the record this seat has provably heard: the seq its view
	 * rendered, advanced as steers land in the transcript and by its own says.
	 */
	viewSeq: Seq;
	/** Record seqs of steers enqueued to the live agent, awaiting their drain (FIFO). */
	pendingSteers: Seq[];
	agent?: Agent;
	piSeat?: Promise<PiSession>;
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
	fromAide: boolean,
): boolean {
	// Nothing an aide writes wakes anybody: a room that woke because somebody's
	// aide wanted something is a room run by a proxy. The guard is on the
	// author rather than on what it wrote, so it holds for anything an aide
	// ever writes. Every seat still reads it.
	if (fromAide) return false;
	const reach = reachOf(message);
	if (WIDTH[seat.attention] < WIDTH[reach]) return false;
	return reach === 'named' ? seat === target : true;
}

export function toPiTool(tool: unknown): AgentTool {
	if (isAmbionTool(tool)) {
		return {
			name: tool.name,
			label: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			execute: async (_toolCallId, params, signal) => {
				const result = await tool.execute(params, signal);
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
