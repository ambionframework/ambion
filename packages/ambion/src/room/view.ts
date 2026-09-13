/**
 * What an activation is given, read off the fold and rendered: the seats,
 * the people, the record, the tool the activation holds and what it holds
 * it for. Every function is pure over the facts it is handed, so the view a
 * seat reads in one process is the view it reads in another.
 */

import {
	type PersonView,
	type RoomView,
	renderSystemPrompt,
	renderTurnContext,
	type SeatSpeaking,
} from '../render.ts';
import type { AgentDefinition, Exchange, SeatInfo, Seq } from '../types.ts';
import type { ActivationView, ToolName } from '../wire.ts';
import type { RoomState } from './fold.ts';
import { parseId } from './lease.ts';

/** What the view is built from: the fold, and what the room holds beside it. */
export interface RoomFacts {
	readonly name: string;
	readonly now: number;
	readonly assistant: string;
	readonly state: RoomState;
	/** The seats live now, by name, with the ids that make them live. */
	readonly live: ReadonlyMap<string, string[]>;
	/** How many messages landed after this seq. */
	unseen(since: Seq): number;
}

/** The roster and the people, as `seats()` reports them, off one folded state and nothing else. */
export function seatsOf(facts: Pick<RoomFacts, 'name' | 'state' | 'live'>): SeatInfo[] {
	const seats: SeatInfo[] = facts.state.roster.map((seat) => ({
		kind: 'agent' as const,
		name: seat.name,
		identity: seat.identity,
		status: facts.live.has(seat.name) ? ('active' as const) : ('idle' as const),
		attention: seat.attention,
		sessionId: `${facts.name}:${seat.name}`,
		...(seat.assistant ? { assistant: true as const } : {}),
	}));
	for (const person of facts.state.people.values()) {
		seats.push({
			kind: 'human',
			name: person.name,
			identity: person.identity,
			presence: person.presence,
		});
	}
	return seats;
}

/** The view one activation reads: two rendered strings, the model id, and the tool. */
export function viewOf(
	id: string,
	seat: string,
	def: AgentDefinition,
	facts: RoomFacts,
): ActivationView {
	const state = facts.state;
	const { tool, closing, composing } = toolOf(id, facts);
	const speaking: SeatSpeaking = {
		def,
		assistant: seat === facts.assistant,
		closing: closing && { ...closing, preferences: state.people.get(closing.person)?.preferences },
		composing: composing && { ...composing, reserve: reserved(facts) },
	};
	const room = roomView(facts);
	return {
		activation: id,
		seat,
		model: def.model,
		lastSeq: state.lastSeq,
		systemPrompt: renderSystemPrompt(speaking, room),
		context: renderTurnContext(speaking, room),
		...(tool === undefined ? {} : { tool }),
		...(closing ? { closing } : {}),
		...(composing ? { composing } : {}),
	};
}

type Bound = {
	tool?: ToolName;
	closing?: ActivationView['closing'];
	composing?: ActivationView['composing'];
};

/**
 * What an activation is for, read off its cause and the fold: an activation
 * a close caused writes the summary, one the open caused composes the room,
 * and one a message caused speaks. The fold decided the cause, so this
 * reads the id and never the roster.
 *
 * A draft id names one close; the tool it holds covers every close its
 * person is owed, so a close that joined the draft after the claim is read
 * too.
 */
function toolOf(id: string, facts: RoomFacts): Bound {
	const state = facts.state;
	const parsed = parseId(id);
	if (parsed?.cause === 'closed') {
		const owed = state.owed.find((o) => o.covering.includes(parsed.position));
		if (owed === undefined) return {};
		return {
			tool: 'summarise',
			closing: { person: owed.person, from: owed.from, through: state.lastSeq },
		};
	}
	if (parsed?.cause !== 'opened') return { tool: 'say' };
	const question = state.messages.find((m) => m.seq === parsed.position);
	if (question === undefined) return {};
	return {
		tool: 'seat',
		composing: { person: question.from, from: question.seq, limit: state.reserve.length },
	};
}

/** The reserve as the assistant reads it: a name and an identity per agent. */
function reserved(facts: RoomFacts): { name: string; identity: string }[] {
	return facts.state.reserve.map((seat) => ({ name: seat.name, identity: seat.identity }));
}

/** What the prose is given of this room, built fresh for each activation. */
function roomView(facts: RoomFacts): RoomView {
	const state = facts.state;
	const exchange: Exchange | undefined = state.exchange;
	return {
		name: facts.name,
		goal: state.composition?.goal,
		now: facts.now,
		seats: seatsOf(facts),
		people: peopleViews(facts),
		record: state.messages,
		exchange: exchange && { owner: exchange.owner, from: exchange.from },
	};
}

/** One entry per person the room knows, with their gap and what they missed. */
function peopleViews(facts: RoomFacts): PersonView[] {
	return [...facts.state.people.values()].map((person) => ({
		name: person.name,
		identity: person.identity,
		presence: person.presence,
		changedAt: person.changedAt,
		since: person.since,
		unseen: person.since === undefined ? 0 : facts.unseen(person.since),
	}));
}
