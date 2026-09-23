/**
 * People and the roster: visits, deliveries from a visit, and presence
 * changes on the journal. Presence is a fold over the journal. The visit
 * handles are the host's way to deliver through one person.
 */

import { captureHuman } from '../define.ts';
import { AmbionError } from '../errors.ts';
import { placed, spaced } from '../journal/journal.ts';
import type { VisitRuntime } from '../room/presence.ts';
import { decide, type RoomCommand } from '../room/transition.ts';
import type {
	AgentDefinition,
	HumanDefinition,
	Message,
	PresenceMessage,
	SeatOptions,
	Seq,
} from '../types.ts';
import {
	acceptedEvent,
	messageKeyConflict,
	type RoomBase,
	requireSubmission,
	saidContentMatches,
	submit,
} from './core.ts';
import type { ExchangeHandle } from './waits.ts';

export interface Visit {
	readonly human: HumanDefinition;
	/** The seq of this person's last `left`, or undefined the first time. A live read. */
	readonly lastDeparture: Seq | undefined;
	/**
	 * Send a message to the room. `key` is the delivery's idempotency token:
	 * a repeated token lands once, so a host that never learned whether a
	 * delivery landed delivers it again under the same token. The message the
	 * token landed carries it back, so a host reads which delivery it was.
	 * A host that names none gets a token of its own that matches nothing.
	 */
	send(input: {
		to?: string;
		text: string;
		refs?: string[];
		key?: string;
	}): Promise<ExchangeHandle>;
	leave(): Promise<void>;
}

/** What people and the roster need of the room. */
export interface PeopleHost extends RoomBase {
	/** Every definition this room can seat, by name. */
	readonly defs: ReadonlyMap<string, AgentDefinition>;
	/** The handles the host delivers through. Presence itself is a fold over the journal. */
	readonly visits: Map<string, VisitRuntime>;
	/** Arrivals awaiting durable acknowledgement, keyed by human name. */
	readonly arrivals: Map<string, { identity: string; promise: Promise<VisitRuntime> }>;
	assertRunning(): void;
	handleForMessage(message: Message): ExchangeHandle;
}

/** A presence change before the room stamps when it happened. */
type PresenceDraft = Omit<PresenceMessage, 'seq' | 'key' | 'at' | 'wakes'>;

/** Compare a delivery with the body returned by a same-key journal retry. */
function deliveryMatches(
	command: Extract<RoomCommand, { type: 'deliver' }>,
	message: Message,
): boolean {
	return (
		message.kind === 'said' &&
		message.activationId === undefined &&
		message.from === command.from &&
		saidContentMatches(message, command)
	);
}

/** Puts a person in the room. A second visit while they are here is the same visit. */
export async function visit(host: PeopleHost, human: HumanDefinition): Promise<Visit> {
	host.assertRunning();
	const captured = captureHuman(human);
	const pending = host.arrivals.get(captured.name);
	if (pending !== undefined) {
		if (pending.identity !== captured.identity)
			throw new AmbionError(
				'duplicate_name',
				`'${captured.name}' is already entering this room under a different identity: one name is one person.`,
			);
		const admitted = await pending.promise;
		host.assertRunning();
		return handle(host, admitted);
	}
	const arrival = arrive(host, captured);
	host.arrivals.set(captured.name, { identity: captured.identity, promise: arrival });
	try {
		const admitted = await arrival;
		host.assertRunning();
		return handle(host, admitted);
	} finally {
		if (host.arrivals.get(captured.name)?.promise === arrival) host.arrivals.delete(captured.name);
	}
}

/** Complete one arrival and cache the handle only after its presence is durable. */
async function arrive(host: PeopleHost, captured: HumanDefinition): Promise<VisitRuntime> {
	await host.ready;
	host.assertRunning();
	await host.journal.settled();
	host.assertRunning();
	const known = host.visits.get(captured.name);
	if (known?.gone) return retryKnown(host, captured, known);
	assertVisitable(host, captured);
	const committed = await commitPresence(host, {
		kind: 'arrived',
		from: captured.name,
		subject: captured.name,
		identity: captured.identity,
		...(captured.preferences === undefined ? {} : { preferences: captured.preferences }),
	});
	host.assertRunning();
	const current = host.visits.get(captured.name);
	if (current?.gone) return retryKnown(host, captured, current);
	if (committed === undefined && current !== undefined) return current;
	if (current !== undefined) current.gone = true;
	const runtime: VisitRuntime = { human: captured, gone: false };
	host.visits.set(captured.name, runtime);
	return runtime;
}

async function retryKnown(
	host: PeopleHost,
	captured: HumanDefinition,
	known: VisitRuntime,
): Promise<VisitRuntime> {
	if (known.departure !== undefined) await known.departure.catch(() => {});
	else await endVisit(host, known);
	return arrive(host, captured);
}

function assertVisitable(host: PeopleHost, human: HumanDefinition): void {
	if (host.defs.has(human.name))
		throw new AmbionError(
			'duplicate_name',
			`'${human.name}' is an agent in this room: one name names one participant.`,
		);
}

function handle(host: PeopleHost, runtime: VisitRuntime): Visit {
	return {
		human: runtime.human,
		get lastDeparture() {
			return host.state().people.get(runtime.human.name)?.lastDeparture;
		},
		async send(input) {
			if (runtime.gone)
				throw new AmbionError('visit_ended', `${runtime.human.name}'s visit has ended.`);
			host.assertRunning();
			return deliverFrom(host, runtime.human.name, input);
		},
		leave() {
			return endVisit(host, runtime);
		},
	};
}

async function endVisit(host: PeopleHost, runtime: VisitRuntime): Promise<void> {
	if (runtime.departure !== undefined) return runtime.departure;
	// A terminal room invalidates handles it ended itself. A handle that
	// started a departure has a stable key and must still retry its write,
	// even when shutdown also failed while the storage was unavailable.
	if (runtime.gone && runtime.departureKey === undefined && host.gone()) return;
	if (runtime.departureKey === undefined) runtime.departureKey = crypto.randomUUID();
	const key = runtime.departureKey;
	// Close this handle's admission immediately. The durable decision below
	// still checks recorded presence before any speech or departure lands.
	runtime.gone = true;
	let operation!: Promise<void>;
	operation = leaveVisit(host, runtime, key).catch((error) => {
		if (runtime.departure === operation) runtime.departure = undefined;
		throw error;
	});
	runtime.departure = operation;
	return operation;
}

async function leaveVisit(host: PeopleHost, runtime: VisitRuntime, key: string): Promise<void> {
	await host.ready;
	await host.journal.settled();
	if (host.state().people.get(runtime.human.name)?.presence === 'present') {
		const current = host.visits.get(runtime.human.name);
		if (current !== undefined && current !== runtime) {
			return;
		}
		await commitPresence(
			host,
			{ kind: 'left', from: runtime.human.name, subject: runtime.human.name },
			true,
			key,
		);
	}
	runtime.gone = true;
	if (host.visits.get(runtime.human.name) === runtime) host.visits.delete(runtime.human.name);
}

async function deliverFrom(
	host: PeopleHost,
	from: string,
	input: { to?: string; text: string; refs?: string[]; key?: string },
): Promise<ExchangeHandle> {
	const to = input.to;
	const key = input.key ?? crypto.randomUUID();
	const committed = await commitMessage(host, key, {
		type: 'deliver',
		from,
		...(to === undefined ? {} : { to }),
		text: input.text,
		bytes: host.runtime.limits.message.bytes,
		...(input.refs === undefined ? {} : { refs: input.refs }),
	});
	return host.handleForMessage(committed);
}

/**
 * One operation on the room's commit queue: the draft is built where the
 * write happens, with the wakes the room decides for it. The journal hears
 * the message inside the same link, so what the room does with it happens
 * before anything lands on top. A repeated token appends nothing, so the
 * journal hears nothing, and the room reacts to nothing.
 */
async function commitMessage(
	host: PeopleHost,
	key: string,
	command: Extract<RoomCommand, { type: 'deliver' }>,
): Promise<Message> {
	const appended = await submit(
		host.journal,
		'message',
		() => decide(host.state(), command, host.now()),
		spaced('delivery', key),
	);
	requireSubmission(appended);
	if (!('entry' in appended)) throw new Error('The room command did not append a message.');
	const message = placed(appended.entry);
	if (!deliveryMatches(command, message))
		throw new AmbionError('refused', messageKeyConflict(key, message));
	return message;
}

/** Validate before host effects, then decide again where the message commits. */
function validatePresence(host: PeopleHost, change: PresenceDraft): void {
	acceptedEvent(decide(host.state(), { type: 'presence', change, route: false }, host.now()));
}

/** A presence change uses its caller's stable key, or a fresh key by default. */
async function commitPresence(
	host: PeopleHost,
	change: PresenceDraft,
	route = true,
	key: string = crypto.randomUUID(),
): Promise<Message | undefined> {
	const appended = await submit(
		host.journal,
		'message',
		() => decide(host.state(), { type: 'presence', change, route }, host.now()),
		key,
	);
	requireSubmission(appended);
	return 'entry' in appended ? placed(appended.entry) : undefined;
}

/** The host seats a registered agent. Executable definitions stay fixed for the run. */
export async function seatAgent(
	host: PeopleHost,
	name: string,
	options: SeatOptions = {},
): Promise<void> {
	const attention = options.attention ?? 'broadcast';
	host.assertRunning();
	await host.ready;
	const definition = host.defs.get(name);
	if (definition === undefined)
		throw new AmbionError('missing_definition', `Unknown agent '${name}'.`);
	const change: PresenceDraft = {
		kind: 'seated',
		subject: name,
		identity: definition.identity,
		attention,
		...(options.fixed === undefined ? {} : { fixed: options.fixed }),
	};
	validatePresence(host, change);
	await commitPresence(host, change);
}

/** The host takes an agent off the roster. */
export async function unseatAgent(host: PeopleHost, name: string): Promise<void> {
	host.assertRunning();
	await host.ready;
	if (!host.defs.has(name)) throw new AmbionError('missing_definition', `Unknown agent '${name}'.`);
	validatePresence(host, { kind: 'unseated', subject: name });
	await commitPresence(host, { kind: 'unseated', subject: name });
	await host.reconcile();
}

/**
 * A deliberate shutdown observed everybody leaving, so the record says
 * so, and the host hears it. It wakes nobody: an activation started to
 * hear that the room is closing is an activation nobody reads.
 */
export async function leaveEverybody(host: PeopleHost): Promise<void> {
	for (const person of host.state().people.values()) {
		if (person.presence !== 'present') continue;
		const runtime = host.visits.get(person.name);
		await commitPresence(host, { kind: 'left', from: person.name, subject: person.name }, false);
		if (runtime) {
			runtime.gone = true;
			if (host.visits.get(person.name) === runtime) host.visits.delete(person.name);
		}
	}
}
