/** Pure collaboration context derived from the room projection. */

import type {
	ActivationPurpose,
	ActivationSpec,
	ActivationView,
	CollaborationContext,
	ContextParticipant,
	ViewRange,
} from '../protocol.ts';
import type { AgentParticipantInfo, ParticipantInfo, Seq } from '../types.ts';
import { isSummary, type Message } from '../types.ts';
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
export function participantsOf(facts: Pick<RoomFacts, 'state' | 'live'>): ParticipantInfo[] {
	return [
		...agentsOf(facts),
		...[...facts.state.people.values()].map((person) => ({
			kind: 'human' as const,
			name: person.name,
			identity: person.identity,
			presence: person.presence,
		})),
	];
}

function agentsOf(facts: Pick<RoomFacts, 'state' | 'live'>): AgentParticipantInfo[] {
	return facts.state.roster.map((seat) => ({
		kind: 'agent',
		name: seat.name,
		identity: seat.identity,
		status: facts.live.has(seat.name) ? 'active' : 'idle',
		attention: seat.attention,
	}));
}

/** Select collaboration facts without reading an executable agent definition. */
export function viewOf(spec: ActivationSpec, facts: RoomFacts, range?: ViewRange): ActivationView {
	const state = facts.state;
	const purpose = spec.purpose;
	const goal = state.composition?.goal;
	// A summary reads every message through its closed exchange, background and
	// current alike; what it covers stays fixed to its own exchange. An ordinary
	// response reads the whole record instead. Either may read one bounded page
	// of its record rather than the whole of it. A malformed range reads the
	// whole record, because a seat's request is data.
	const bounded =
		purpose.kind === 'summarize'
			? state.messages.filter((message) => message.seq <= purpose.through)
			: state.messages;
	const page = range !== undefined && validRange(range) ? range : undefined;
	const messages = page !== undefined ? pageOf(bounded, page) : bounded;
	const context: CollaborationContext = {
		name: facts.name,
		now: facts.now,
		...(goal === undefined ? {} : { goal }),
		participants: [...agentsOf(facts), ...peopleOf(facts)],
		messages: messages.map(contextMessage),
		reserve: state.reserve.map(({ name, identity }) => ({ name, identity })),
		...(purpose.kind !== 'respond' || state.exchange === undefined
			? {}
			: { exchange: { owner: state.exchange.owner, from: state.exchange.from } }),
		...earliestOf(page !== undefined, state.messages),
		...purposeContext(purpose, state),
	};
	// In-process executors receive the same detached snapshot as remote executors.
	return structuredClone({
		spec,
		through: purpose.kind === 'summarize' ? purpose.through : state.lastSeq,
		context,
	});
}

/** A well-formed page request: a positive limit, and a non-negative cursor. */
function validRange(range: ViewRange): boolean {
	if (!Number.isSafeInteger(range.limit) || range.limit <= 0) return false;
	return range.before === undefined || (Number.isSafeInteger(range.before) && range.before >= 0);
}

/** The record floor, reported only for a bounded page, so a seat can stop paging. */
function earliestOf(paged: boolean, messages: readonly Message[]): { earliest?: Seq } {
	const first = messages[0];
	return paged && first !== undefined ? { earliest: first.seq } : {};
}

/**
 * One bounded page of the record: the last `limit` messages before the cursor.
 * The floor moves up past a range this page would split, so the page never
 * renders a fold with a wrong count. A range this page holds no summary for
 * stays whole when the seat pages to it; the seat assembles the pages.
 */
function pageOf(messages: readonly Message[], range: ViewRange): Message[] {
	const before = range.before ?? Number.POSITIVE_INFINITY;
	const upto = messages.filter((message) => message.seq < before);
	const first = upto[Math.max(0, upto.length - range.limit)];
	if (first === undefined) return [];
	const floor = foldAlignedFloor(upto, first.seq);
	return upto.filter((message) => message.seq >= floor);
}

/**
 * A page floor that never splits a covered range. A fold that holds part of a
 * summarised range renders a wrong count, so a floor inside a range moves up
 * past it. The summary sits after its range, so the page still holds it and it
 * stands for the whole range. A summary covers a disjoint range, so one pass
 * finds the range that straddles the floor.
 */
function foldAlignedFloor(messages: readonly Message[], floor: Seq): Seq {
	let aligned = floor;
	for (const message of messages) {
		if (!isSummary(message)) continue;
		if (message.covers.from < aligned && message.covers.through >= aligned)
			aligned = message.covers.through + 1;
	}
	return aligned;
}

/** Reading preferences enter context only through the recipient's summary purpose. */
function contextMessage(message: Message): Message {
	if (!('preferences' in message)) return message;
	const publicMessage = { ...message };
	delete publicMessage.preferences;
	return publicMessage;
}

/** Only the summary purpose receives reading preferences. */
function purposeContext(
	purpose: ActivationPurpose,
	state: RoomState,
): Pick<CollaborationContext, 'preferences'> {
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
