/** Pure commands and committed events for a room. */

import type { Bodies, Body, Entry, Kind } from '../journal/journal.ts';
import type { Message, PresenceMessage } from '../types.ts';
import type { Close, Commit, Composition, EndReason } from '../wire.ts';
import {
	applyEvent,
	baseOf,
	checkpointOf,
	type FoldOptions,
	project,
	type RoomState,
} from './fold.ts';
import { isExpired, isLive, parseId, seatOf } from './lease.ts';
import {
	liveWork,
	planReconciliation,
	type ReconcileOptions,
	type Reconciliation,
} from './reconcile.ts';
import { routes } from './routing.ts';

/** A committed event includes the position assigned by the journal. */
export type RoomEvent = Entry;

type ProposedEvent<K extends Kind = Kind> = {
	[P in K]: { kind: P; body: Bodies[P] };
}[K];

type PresenceChange = Omit<PresenceMessage, 'seq' | 'key' | 'at' | 'wakes'>;
type MessageCommand =
	| { type: 'deliver'; from: string; to?: string; text: string }
	| { type: 'presence'; change: PresenceChange; route: boolean }
	| { type: 'commit'; commit: Commit };
type LeaseCommand =
	| { type: 'claim'; id: string; expiry: number; deadline: number }
	| { type: 'end'; id: string; reason: EndReason };
type ComposeCommand = { type: 'compose'; composition: Body<Composition> };
type CloseCommand = { type: 'close'; close: Close };
type RunCommand = { type: 'run' };
type CheckpointCommand = { type: 'checkpoint'; since: number; every: number };
type ReconcileCommand = { type: 'reconcile'; options: Omit<ReconcileOptions, 'now'> };

export type RoomCommand =
	| MessageCommand
	| LeaseCommand
	| ComposeCommand
	| CloseCommand
	| RunCommand
	| CheckpointCommand
	| ReconcileCommand;

export type Refusal =
	{ category: 'stale' | 'refused'; reason: string } | { category: 'missed'; missed: Message[] };

export type RoomDecision<K extends Kind> =
	{ event: ProposedEvent<K> | undefined } | { refusal: Refusal };

export type ReconcileDecision = {
	events: ProposedEvent<'lease' | 'close'>[];
	effects: Omit<Reconciliation, 'expired' | 'abandoned' | 'close'>;
};

/** Live application and replay use the same event rules. */
export function evolve(state: RoomState, event: RoomEvent, options: FoldOptions): RoomState {
	const base = baseOf(state);
	applyEvent(base, event);
	return project(base, options);
}

export function decide(
	state: RoomState,
	command: MessageCommand,
	now: number,
): RoomDecision<'message'>;
export function decide(state: RoomState, command: LeaseCommand, now: number): RoomDecision<'lease'>;
export function decide(
	state: RoomState,
	command: ComposeCommand,
	now: number,
): RoomDecision<'composition'>;
export function decide(state: RoomState, command: CloseCommand, now: number): RoomDecision<'close'>;
export function decide(state: RoomState, command: RunCommand, now: number): RoomDecision<'run'>;
export function decide(
	state: RoomState,
	command: CheckpointCommand,
	now: number,
): RoomDecision<'checkpoint'>;
export function decide(state: RoomState, command: ReconcileCommand, now: number): ReconcileDecision;
/** Decide against the state read inside the journal's write queue. Time is an explicit input. */
export function decide(
	state: RoomState,
	command: RoomCommand,
	now: number,
): RoomDecision<Kind> | ReconcileDecision {
	switch (command.type) {
		case 'deliver':
			return deliver(state, command, now);
		case 'presence':
			return presence(state, command, now);
		case 'commit':
			return commit(state, command.commit, now);
		case 'claim':
			return claim(state, command, now);
		case 'end':
			return end(state, command, now);
		case 'compose':
			return compose(state, command.composition);
		case 'close':
			return {
				event:
					state.exchange?.from === command.close.from
						? { kind: 'close', body: command.close }
						: undefined,
			};
		case 'run':
			return { event: { kind: 'run', body: { at: iso(now) } } };
		case 'checkpoint':
			return checkpoint(state, command, now);
		case 'reconcile':
			return reconcile(state, command, now);
	}
}

function checkpoint(
	state: RoomState,
	command: CheckpointCommand,
	now: number,
): RoomDecision<'checkpoint'> {
	if (command.since < command.every) return { event: undefined };
	const body = checkpointOf(state, now);
	return { event: body === undefined ? undefined : { kind: 'checkpoint', body } };
}

const iso = (now: number): string => new Date(now).toISOString();
const refused = (reason: string): { refusal: Refusal } => ({
	refusal: { category: 'refused', reason },
});
const stale = (reason: string): { refusal: Refusal } => ({
	refusal: { category: 'stale', reason },
});

/** Routing is part of the accepted event, so dispatch can recover from the record. */
function message(
	state: RoomState,
	body: Body<Message>,
	now: number,
	route = true,
): RoomDecision<'message'> {
	const wakes = route ? routes(body, state, liveWork(state, now).seats) : [];
	return {
		event: { kind: 'message', body: { ...body, ...(wakes.length === 0 ? {} : { wakes }) } },
	};
}

function deliver(
	state: RoomState,
	command: Extract<MessageCommand, { type: 'deliver' }>,
	now: number,
): RoomDecision<'message'> {
	const { from, to, text } = command;
	const target = state.roster.find((seat) => seat.name === to);
	if (to !== undefined && !state.people.has(to) && target === undefined) {
		return refused(`Cannot direct a delivery to '${to}': not in this session.`);
	}
	if (target?.attention === 'none') {
		return refused(`Cannot direct a delivery to '${to}': it wakes for nothing said.`);
	}
	return message(
		state,
		{ kind: 'said', at: iso(now), from, ...(to === undefined ? {} : { to }), text },
		now,
	);
}

function presence(
	state: RoomState,
	command: Extract<MessageCommand, { type: 'presence' }>,
	now: number,
): RoomDecision<'message'> {
	const reason = presenceRefusal(state, command.change);
	if (reason !== undefined) return refused(reason);
	return message(state, { ...command.change, at: iso(now) }, now, command.route);
}

function presenceRefusal(state: RoomState, change: PresenceChange): string | undefined {
	const seat = state.roster.find((candidate) => candidate.name === change.subject);
	if (change.kind === 'seated' && (seat !== undefined || state.people.has(change.subject))) {
		return `Duplicate agent name '${change.subject}': one name names one participant.`;
	}
	if (change.kind === 'unseated') return unseatRefusal(seat, change.subject);
	if (change.kind === 'arrived') return arrivalRefusal(state, change);
	return undefined;
}

function unseatRefusal(
	seat: RoomState['roster'][number] | undefined,
	name: string,
): string | undefined {
	if (seat === undefined) return `'${name}' is not seated in this session.`;
	if (seat.role !== undefined) {
		return `'${name}' holds the role '${seat.role.name}': a role is a seating choice, so the next composition decides it.`;
	}
	return undefined;
}

function arrivalRefusal(state: RoomState, change: PresenceChange): string | undefined {
	const name = change.subject;
	if ([...state.roster, ...state.reserve].some((seat) => seat.name === name)) {
		return `'${name}' is an agent in this session: one name names one participant.`;
	}
	const known = state.people.get(name);
	if (known?.presence === 'present' && known.identity !== change.identity) {
		return `'${name}' is already in this session under a different identity: one name is one person.`;
	}
	return undefined;
}

function commit(state: RoomState, request: Commit, now: number): RoomDecision<'message'> {
	const seat = seatOf(request.activation);
	const held = state.leases.get(request.activation);
	if (
		seat === undefined ||
		held === undefined ||
		!isLive(held, now) ||
		!state.roster.some((candidate) => candidate.name === seat)
	) {
		return stale('the lease ended');
	}
	const { intent } = request;
	const readThrough = request.readThrough;
	if (intent.kind !== 'summary' && readThrough !== undefined && state.lastSeq > readThrough) {
		return {
			refusal: {
				category: 'missed',
				missed: state.messages.filter((entry) => entry.seq > readThrough),
			},
		};
	}
	const stamp = { at: iso(now), activationId: request.activation, from: seat };
	if (intent.kind === 'seated') return seating(state, intent.name, stamp, now);
	if (intent.kind === 'summary')
		return summary(state, request.activation, seat, intent, stamp, now);
	const reason = addressRefusal(state, seat, intent.to);
	return reason === undefined ? message(state, { ...intent, ...stamp }, now) : refused(reason);
}

function summary(
	state: RoomState,
	id: string,
	seat: string,
	intent: Extract<Commit['intent'], { kind: 'summary' }>,
	stamp: { at: string; activationId: string; from: string },
	now: number,
): RoomDecision<'message'> {
	const parsed = parseId(id);
	const position = parsed?.position;
	const close = state.closes.find((candidate) => candidate.through === position);
	if (
		parsed?.cause !== 'closed' ||
		close === undefined ||
		close.wakes?.[0] !== seat ||
		close.owner !== intent.to ||
		close.from !== intent.covers.from ||
		close.through !== intent.covers.through
	)
		return refused('This summary does not match its closed exchange.');
	if (
		state.messages.some(
			(message) =>
				message.kind === 'summary' &&
				message.to === close.owner &&
				message.covers.from <= close.from &&
				message.covers.through >= close.through,
		)
	)
		return refused('This exchange already has a summary.');
	return message(state, { ...intent, ...stamp }, now);
}

function seating(
	state: RoomState,
	name: string,
	stamp: { at: string; activationId: string; from: string },
	now: number,
): RoomDecision<'message'> {
	const held = state.reserve.find((candidate) => candidate.name === name);
	if (held === undefined) {
		const names = state.reserve.map((candidate) => candidate.name);
		return refused(
			`'${name}' is not in the reserve. ` +
				(names.length ? `Seat one of: ${names.join(', ')}.` : 'The reserve is empty.'),
		);
	}
	return message(
		state,
		{
			kind: 'seated',
			...stamp,
			subject: held.name,
			identity: held.identity,
			attention: held.attention,
		},
		now,
	);
}

function addressRefusal(
	state: RoomState,
	seat: string,
	target: string | undefined,
): string | undefined {
	if (target === undefined) return undefined;
	const found = state.roster.find((candidate) => candidate.name === target);
	if (!state.people.has(target) && found === undefined)
		return `Unknown participant '${target}'. Address someone from the roster.`;
	if (target === seat) return 'You cannot address yourself.';
	return found?.attention === 'none'
		? `'${target}' wakes for nothing said. Say it to the room, or to somebody else.`
		: undefined;
}

function claim(
	state: RoomState,
	command: Extract<LeaseCommand, { type: 'claim' }>,
	now: number,
): RoomDecision<'lease'> {
	const seat = seatOf(command.id);
	if (!state.roster.some((candidate) => candidate.name === seat))
		return stale('the seat is not on the roster');
	const known = state.leases.get(command.id);
	if (known === undefined && !state.due.some((due) => due.id === command.id))
		return stale('the lease ended');
	if (known !== undefined && !isLive(known, now)) return stale('the lease ended');
	const claimedAt = known === undefined ? now : Date.parse(known.claimedAt);
	const expiry = Math.min(now + command.expiry, claimedAt + command.deadline);
	return {
		event: { kind: 'lease', body: { id: command.id, phase: 'running', expiry, at: iso(now) } },
	};
}

function end(
	state: RoomState,
	command: Extract<LeaseCommand, { type: 'end' }>,
	now: number,
): RoomDecision<'lease'> {
	const known = state.leases.get(command.id);
	const { reason } = command;
	if (known === undefined) {
		if (reason !== 'revoked' && reason !== 'abandoned') return { event: undefined };
	} else {
		if (known.phase === 'ended' || reason === 'abandoned') return { event: undefined };
		if (isExpired(known, now) !== (reason === 'expired')) return { event: undefined };
	}
	return {
		event: { kind: 'lease', body: { id: command.id, phase: 'ended', reason, at: iso(now) } },
	};
}

function compose(state: RoomState, composition: Body<Composition>): RoomDecision<'composition'> {
	const names = new Set<string>();
	for (const seat of [...composition.agents, ...composition.available]) {
		if (names.has(seat.name) || state.people.has(seat.name))
			return refused(`Duplicate agent name '${seat.name}': one name names one participant.`);
		names.add(seat.name);
	}
	return { event: { kind: 'composition', body: composition } };
}

function reconcile(state: RoomState, command: ReconcileCommand, now: number): ReconcileDecision {
	const { expired, abandoned, close, ...effects } = planReconciliation(state, {
		...command.options,
		now,
	});
	return {
		events: [
			...[...expired, ...abandoned].map((body) => ({ kind: 'lease' as const, body })),
			...(close === undefined ? [] : [{ kind: 'close' as const, body: close }]),
		],
		effects,
	};
}
