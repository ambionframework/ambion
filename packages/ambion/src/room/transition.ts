/** Pure commands and committed events for a room. */

import { decodeActivationId } from '../activation-id.ts';
import type { AmbionErrorCode } from '../errors.ts';
import { type Close, type Composition, JOURNAL_FORMAT, type Seating } from '../journal/events.ts';
import type { Bodies, Body, Entry, Kind } from '../journal/journal.ts';
import type { ActivationSpec, CommitRequest } from '../protocol.ts';
import { refsRefusal } from '../refs.ts';
import type {
	EndReason,
	FailureCause,
	HarnessSession,
	Message,
	PresenceMessage,
	Usage,
} from '../types.ts';
import { activationSpec } from './activation.ts';
import { applyEvent, baseOf, type FoldOptions, isFixed, project, type RoomState } from './fold.ts';
import { isExpired, isLive } from './lease.ts';
import { evolveState } from './projection.ts';
import {
	liveWork,
	planReconciliation,
	type ReconcileOptions,
	type Reconciliation,
} from './reconcile.ts';
import { routes } from './routing.ts';
import {
	acknowledged,
	admitsClose,
	admitsLease,
	coversExchange,
	speechFreshness as freshnessRule,
	leaseExpiry,
	mayEnd,
	onRecord,
	stampedSummary,
} from './rules.verified.ts';

type ProposedEvent<K extends Kind = Kind> = {
	[P in K]: { kind: P; body: Bodies[P] };
}[K];

type PresenceChange = Omit<PresenceMessage, 'seq' | 'key' | 'at' | 'wakes'>;
type MessageCommand =
	| { type: 'deliver'; from: string; to?: string; text: string; refs?: string[]; bytes?: number }
	| { type: 'presence'; change: PresenceChange; route: boolean }
	| { type: 'commit'; commit: CommitRequest; bytes?: number };
type LeaseCommand =
	| { type: 'claim'; id: string; expiry: number; deadline: number }
	| { type: 'renew'; id: string; expiry: number; deadline: number; readThrough?: number }
	| {
			type: 'end';
			id: string;
			reason: EndReason;
			readThrough: number;
			cause?: FailureCause;
			usage?: Usage;
			session?: HarnessSession;
	  };
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

/** The codes a decision refuses with. Every one is a code the host switches on. */
type RefusalCode = Extract<
	AmbionErrorCode,
	| 'stale'
	| 'refused'
	| 'not_present'
	| 'unknown_participant'
	| 'duplicate_name'
	| 'missing_definition'
	| 'message_too_large'
>;

export type Refusal =
	{ category: RefusalCode; reason: string } | { category: 'missed'; missed: Message[] };

export type RoomDecision<K extends Kind> =
	| { event: ProposedEvent<K> | undefined }
	| { refusal: Refusal }
	| { unchanged: { kind: 'seated' | 'unseated'; name: string } };

export type ReconcileDecision = {
	events: ProposedEvent<'lease' | 'close'>[];
	effects: Omit<Reconciliation, 'expired' | 'abandoned' | 'close'>;
};

/** Live application and replay use the same event rules. */
export function evolve(state: RoomState, event: Entry, options: FoldOptions): RoomState {
	const evolved = evolveState(state, event, options);
	if (evolved !== undefined) return evolved;
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
			return commit(state, command.commit, now, command.bytes);
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
			return { event: { kind: 'run', body: { at: iso(now), format: JOURNAL_FORMAT } } };
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

/**
 * Select one running lease for a planned stop, including expired ones. A
 * planned stop revokes work an activation claimed. Work no activation
 * claimed stays on the record, and the next run over the journal wakes it.
 */
export function stopWork(state: RoomState, now: number): RoomDecision<'lease'> {
	const running = [...state.leases.values()].find((lease) => lease.phase === 'running');
	return running === undefined
		? { event: undefined }
		: end(state, { type: 'end', id: running.id, reason: 'revoked', readThrough: 0 }, now);
}

const iso = (now: number): string => new Date(now).toISOString();
const refused = (reason: string, category: RefusalCode = 'refused'): { refusal: Refusal } => ({
	refusal: { category, reason },
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
	bytes?: number,
): RoomDecision<'message'> {
	const content = contentRefusal(body);
	if (content !== undefined) return content;
	const oversize = oversizeRefusal(body, bytes);
	if (oversize !== undefined) return oversize;
	const wakes = route ? routes(body, state, liveWork(state, now).seats) : [];
	return {
		event: { kind: 'message', body: { ...body, ...(wakes.length === 0 ? {} : { wakes }) } },
	};
}

/** The room takes at most `bytes` UTF-8 bytes of text in one message. Absent means no bound. */
function oversizeRefusal(body: Body<Message>, bytes?: number): { refusal: Refusal } | undefined {
	if (bytes === undefined || (body.kind !== 'said' && body.kind !== 'summary')) return undefined;
	const size = new TextEncoder().encode(body.text).byteLength;
	return size > bytes
		? refused(
				`The message is ${size} bytes. This room takes at most ${bytes} bytes in one message. Shorten it.`,
				'message_too_large',
			)
		: undefined;
}

/** The room refuses empty text first, then a ref the grammar refuses. */
function contentRefusal(body: Body<Message>): { refusal: Refusal } | undefined {
	if (body.kind !== 'said' && body.kind !== 'summary') return undefined;
	if (body.text.trim() === '')
		return refused('The message is empty. Say something, or end your turn instead.');
	if (body.refs === undefined) return undefined;
	const reason = refsRefusal(body.refs);
	return reason === undefined ? undefined : refused(reason);
}

/** A list of refs enters the record when it holds an entry. */
const refsField = (refs: string[] | undefined): { refs?: string[] } =>
	refs === undefined || refs.length === 0 ? {} : { refs };

function deliver(
	state: RoomState,
	command: Extract<MessageCommand, { type: 'deliver' }>,
	now: number,
): RoomDecision<'message'> {
	const { from, to, text, refs } = command;
	const author = state.people.get(from);
	if (author?.presence !== 'present')
		return refused(`'${from}' is not present in this room.`, 'not_present');
	const target = state.roster.find((seat) => seat.name === to);
	if (to !== undefined && !state.people.has(to) && target === undefined) {
		return refused(`Cannot direct a delivery to '${to}': not in this room.`, 'unknown_participant');
	}
	if (target?.attention === 'none') {
		return refused(`Cannot direct a delivery to '${to}': it wakes for nothing said.`);
	}
	return message(
		state,
		{
			kind: 'said',
			at: iso(now),
			from,
			...(to === undefined ? {} : { to }),
			text,
			...refsField(refs),
		},
		now,
		true,
		command.bytes,
	);
}

function presence(
	state: RoomState,
	command: Extract<MessageCommand, { type: 'presence' }>,
	now: number,
): RoomDecision<'message'> {
	const refusal = presenceRefusal(state, command.change);
	if (refusal !== undefined) return refusal;
	const known = state.people.get(command.change.subject);
	const seat = state.roster.find((candidate) => candidate.name === command.change.subject);
	if (
		(command.change.kind === 'arrived' && known?.presence === 'present') ||
		(command.change.kind === 'left' && known?.presence !== 'present') ||
		(command.change.kind === 'seated' && seat !== undefined) ||
		(command.change.kind === 'unseated' && seat === undefined)
	)
		return { event: undefined };
	return message(state, { ...command.change, at: iso(now) }, now, command.route);
}

function presenceRefusal(
	state: RoomState,
	change: PresenceChange,
): { refusal: Refusal } | undefined {
	const seat = state.roster.find((candidate) => candidate.name === change.subject);
	if (change.kind === 'seated') {
		if (state.people.has(change.subject))
			return refused(
				`Duplicate agent name '${change.subject}': one name names one participant.`,
				'duplicate_name',
			);
		if (seat !== undefined && !sameSeating(seat, change, state.composition))
			return refused(
				`'${change.subject}' is already seated with a different attention or fixing. Unseat it first.`,
			);
	}
	if (change.kind === 'unseated') return unseatRefusal(state, seat, change.subject);
	if (change.kind === 'arrived') return arrivalRefusal(state, change);
	return undefined;
}

/** Whether a repeated seating asks for exactly what the roster already holds. */
function sameSeating(
	seat: Seating,
	change: PresenceChange,
	composition: Composition | undefined,
): boolean {
	if ((change.identity ?? '') !== seat.identity) return false;
	if ((change.attention ?? 'broadcast') !== seat.attention) return false;
	const fixed = change.fixed ?? change.subject === composition?.summary;
	return isFixed(seat, composition) === fixed;
}

function unseatRefusal(
	state: RoomState,
	seat: RoomState['roster'][number] | undefined,
	name: string,
): { refusal: Refusal } | undefined {
	if (seat === undefined) {
		return state.reserve.some((candidate) => candidate.name === name)
			? undefined
			: refused(`'${name}' is not seated in this room.`);
	}
	return undefined;
}

function arrivalRefusal(
	state: RoomState,
	change: PresenceChange,
): { refusal: Refusal } | undefined {
	const name = change.subject;
	if ([...state.roster, ...state.reserve].some((seat) => seat.name === name)) {
		return refused(
			`'${name}' is an agent in this room: one name names one participant.`,
			'duplicate_name',
		);
	}
	const known = state.people.get(name);
	if (known?.presence === 'present' && known.identity !== change.identity) {
		return refused(
			`'${name}' is already in this room under a different identity: one name is one person.`,
			'duplicate_name',
		);
	}
	return undefined;
}

function commit(
	state: RoomState,
	request: CommitRequest,
	now: number,
	bytes?: number,
): RoomDecision<'message'> {
	const spec = activationSpec(request.activation, state);
	const live = liveSpec(state, request.activation, spec, now);
	if ('refusal' in live) return live;
	const { intent } = request;
	if (!permits(live, intent.kind)) return refused('This activation cannot submit that intent.');
	const purpose = live.purpose;
	if (intent.kind === 'said' && purpose.kind === 'summarize')
		return closingCommit(state, request, live, purpose, now, bytes);
	return ordinaryCommit(state, request, live, now, bytes);
}

function closingCommit(
	state: RoomState,
	request: CommitRequest,
	live: ActivationSpec,
	purpose: Extract<ActivationSpec['purpose'], { kind: 'summarize' }>,
	now: number,
	bytes?: number,
): RoomDecision<'message'> {
	const intent = request.intent;
	if (intent.kind !== 'said') return refused('This activation cannot submit that intent.');
	const recipient = intent.to ?? purpose.person;
	if (!purpose.people.includes(recipient))
		return refused('A closing response must address a person who spoke in the exchange.');
	if (state.messages.some((entry) => isCoveringSummary(entry, purpose, recipient)))
		return refused(`This exchange already has a summary for ${recipient}.`);
	return message(
		state,
		{
			kind: 'summary',
			text: intent.text,
			...refsField(intent.refs),
			...stampedSummary(recipient, purpose.exchange, purpose.through),
			at: iso(now),
			activationId: request.activation,
			from: live.seat,
		},
		now,
		true,
		bytes,
	);
}

function ordinaryCommit(
	state: RoomState,
	request: CommitRequest,
	live: ActivationSpec,
	now: number,
	bytes?: number,
): RoomDecision<'message'> {
	const { intent } = request;
	const fresh = speechFreshness(state, request);
	if (fresh !== undefined) return fresh;
	const stamp = { at: iso(now), activationId: request.activation, from: live.seat };
	if (intent.kind === 'seated') return seating(state, intent.name, stamp, now);
	if (intent.kind === 'unseated') return unseating(state, intent.name, stamp, now);
	const refusal = addressRefusal(state, live.seat, intent.to);
	if (refusal !== undefined) return refusal;
	const { refs, ...rest } = intent;
	return message(state, { ...rest, ...refsField(refs), ...stamp }, now, true, bytes);
}

function isCoveringSummary(
	message: Message,
	purpose: Extract<ActivationSpec['purpose'], { kind: 'summarize' }>,
	recipient: string,
): boolean {
	return (
		message.kind === 'summary' &&
		coversExchange(
			message.to,
			message.covers.from,
			message.covers.through,
			recipient,
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
	if (held === undefined || !isLive(held, now)) return stale('the lease ended');
	if (spec === undefined) return refused('This activation has no room grant.');
	return spec;
}

/** Both purposes permit speech. Only a response permits a seating or an unseating. */
function permits(spec: ActivationSpec, kind: CommitRequest['intent']['kind']): boolean {
	switch (kind) {
		case 'said':
			return true;
		case 'seated':
		case 'unseated':
			return spec.purpose.kind === 'respond';
	}
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
	if (state.roster.some((seat) => seat.name === name)) {
		return { unchanged: { kind: 'seated', name } };
	}
	const held = state.reserve.find((candidate) => candidate.name === name);
	if (held === undefined) {
		const names = state.reserve.map((candidate) => candidate.name);
		return refused(
			`'${name}' is not in the reserve. ` +
				(names.length ? `Seat one of: ${names.join(', ')}.` : 'The reserve is empty.'),
			'unknown_participant',
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
			...(held.fixed === undefined ? {} : { fixed: held.fixed }),
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
	const seat = state.roster.find((candidate) => candidate.name === name);
	if (seat === undefined) {
		return state.reserve.some((candidate) => candidate.name === name)
			? { unchanged: { kind: 'unseated', name } }
			: refused(`'${name}' is not an agent in this room.`, 'unknown_participant');
	}
	if (isFixed(seat, state.composition))
		return refused(`'${name}' holds a fixed seat. Only the host can unseat it.`);
	return message(state, { kind: 'unseated', subject: name, ...stamp }, now);
}

function addressRefusal(
	state: RoomState,
	seat: string,
	target: string | undefined,
): { refusal: Refusal } | undefined {
	if (target === undefined) return undefined;
	const found = state.roster.find((candidate) => candidate.name === target);
	if (!state.people.has(target) && found === undefined)
		return refused(
			`Unknown participant '${target}'. Address someone from the roster.`,
			'unknown_participant',
		);
	if (target === seat) return refused('You cannot address yourself.');
	return found?.attention === 'none'
		? refused(`'${target}' wakes for nothing said. Say it to the room, or to somebody else.`)
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
	const { reason, cause, usage, session } = command;
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
				...(cause === undefined ? {} : { cause }),
				...(usage === undefined ? {} : { usage }),
				...(session === undefined ? {} : { session }),
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
		return refused(
			`Summary writer '${composition.summary}' is not defined in this room.`,
			'missing_definition',
		);
	const names = new Set<string>();
	for (const seat of [...composition.agents, ...composition.available]) {
		if (names.has(seat.name) || state.people.has(seat.name))
			return refused(
				`Duplicate agent name '${seat.name}': one name names one participant.`,
				'duplicate_name',
			);
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
