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
import type { AgentDefinition, SeatInfo, Seq } from '../types.ts';
import type { ActivationSpec, ActivationView } from '../wire.ts';
import type { RoomState } from './fold.ts';

/** What the view is built from: the fold, and what the room holds beside it. */
export interface RoomFacts {
	readonly name: string;
	readonly now: number;
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
		assistant: seat.name === facts.state.composition?.assistant,
		sessionId: `${facts.name}:${seat.name}`,
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
	spec: ActivationSpec,
	def: AgentDefinition,
	facts: RoomFacts,
): ActivationView {
	const state = facts.state;
	const tool = spec.grant.tool;
	const closing = spec.cause === 'closed' ? spec.closing : undefined;
	const composing = spec.cause === 'opened' ? spec.opening : undefined;
	const speaking: SeatSpeaking = {
		def,
		tool,
		closing: closing && { ...closing, preferences: state.people.get(closing.person)?.preferences },
		composing: composing && { ...composing, reserve: reserved(facts) },
	};
	const room = roomView(facts, closing);
	return {
		spec,
		model: def.model,
		systemPrompt: renderSystemPrompt(speaking, room),
		context: renderTurnContext(speaking, room),
	};
}

/** The reserve as the assistant reads it: a name and an identity per agent. */
function reserved(facts: RoomFacts): { name: string; identity: string }[] {
	return facts.state.reserve.map((seat) => ({ name: seat.name, identity: seat.identity }));
}

/** What the prose is given of this room, built fresh for each activation. */
function roomView(facts: RoomFacts, closing?: { from: Seq; through: Seq }): RoomView {
	const state = facts.state;
	return {
		name: facts.name,
		goal: state.composition?.goal,
		now: facts.now,
		seats: seatsOf(facts),
		people: peopleViews(facts),
		record:
			closing === undefined
				? state.messages
				: state.messages.filter(
						(message) => message.seq >= closing.from && message.seq <= closing.through,
					),
		exchange: state.exchange && { owner: state.exchange.owner, from: state.exchange.from },
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
