/** Pure commands and committed events for a room. */

import { decodeActivationId } from '../activation-id.ts';
import type { Close, Composition } from '../journal/events.ts';
import type { Bodies, Body, Entry, Kind } from '../journal/journal.ts';
import type { ActivationSpec, CommitRequest } from '../protocol.ts';
import type { EndReason, Message, PresenceMessage } from '../types.ts';
import { activationSpec } from './activation.ts';
import { applyEvent, baseOf, type FoldOptions, project, type RoomState } from './fold.ts';
import { isExpired, isLive } from './lease.ts';
import {
	liveWork,
	planReconciliation,
	type ReconcileOptions,
	type Reconciliation,
} from './reconcile.ts';
import { routes } from './routing.ts';
import {
	acknowledged,
	addressesOwner,
	addressOutcome,
	admitsClose,
	admitsLease,
	commitAuthority,
	coversExchange,
	distinct,
	speechFreshness as freshnessRule,
	hostMembership,
	leaseExpiry,
	mayEnd,
	membershipOutcome,
	onRecord,
	onRoster,
	permits,
	presenceOutcome,
	present,
	stampedSummary,
} from './rules.verified.ts';

/** A committed event includes the position assigned by the journal. */
export type RoomEvent = Entry;

type ProposedEvent<K extends Kind = Kind> = {
	[P in K]: { kind: P; body: Bodies[P] };
}[K];

type PresenceChange = Omit<PresenceMessage, 'seq' | 'key' | 'at' | 'wakes'>;
type MessageCommand =
	| { type: 'deliver'; from: string; to?: string; text: string }
	| { type: 'presence'; change: PresenceChange; route: boolean }
	| { type: 'commit'; commit: CommitRequest };
type LeaseCommand =
	| { type: 'claim'; id: string; expiry: number; deadline: number }
	| { type: 'renew'; id: string; expiry: number; deadline: number; readThrough?: number }
	| { type: 'end'; id: string; reason: EndReason; readThrough: number };
type ComposeCommand = { type: 'compose'; composition: Body<Composition> };
type CloseCommand = { type: 'close'; close: Close };
type RunCommand = { type: 'run' };
type CancelCommand = { type: 'cancel' };
type ReconcileCommand = { type: 'reconcile'; options: Omit<ReconcileOptions, 'now'> };

export type RoomCommand =
	| MessageCommand
	| LeaseCommand
	| ComposeCommand
	| CloseCommand
	| RunCommand
	| CancelCommand
	| ReconcileCommand;

export type Refusal =
	{ category: 'stale' | 'refused'; reason: string } | { category: 'missed'; missed: Message[] };

export type RoomDecision<K extends Kind> =
	| { event: ProposedEvent<K> | undefined }
	| { refusal: Refusal }
	| { unchanged: { kind: 'seated' | 'unseated'; name: string } };

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
	command: CancelCommand,
	now: number,
): RoomDecision<'cancel'>;
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
		case 'renew':
			return renew(state, command, now);
		case 'end':
			return end(state, command, now);
		case 'compose':
			return compose(state, command.composition);
		case 'close':
			return {
				event: admitsClose(
					state.exchange,
					command.close,
					state.lastSeq,
					liveWork(state, now).exchange,
				)
					? { kind: 'close', body: command.close }
					: undefined,
			};
		case 'run':
			return { event: { kind: 'run', body: { at: iso(now) } } };
		case 'cancel':
			return {
				event: {
					kind: 'cancel',
					body: {
						at: iso(now),
						...(state.exchange === undefined
							? {}
							: {
									close: {
										owner: state.exchange.owner,
										from: state.exchange.from,
										through: state.lastSeq,
										at: iso(now),
									},
								}),
					},
				},
			};
		case 'reconcile':
			return reconcile(state, command, now);
	}
}

/** Select one recorded work item for a planned stop, including expired leases. */
export function stopWork(state: RoomState, now: number): RoomDecision<'lease'> {
	const running = [...state.leases.values()].find((lease) => lease.phase === 'running');
	const id = running?.id ?? state.due[0]?.id;
	return id === undefined
		? { event: undefined }
		: end(state, { type: 'end', id, reason: 'revoked', readThrough: 0 }, now);
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
	if ((body.kind === 'said' || body.kind === 'summary') && body.text.trim() === '') {
		return refused('The message is empty. Say something, or end your turn instead.');
	}
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
	if (!present(state.people.get(from))) return refused(`'${from}' is not present in this room.`);
	const target = to === undefined ? undefined : state.roster.find((seat) => seat.name === to);
	const outcome = addressOutcome(
		to !== undefined,
		to !== undefined && (state.people.has(to) || target !== undefined),
		false,
		target?.attention,
	);
	if (outcome === 'unknown')
		return refused(`Cannot direct a delivery to '${to}': not in this room.`);
	if (outcome === 'unreachable')
		return refused(`Cannot direct a delivery to '${to}': it wakes for nothing said.`);
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
	const { change } = command;
	if (change.kind === 'seated' || change.kind === 'unseated') {
		const reason = membershipRefusal(state, change.kind, change.subject);
		if (reason !== undefined) return refused(reason);
		return message(state, { ...change, at: iso(now) }, now, command.route);
	}
	const known = state.people.get(change.subject);
	const agentName = [...state.roster, ...state.reserve].some(
		(seat) => seat.name === change.subject,
	);
	const outcome = presenceOutcome(
		change.kind,
		agentName,
		present(known),
		known !== undefined && known.identity === change.identity,
	);
	if (outcome === 'refused') return refused(arrivalRefusal(change.subject, agentName));
	if (outcome === 'unchanged') return { event: undefined };
	return message(state, { ...change, at: iso(now) }, now, command.route);
}

/** The host's seating or unseating: the rule admits it, or this names why not. */
function membershipRefusal(
	state: RoomState,
	kind: 'seated' | 'unseated',
	name: string,
): string | undefined {
	if (hostMembership(kind, onRoster(state.roster, name), state.people.has(name))) return undefined;
	return kind === 'seated'
		? `Duplicate agent name '${name}': one name names one participant.`
		: `'${name}' is not seated in this room.`;
}

function arrivalRefusal(name: string, agentName: boolean): string {
	return agentName
		? `'${name}' is an agent in this room: one name names one participant.`
		: `'${name}' is already in this room under a different identity: one name is one person.`;
}

function commit(state: RoomState, request: CommitRequest, now: number): RoomDecision<'message'> {
	const spec = activationSpec(request.activation, state);
	const live = liveSpec(state, request.activation, spec, now);
	if ('refusal' in live) return live;
	const { intent } = request;
	if (!permits(live.purpose.kind, intent.kind))
		return refused('This activation cannot submit that intent.');
	const purpose = live.purpose;
	if (intent.kind === 'said' && purpose.kind === 'summarize')
		return closingCommit(state, request, live, purpose, now);
	return ordinaryCommit(state, request, live, now);
}

function closingCommit(
	state: RoomState,
	request: CommitRequest,
	live: ActivationSpec,
	purpose: Extract<ActivationSpec['purpose'], { kind: 'summarize' }>,
	now: number,
): RoomDecision<'message'> {
	const intent = request.intent;
	if (intent.kind !== 'said') return refused('This activation cannot submit that intent.');
	if (!addressesOwner(intent.to, purpose.person))
		return refused('A closing response must address the exchange owner.');
	if (state.messages.some((entry) => isCoveringSummary(entry, purpose)))
		return refused('This exchange already has a summary.');
	return message(
		state,
		{
			kind: 'summary',
			text: intent.text,
			...stampedSummary(purpose.person, purpose.exchange, purpose.through),
			at: iso(now),
			activationId: request.activation,
			from: live.seat,
		},
		now,
	);
}

function ordinaryCommit(
	state: RoomState,
	request: CommitRequest,
	live: ActivationSpec,
	now: number,
): RoomDecision<'message'> {
	const { intent } = request;
	const fresh = speechFreshness(state, request);
	if (fresh !== undefined) return fresh;
	const stamp = { at: iso(now), activationId: request.activation, from: live.seat };
	if (intent.kind === 'seated') return seating(state, intent.name, stamp, now);
	if (intent.kind === 'unseated') return unseating(state, intent.name, stamp, now);
	const reason = addressRefusal(state, live.seat, intent.to);
	return reason === undefined ? message(state, { ...intent, ...stamp }, now) : refused(reason);
}

function isCoveringSummary(
	message: Message,
	purpose: Extract<ActivationSpec['purpose'], { kind: 'summarize' }>,
): boolean {
	return (
		message.kind === 'summary' &&
		coversExchange(
			message.to,
			message.covers.from,
			message.covers.through,
			purpose.person,
			purpose.exchange,
			purpose.through,
		)
	);
}

function liveSpec(
	state: RoomState,
	id: string,
	spec: ActivationSpec | undefined,
	now: number,
): ActivationSpec | { refusal: Refusal } {
	const held = state.leases.get(id);
	const authority = commitAuthority(
		held?.phase,
		held !== undefined && isExpired(held, now),
		spec !== undefined,
	);
	if (authority === 'stale') return stale('the lease ended');
	// The grant already holds the seat on the roster. The re-test narrows the type only.
	if (authority === 'refused' || spec === undefined)
		return refused('This activation has no room grant.');
	return spec;
}

function speechFreshness(
	state: RoomState,
	request: CommitRequest,
): RoomDecision<'message'> | undefined {
	if (request.intent.kind !== 'said') return undefined;
	// The wire guard stays here: a Dafny int has no fraction and no NaN.
	const readThrough = safePosition(request.readThrough);
	const freshness = freshnessRule(readThrough, state.lastSeq);
	if (readThrough === undefined || freshness === 'invalid')
		return refused('A spoken message must state a current record position.');
	return freshness === 'missed'
		? {
				refusal: {
					category: 'missed',
					missed: state.messages.filter((entry) => entry.seq > readThrough),
				},
			}
		: undefined;
}

/** A number off the wire that a rule may read: a safe integer, or nothing. */
function safePosition(value: number | undefined): number | undefined {
	return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function validReadThrough(readThrough: number | undefined, lastSeq: number): readThrough is number {
	const position = safePosition(readThrough);
	return position !== undefined && onRecord(position, lastSeq);
}

function seating(
	state: RoomState,
	name: string,
	stamp: { at: string; activationId: string; from: string },
	now: number,
): RoomDecision<'message'> {
	const held = state.reserve.find((candidate) => candidate.name === name);
	const outcome = membershipOutcome('seated', onRoster(state.roster, name), held !== undefined);
	if (outcome === 'unchanged') return { unchanged: { kind: 'seated', name } };
	// A written outcome has a reserve seat. The re-test narrows the type only.
	if (outcome === 'refused' || held === undefined) {
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

function unseating(
	state: RoomState,
	name: string,
	stamp: { at: string; activationId: string; from: string },
	now: number,
): RoomDecision<'message'> {
	const outcome = membershipOutcome(
		'unseated',
		onRoster(state.roster, name),
		state.reserve.some((seat) => seat.name === name),
	);
	if (outcome === 'unchanged') return { unchanged: { kind: 'unseated', name } };
	if (outcome === 'refused') return refused(`'${name}' is not an agent in this room.`);
	return message(state, { kind: 'unseated', subject: name, ...stamp }, now);
}

function addressRefusal(
	state: RoomState,
	seat: string,
	target: string | undefined,
): string | undefined {
	const found =
		target === undefined ? undefined : state.roster.find((candidate) => candidate.name === target);
	const outcome = addressOutcome(
		target !== undefined,
		target !== undefined && (state.people.has(target) || found !== undefined),
		target !== undefined && target === seat,
		found?.attention,
	);
	if (outcome === 'ok') return undefined;
	if (outcome === 'unknown')
		return `Unknown participant '${target}'. Address someone from the roster.`;
	if (outcome === 'self') return 'You cannot address yourself.';
	return `'${target}' wakes for nothing said. Say it to the room, or to somebody else.`;
}

function claim(
	state: RoomState,
	command: Extract<LeaseCommand, { type: 'claim' }>,
	now: number,
): RoomDecision<'lease'> {
	if (activationSpec(command.id, state) === undefined)
		return stale('the activation has no room grant');
	return runningLease(state, command, now, 0);
}

function renew(
	state: RoomState,
	command: Extract<LeaseCommand, { type: 'renew' }>,
	now: number,
): RoomDecision<'lease'> {
	const invalid = invalidProgress(state, command.readThrough);
	if (invalid !== undefined) return invalid;
	if (activationSpec(command.id, state) === undefined)
		return stale('the activation has no room grant');
	return runningLease(state, command, now, command.readThrough ?? 0);
}

function runningLease(
	state: RoomState,
	command: Extract<LeaseCommand, { type: 'claim' | 'renew' }>,
	now: number,
	readThrough: number,
): RoomDecision<'lease'> {
	const known = state.leases.get(command.id);
	const admission = admitsLease(
		command.type,
		known?.phase,
		known !== undefined && isLive(known, now),
		state.due.some((due) => due.id === command.id),
		seatHeld(state, command.id, now),
	);
	if (admission === 'ended') return stale('the lease ended');
	if (admission === 'held') return stale('another activation already holds this seat');
	const claimedAt = known === undefined ? now : Date.parse(known.claimedAt);
	return {
		event: {
			kind: 'lease',
			body: {
				id: command.id,
				phase: 'running',
				expiresAt: leaseExpiry(now, claimedAt, command.expiry, command.deadline),
				at: iso(now),
				readThrough: acknowledged(known?.readThrough, readThrough),
			},
		},
	};
}

const seatOfLease = (id: string): string | undefined => decodeActivationId(id)?.seat;

/** Another activation of the same seat holds a live lease. */
function seatHeld(state: RoomState, id: string, now: number): boolean {
	const seat = seatOfLease(id);
	return (
		seat !== undefined &&
		[...state.leases.values()].some(
			(lease) => lease.id !== id && seatOfLease(lease.id) === seat && isLive(lease, now),
		)
	);
}

function end(
	state: RoomState,
	command: Extract<LeaseCommand, { type: 'end' }>,
	now: number,
): RoomDecision<'lease'> {
	const invalid = invalidProgress(state, command.readThrough);
	if (invalid !== undefined) return invalid;
	const known = state.leases.get(command.id);
	const { reason } = command;
	if (!mayEnd(known?.phase, reason, known !== undefined && isExpired(known, now)))
		return { event: undefined };
	return {
		event: {
			kind: 'lease',
			body: {
				id: command.id,
				phase: 'ended',
				reason,
				at: iso(now),
				readThrough: acknowledged(known?.readThrough, command.readThrough),
			},
		},
	};
}

function invalidProgress(
	state: RoomState,
	readThrough: number | undefined,
): { refusal: Refusal } | undefined {
	return readThrough !== undefined && !validReadThrough(readThrough, state.lastSeq)
		? refused('The acknowledged context is not on this record.')
		: undefined;
}

function compose(state: RoomState, composition: Body<Composition>): RoomDecision<'composition'> {
	if (composition.version !== 2) return refused('This room requires composition version 2.');
	if (
		composition.summary !== undefined &&
		![...composition.agents, ...composition.available].some(
			(seat) => seat.name === composition.summary,
		)
	)
		return refused(`Summary writer '${composition.summary}' is not defined in this room.`);
	const names = [...composition.agents, ...composition.available].map((seat) => seat.name);
	if (!distinct(names) || names.some((name) => state.people.has(name))) {
		const taken =
			names.find((name, index) => names.indexOf(name) !== index || state.people.has(name)) ?? '';
		return refused(`Duplicate agent name '${taken}': one name names one participant.`);
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
			...effects.revoked.map((body) => ({ kind: 'lease' as const, body })),
			...[...expired, ...abandoned].map((body) => ({ kind: 'lease' as const, body })),
			...(close === undefined ? [] : [{ kind: 'close' as const, body: close }]),
		],
		effects,
	};
}
