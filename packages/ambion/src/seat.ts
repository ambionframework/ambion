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
import { Type } from 'typebox';
import type { Activation } from './activation.ts';
import { refusal } from './render.ts';
import type { AgentDefinition, Attention, Message, Seq, SpokenMessage } from './types.ts';
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
	/** Seated after the room started, so `stop` unseats it and the record says so. */
	added?: true;
	/** Seated from the reserve, so an unseat returns it there. */
	reserved?: true;
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
 * One rule, read off the scale, in three lines. A seat the message names wakes,
 * however narrowly it is seated: a directed say names the one it addresses, and
 * a seating names the seat it seats. Everybody else wakes when their attention
 * is at least as wide as the message's reach — and a directed say reaches
 * nobody else at all. Rule 1 routes, rule 6 decides who sits out, and a
 * presence message is routed like any other.
 */
export function wakes(
	seat: SeatRuntime,
	target: SeatRuntime | undefined,
	message: Message,
	fromAssistant: boolean,
): boolean {
	// Nothing the assistant writes wakes anybody, with one exception written
	// into the line: a seating it committed wakes the seat it names. That is the
	// one activation the assistant can cause. The guard is on the author rather
	// than on what it wrote, so it holds for anything else it ever writes, and
	// every seat still reads it.
	if (fromAssistant) return message.kind === 'seated' && seat === target;
	if (seat === target) return true;
	const reach = reachOf(message);
	if (WIDTH[seat.attention] < WIDTH[reach]) return false;
	return reach !== 'named';
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

// -- say ---------------------------------------------------------------------

/** What the say tool needs of the room: the record's lock, the roster, and the record. */
export interface SayRoom {
	/** The last seq the record holds. */
	lastSeq(): Seq;
	/**
	 * Rule 5: what landed past `readThrough`. Anything here refuses the say,
	 * and the room reports the conflict. Synchronous, so `commit` shares its tick.
	 */
	missed(readThrough: Seq): Message[];
	/** Refuses a name the seat cannot address: unknown, itself, or seated at `none`. */
	addressable(to: string | undefined): void;
	/** The append half of rule 5's one tick. Nothing awaits between `missed` and this. */
	commit(draft: Omit<SpokenMessage, 'seq' | 'at'>): SpokenMessage;
	publish(message: Message): Promise<void>;
}

/**
 * The one tool every seat holds (rule 3): speaking is a tool, and silence is
 * the default. It commits under rule 5's lock, so a say drafted against a
 * record that has moved is refused, and the refusal carries what the seat
 * missed. The seat then decides again against the record as it stands.
 */
export function sayTool(seat: SeatRuntime, activation: Activation, room: SayRoom): AgentTool {
	return {
		name: 'say',
		label: 'say',
		description:
			'Speak on the record. Omit `to` to address the room; set `to` to a participant name ' +
			'to address them directly — a directed say to an agent also calls them in. ' +
			'Ending your turn without calling say is declining to speak.',
		parameters: Type.Object({
			to: Type.Optional(Type.String({ description: 'A participant name from the roster.' })),
			text: Type.String(),
		}),
		execute: async (_toolCallId, rawParams) => {
			const params = rawParams as { to?: string; text: string };
			const to = params.to?.trim() ? params.to.trim() : undefined;
			// Rule 5 comes first: a seat that has not read the record is told
			// what it missed before anything else is checked, so a say at a
			// colleague who left in the meantime reads the departure.
			assertHeard(activation, room);
			room.addressable(to);
			const text = params.text.trim();
			// A message with nothing in it still takes a seq, renders in
			// every context after it, and stands inside whatever range a
			// summary covers. Saying nothing is ending the activation.
			if (text === '') {
				throw new Error('The message is empty. Say something, or end your turn instead.');
			}
			// Nothing has awaited since the check, so the record stands where the
			// seat read it, and the commit is the append half of rule 5's one tick.
			const message = room.commit({
				kind: 'said',
				from: seat.def.name,
				...(to === undefined ? {} : { to }),
				text,
			});
			// The seat has heard its own say before anybody else hears of it.
			activation.heard(message.seq);
			activation.spoke = true;
			await room.publish(message);
			return delivered();
		},
	};
}

/**
 * Rule 5 for a say: the record moved past what this activation has read, so
 * the say is refused and the seat is told what landed. Now heard, the seat
 * decides again against the record as it stands.
 */
function assertHeard(activation: Activation, room: SayRoom): void {
	const missed = room.missed(activation.readThrough);
	if (missed.length === 0) return;
	activation.heard(room.lastSeq());
	throw new Error(
		refusal(
			'Not delivered — the room moved while you were speaking. New on the record:',
			missed,
			'Speak again only if your reply still adds something the room has not heard; otherwise end your turn.',
		),
	);
}
