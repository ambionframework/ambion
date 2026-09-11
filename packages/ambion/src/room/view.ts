/**
 * What an activation is given, read off the fold and rendered: the seats,
 * the people, the record, the hand the activation holds and what it holds
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
import {
	type AgentDefinition,
	type ClosedMessage,
	type Exchange,
	isClosed,
	isSummary,
	type SeatInfo,
	type Seq,
} from '../types.ts';
import type { ActivationView, Hand } from '../wire.ts';
import { covered } from './exchange.ts';
import type { RoomState } from './fold.ts';
import { wokenBy } from './lease.ts';

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

/** The view one activation reads: two rendered strings, the model id, and the hand. */
export function viewOf(
	id: string,
	seat: string,
	def: AgentDefinition,
	facts: RoomFacts,
): ActivationView {
	const state = facts.state;
	const { hand, closing, composing } = handOf(id, seat, facts);
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
		hand,
		...(closing ? { closing } : {}),
		...(composing ? { composing } : {}),
	};
}

type Hands = {
	hand: Hand;
	closing?: ActivationView['closing'];
	composing?: ActivationView['composing'];
};

/**
 * What an activation is for, read off the message that woke it: the room's
 * close hands the assistant the one message its person reads, the question
 * that opened an exchange hands the assistant the room to compose, and every
 * other seat speaks. The close that woke the draft names one range; the hand
 * covers every close its person is still owed, so a close that landed after
 * the claim is read too.
 */
function handOf(id: string, seat: string, facts: RoomFacts): Hands {
	const state = facts.state;
	const woke = wokenBy(id, state.messages);
	if (woke === undefined) return { hand: 'none' };
	if (isClosed(woke)) {
		if (written(woke, state)) return { hand: 'none' };
		const from = owedFrom(woke, state);
		return { hand: 'summarise', closing: { person: woke.from, from, through: state.lastSeq } };
	}
	if (seat !== facts.assistant) return { hand: 'say' };
	if (!openedBy(woke.seq, state)) return { hand: 'none' };
	return {
		hand: 'seat',
		composing: { person: woke.from, from: woke.seq, limit: state.reserve.length },
	};
}

/** Whether a summary already stands for the whole of this closed exchange. */
function written(close: ClosedMessage, state: RoomState): boolean {
	return state.messages.filter(isSummary).some((summary) => covered(summary, close));
}

/**
 * The earliest question this person is still owed one message for: the close
 * that woke this activation, and every other close of theirs the room owes.
 * One message reaches back to the earliest, so a person reads one message and
 * misses nothing.
 *
 * It reads the room's own list of what it owes rather than the closes again,
 * so a close the assistant has already judged is not covered a second time,
 * and a close a checkpoint put below the floor stays judged.
 */
function owedFrom(close: ClosedMessage, state: RoomState): Seq {
	const froms = [close.covers.from];
	for (const owed of state.due) {
		const other = wokenBy(owed.id, state.messages);
		if (other !== undefined && isClosed(other) && other.from === close.from) {
			froms.push(other.covers.from);
		}
	}
	return Math.min(...froms);
}

/** Whether the message at `seq` opened an exchange, open or closed since. */
function openedBy(seq: Seq, state: RoomState): boolean {
	return state.exchange?.from === seq || state.closes.some((close) => close.covers.from === seq);
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
