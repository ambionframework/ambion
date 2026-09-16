/** Pure collaboration context derived from the room projection. */

import { type Message, type SeatInfo, type Seq, seatSessionId } from '../types.ts';
import type {
	ActivationPurpose,
	ActivationSpec,
	ActivationView,
	CollaborationContext,
	ContextParticipant,
} from '../wire.ts';
import type { RoomState } from './fold.ts';

/** What the view is built from: the fold and current host facts. */
export interface RoomFacts {
	readonly name: string;
	readonly now: number;
	readonly state: RoomState;
	/** The seats live now, by name, with the ids that make them live. */
	readonly live: ReadonlyMap<string, string[]>;
	/** How many messages landed after this seq. */
	unseen(since: Seq): number;
}

/** The roster and people returned by the public participants query. */
export function seatsOf(facts: Pick<RoomFacts, 'name' | 'state' | 'live'>): SeatInfo[] {
	return [
		...agentsOf(facts).map((agent) => ({
			...agent,
			sessionId: seatSessionId(facts.name, agent.name),
		})),
		...[...facts.state.people.values()].map((person) => ({
			kind: 'human' as const,
			name: person.name,
			identity: person.identity,
			presence: person.presence,
		})),
	];
}

function agentsOf(
	facts: Pick<RoomFacts, 'state' | 'live'>,
): Extract<ContextParticipant, { kind: 'agent' }>[] {
	return facts.state.roster.map((seat) => ({
		kind: 'agent',
		name: seat.name,
		identity: seat.identity,
		status: facts.live.has(seat.name) ? 'active' : 'idle',
		attention: seat.attention,
		assistant: seat.name === facts.state.composition?.assistant,
	}));
}

/** Select collaboration facts without reading an executable agent definition. */
export function viewOf(spec: ActivationSpec, facts: RoomFacts): ActivationView {
	const state = facts.state;
	const purpose = spec.purpose;
	const goal = state.composition?.goal;
	const messages =
		purpose.kind === 'summarize'
			? state.messages.filter(
					(message) => message.seq >= purpose.exchange && message.seq <= purpose.through,
				)
			: state.messages;
	const context: CollaborationContext = {
		name: facts.name,
		now: facts.now,
		...(goal === undefined ? {} : { goal }),
		participants: [...agentsOf(facts), ...peopleOf(facts)],
		messages: messages.map(contextMessage),
		...(purpose.kind !== 'respond' || state.exchange === undefined
			? {}
			: { exchange: { owner: state.exchange.owner, from: state.exchange.from } }),
		...purposeContext(purpose, state),
	};
	// In-process executors receive the same detached snapshot as remote executors.
	return structuredClone({
		spec,
		through: purpose.kind === 'summarize' ? purpose.through : state.lastSeq,
		context,
	});
}

/** Reading preferences enter context only through the recipient's summary purpose. */
function contextMessage(message: Message): Message {
	if (!('preferences' in message)) return message;
	const publicMessage = { ...message };
	delete publicMessage.preferences;
	return publicMessage;
}

/** Only the relevant assistant purpose receives reserve identities or reading preferences. */
function purposeContext(
	purpose: ActivationPurpose,
	state: RoomState,
): Pick<CollaborationContext, 'reserve' | 'preferences'> {
	if (purpose.kind === 'select') {
		return { reserve: state.reserve.map(({ name, identity }) => ({ name, identity })) };
	}
	const preferences =
		purpose.kind === 'summarize' ? state.people.get(purpose.person)?.preferences : undefined;
	return preferences === undefined ? {} : { preferences };
}

/** Public human facts and recorded reading progress, without private preferences. */
function peopleOf(facts: RoomFacts): Extract<ContextParticipant, { kind: 'human' }>[] {
	return [...facts.state.people.values()].map((person) => ({
		kind: 'human',
		name: person.name,
		identity: person.identity,
		presence: person.presence,
		...(person.changedAt === undefined ? {} : { changedAt: person.changedAt }),
		...(person.since === undefined ? {} : { since: person.since }),
		unseen: person.since === undefined ? 0 : facts.unseen(person.since),
	}));
}
