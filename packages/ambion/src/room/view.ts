/** Pure collaboration context derived from the room projection. */

import type {
	ActivationPurpose,
	ActivationSpec,
	ActivationView,
	CollaborationContext,
	ContextParticipant,
} from '../protocol.ts';
import { type Block, blocks, renderLine } from '../record.ts';
import type { AgentParticipant, ExchangeRef, Participant, Seq } from '../types.ts';
import { isSummary, type Message } from '../types.ts';
import type { RoomState } from './fold.ts';

/** The token limit of one seat, and the estimator that counts against it. */
export interface TokenWindow {
	readonly limit: number;
	readonly estimate: (text: string) => number;
}

/**
 * The bounds of one view beyond the pinned exchange: the most messages the
 * room serves, and the token limit of the seat, when it has one.
 */
interface ViewLimits {
	readonly messages: number;
	readonly tokens?: TokenWindow;
}

/** What the view is built from: the fold and current host facts. */
export interface RoomFacts {
	readonly name: string;
	readonly now: number;
	readonly state: RoomState;
	/** The seats live now, by name, with the ids that make them live. */
	readonly live: ReadonlyMap<string, string[]>;
	/** The cap of the room and the token limit of the seat. Absent means no bound. */
	readonly limits?: ViewLimits;
	/** How many messages landed after this seq. */
	messagesSince(seq: Seq): number;
}

/** The roster and people returned by the public participants query. */
export function participantsOf(facts: Pick<RoomFacts, 'state' | 'live'>): Participant[] {
	return [
		...agentsOf(facts),
		...[...facts.state.people.values()].map((person) => ({
			kind: 'person' as const,
			name: person.name,
			identity: person.identity,
			presence: person.presence,
		})),
	];
}

function agentsOf(facts: Pick<RoomFacts, 'state' | 'live'>): AgentParticipant[] {
	return facts.state.roster.map((seat) => ({
		kind: 'agent',
		name: seat.name,
		identity: seat.identity,
		status: facts.live.has(seat.name) ? 'active' : 'idle',
		attention: seat.attention,
	}));
}

/** The seating facts that a seat reads, each set only when it differs from the default. */
function seatingFlags(
	composition: RoomState['composition'],
): Pick<CollaborationContext, 'seating' | 'reserved'> {
	return {
		...(composition?.seating === false ? { seating: false as const } : {}),
		...(composition?.reserved === true ? { reserved: true as const } : {}),
	};
}

/** Select collaboration facts without reading an executable agent definition. */
export function viewOf(spec: ActivationSpec, facts: RoomFacts, message?: Seq): ActivationView {
	const state = facts.state;
	const purpose = spec.purpose;
	const goal = state.composition?.goal;
	const seating = state.composition?.seating !== false;
	// A summary reads every message through its closed exchange, background and
	// current alike; what it covers stays fixed to its own exchange. A respond
	// activation reads the whole record instead. The room windows that record to
	// its cap and to the token limit of the seat. A view of one message reads
	// it by its seq under the purpose alone, so `recall` reaches below the
	// window.
	const bounded =
		purpose.kind === 'summarize'
			? state.messages.filter((item) => item.seq <= purpose.through)
			: state.messages;
	const pin = purpose.kind === 'respond' ? state.exchange?.from : purpose.exchange;
	const messages =
		message === undefined
			? windowOf(bounded, facts.limits, pin)
			: bounded.filter((item) => item.seq === message);
	const context: CollaborationContext = {
		name: facts.name,
		now: facts.now,
		...(goal === undefined ? {} : { goal }),
		participants: [...agentsOf(facts), ...peopleOf(facts)],
		messages: messages.map(contextMessage),
		reserve: seating ? state.reserve.map(({ name, identity }) => ({ name, identity })) : [],
		...seatingFlags(state.composition),
		...(purpose.kind !== 'respond' || state.exchange === undefined
			? {}
			: { exchange: exchangeContext(state.exchange) }),
		...(message === undefined ? omittedOf(bounded, messages) : {}),
		...purposeContext(purpose, state),
		...scheduledOf(spec, state),
	};
	// In-process executors receive the same detached snapshot as remote executors.
	return structuredClone({
		spec,
		through: purpose.kind === 'summarize' ? purpose.through : state.lastSeq,
		context,
	});
}

/** The says of the seat that wait to return. A summary activation reads none. */
function scheduledOf(
	spec: ActivationSpec,
	state: RoomState,
): Pick<CollaborationContext, 'scheduled'> {
	if (spec.purpose.kind !== 'respond') return {};
	const own = state.scheduled.filter((say) => say.seat === spec.seat);
	return own.length === 0 ? {} : { scheduled: own };
}

/**
 * How many messages the window leaves out. A window is a tail of the record
 * it reads, so the count is the difference in length. Absent when none.
 */
function omittedOf(
	bounded: readonly Message[],
	messages: readonly Message[],
): Pick<CollaborationContext, 'omitted'> {
	const omitted = bounded.length - messages.length;
	return omitted === 0 ? {} : { omitted };
}

/**
 * The one windowing rule of the record: the room cap, then the token limit
 * of the seat inside it. Each keeps the newest messages, never splits a
 * summarised range, and keeps every message at or after the pin, so the open
 * exchange stays whole.
 */
function windowOf(
	messages: readonly Message[],
	limits: ViewLimits | undefined,
	pin: Seq | undefined,
): Message[] {
	const capped = capOf(messages, limits?.messages, pin);
	return limits?.tokens === undefined ? capped : tokensOf(capped, limits.tokens, pin);
}

/**
 * The newest `cap` messages of the record. The floor moves past a summarised
 * range it would split, and down to the pin, so the open exchange stays whole.
 */
function capOf(
	messages: readonly Message[],
	cap: number | undefined,
	pin: Seq | undefined,
): Message[] {
	if (cap === undefined || !Number.isFinite(cap) || messages.length <= cap) return [...messages];
	const first = messages[messages.length - cap];
	if (first === undefined) return [...messages];
	let floor = foldAlignedFloor(messages, first.seq);
	if (pin !== undefined && pin < floor) floor = pin;
	return messages.filter((message) => message.seq >= floor);
}

/**
 * The newest blocks whose estimated tokens stay within the limit, and never
 * fewer than one block, so an activation always reads the latest exchange.
 * The walk runs over blocks, so a summarised range counts once, as the line
 * of its summary, and is never split. The floor moves down to the pin.
 */
function tokensOf(
	messages: readonly Message[],
	window: TokenWindow,
	pin: Seq | undefined,
): Message[] {
	const all = blocks(messages);
	const newest = all.at(-1);
	if (newest === undefined) return [];
	let cost = 0;
	let cut = newest;
	for (let index = all.length - 1; index >= 0; index -= 1) {
		const block = all[index];
		if (block === undefined) break;
		cost += window.estimate(renderLine('fold' in block ? block.by : block.line));
		if (cost > window.limit) break;
		cut = block;
	}
	let floor = firstSeq(cut);
	if (pin !== undefined && pin < floor) floor = pin;
	return messages.filter((message) => message.seq >= floor);
}

/** The lowest seq one block stands for. */
function firstSeq(block: Block): Seq {
	return 'fold' in block ? Math.min(...block.fold.map((message) => message.seq)) : block.line.seq;
}

/**
 * A cap floor that never splits a covered range. A fold that holds part of a
 * summarised range renders a wrong count, so a floor inside a range moves up
 * past it. The summary sits after its range, so the view still holds it and it
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
function peopleOf(facts: RoomFacts): Extract<ContextParticipant, { kind: 'person' }>[] {
	return [...facts.state.people.values()].map((person) => ({
		kind: 'person',
		name: person.name,
		identity: person.identity,
		presence: person.presence,
		...(person.changedAt === undefined ? {} : { changedAt: person.changedAt }),
		...(person.lastDeparture === undefined ? {} : { lastDeparture: person.lastDeparture }),
		messagesSinceDeparture:
			person.lastDeparture === undefined ? 0 : facts.messagesSince(person.lastDeparture),
	}));
}

/** The open exchange as an activation reads it: its start, and its person once one spoke. */
function exchangeContext({ person, from }: ExchangeRef): { person?: string; from: Seq } {
	return { ...(person === undefined ? {} : { person }), from };
}
