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
import { acknowledged, leaseExpiry, mayEnd, permits } from './rules.verified.ts';

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
				event:
					state.exchange?.from === command.close.from &&
					state.lastSeq === command.close.through &&
					!liveWork(state, now).exchange
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
	const author = state.people.get(from);
	if (author?.presence !== 'present') return refused(`'${from}' is not present in this room.`);
	const target = state.roster.find((seat) => seat.name === to);
	if (to !== undefined && !state.people.has(to) && target === undefined) {
		return refused(`Cannot direct a delivery to '${to}': not in this room.`);
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
	const known = state.people.get(command.change.subject);
	if (
		(command.change.kind === 'arrived' && known?.presence === 'present') ||
		(command.change.kind === 'left' && known?.presence !== 'present')
	)
		return { event: undefined };
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
	if (seat === undefined) return `'${name}' is not seated in this room.`;
	return undefined;
}

function arrivalRefusal(state: RoomState, change: PresenceChange): string | undefined {
	const name = change.subject;
	if ([...state.roster, ...state.reserve].some((seat) => seat.name === name)) {
		return `'${name}' is an agent in this room: one name names one participant.`;
	}
	const known = state.people.get(name);
	if (known?.presence === 'present' && known.identity !== change.identity) {
		return `'${name}' is already in this room under a different identity: one name is one person.`;
	}
	return undefined;
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
	if (intent.to !== undefined && intent.to !== purpose.person)
		return refused('A closing response must address the exchange owner.');
	if (state.messages.some((entry) => isCoveringSummary(entry, purpose)))
		return refused('This exchange already has a summary.');
	return message(
		state,
		{
			kind: 'summary',
			text: intent.text,
			to: purpose.person,
			covers: { from: purpose.exchange, through: purpose.through },
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
		message.to === purpose.person &&
		message.covers.from <= purpose.exchange &&
		message.covers.through >= purpose.through
	);
}

function liveSpec(
	state: RoomState,
	id: string,
	spec: ActivationSpec | undefined,
	now: number,
): ActivationSpec | { refusal: Refusal } {
	const held = state.leases.get(id);
	if (held === undefined || !isLive(held, now)) return stale('the lease ended');
	if (spec === undefined) return refused('This activation has no room grant.');
	return state.roster.some((candidate) => candidate.name === spec.seat)
		? spec
		: stale('the lease ended');
}

function speechFreshness(
	state: RoomState,
	request: CommitRequest,
): RoomDecision<'message'> | undefined {
	if (request.intent.kind !== 'said') return undefined;
	const { readThrough } = request;
	if (!validReadThrough(readThrough, state.lastSeq))
		return refused('A spoken message must state a current record position.');
	return readThrough < state.lastSeq
		? {
				refusal: {
					category: 'missed',
					missed: state.messages.filter((entry) => entry.seq > readThrough),
				},
			}
		: undefined;
}

function validReadThrough(readThrough: number | undefined, lastSeq: number): readThrough is number {
	return (
		typeof readThrough === 'number' &&
		Number.isSafeInteger(readThrough) &&
		readThrough >= 0 &&
		readThrough <= lastSeq
	);
}

function seating(
	state: RoomState,
	name: string,
	stamp: { at: string; activationId: string; from: string },
	now: number,
): RoomDecision<'message'> {
	if (state.roster.some((seat) => seat.name === name)) {
		return { unchanged: { kind: 'seated', name } };
	}
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

function unseating(
	state: RoomState,
	name: string,
	stamp: { at: string; activationId: string; from: string },
	now: number,
): RoomDecision<'message'> {
	if (!state.roster.some((seat) => seat.name === name)) {
		return state.reserve.some((seat) => seat.name === name)
			? { unchanged: { kind: 'unseated', name } }
			: refused(`'${name}' is not an agent in this room.`);
	}
	return message(state, { kind: 'unseated', subject: name, ...stamp }, now);
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
	if (!state.leases.has(command.id)) return stale('the lease ended');
	return runningLease(state, command, now, command.readThrough ?? 0);
}

function runningLease(
	state: RoomState,
	command: Extract<LeaseCommand, { type: 'claim' | 'renew' }>,
	now: number,
	readThrough: number,
): RoomDecision<'lease'> {
	const known = state.leases.get(command.id);
	if (known === undefined && !state.due.some((due) => due.id === command.id))
		return stale('the lease ended');
	const seat = decodeActivationId(command.id)?.seat;
	if (
		known === undefined &&
		seat !== undefined &&
		[...state.leases.values()].some(
			(lease) => lease.id !== command.id && seatOfLease(lease.id) === seat && isLive(lease, now),
		)
	)
		return stale('another activation already holds this seat');
	if (known !== undefined && !isLive(known, now)) return stale('the lease ended');
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
			...effects.revoked.map((body) => ({ kind: 'lease' as const, body })),
			...[...expired, ...abandoned].map((body) => ({ kind: 'lease' as const, body })),
			...(close === undefined ? [] : [{ kind: 'close' as const, body: close }]),
		],
		effects,
	};
}
