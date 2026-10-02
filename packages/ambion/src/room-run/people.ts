/**
 * People and the roster: visits, deliveries from a visit, and presence
 * changes on the journal. Presence is a fold over the journal. The visit
 * handles are the host's way to deliver through one person.
 */

import { captureHuman } from '../define.ts';
import { AmbionError } from '../errors.ts';
import { placed, spaced } from '../journal/journal.ts';
import type { VisitRuntime } from '../room/presence.ts';
import type { RoomCommand } from '../room/transition.ts';
import type { Message, PersonDefinition, PresenceMessage, SeatOptions, Seq } from '../types.ts';
import {
	decideAndAppend,
	type ExchangeHandle,
	messageKeyConflict,
	type RoomRunState,
	requireSubmission,
	saidContentMatches,
} from './core.ts';

export interface Visit {
	readonly person: PersonDefinition;
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

/** A presence change before the room stamps when it happened. */
type PresenceDraft = Omit<PresenceMessage, 'seq' | 'key' | 'at' | 'wakes'>;

/** Compare a delivery or a post with the body returned by a same-key journal retry. */
function deliveryMatches(
	command: Extract<RoomCommand, { type: 'deliver' | 'post' }>,
	message: Message,
): boolean {
	if (command.type === 'post')
		return (
			message.kind === 'posted' &&
			message.returns === undefined &&
			saidContentMatches(message, command)
		);
	return (
		message.kind === 'said' &&
		message.activation === undefined &&
		message.from === command.from &&
		saidContentMatches(message, command)
	);
}

/** Puts a person in the room. A second visit while they are here is the same visit. */
export async function visit(run: RoomRunState, person: PersonDefinition): Promise<Visit> {
	run.assertRunning();
	const captured = captureHuman(person);
	const pending = run.arrivals.get(captured.name);
	if (pending !== undefined) {
		if (pending.identity !== captured.identity)
			throw new AmbionError(
				'duplicate_name',
				`'${captured.name}' is already entering this room under a different identity: one name is one person.`,
			);
		const admitted = await pending.promise;
		run.assertRunning();
		return handle(run, admitted);
	}
	const arrival = arrive(run, captured);
	run.arrivals.set(captured.name, { identity: captured.identity, promise: arrival });
	try {
		const admitted = await arrival;
		run.assertRunning();
		return handle(run, admitted);
	} finally {
		if (run.arrivals.get(captured.name)?.promise === arrival) run.arrivals.delete(captured.name);
	}
}

/**
 * The visit of a person whom the record holds present, or undefined. It
 * writes nothing. A room that resumed holds no handle for the people who
 * stayed, so the first call takes one from the record.
 */
export function presentVisit(run: RoomRunState, name: string): Visit | undefined {
	if (run.gone()) return undefined;
	const known = run.visits.get(name);
	if (known !== undefined) return handle(run, known);
	const recorded = run.state().people.get(name);
	if (recorded?.presence !== 'present') return undefined;
	const person = captureHuman({
		name,
		identity: recorded.identity,
		...(recorded.preferences === undefined ? {} : { preferences: recorded.preferences }),
	});
	const runtime: VisitRuntime = { person, gone: false };
	run.visits.set(name, runtime);
	return handle(run, runtime);
}

/** Complete one arrival and cache the handle only after its presence is durable. */
async function arrive(run: RoomRunState, captured: PersonDefinition): Promise<VisitRuntime> {
	await run.ready;
	run.assertRunning();
	await run.journal.settled();
	run.assertRunning();
	const known = run.visits.get(captured.name);
	if (known?.gone) return retryKnown(run, captured, known);
	assertVisitable(run, captured);
	const committed = await commitPresence(run, {
		kind: 'arrived',
		from: captured.name,
		subject: captured.name,
		identity: captured.identity,
		...(captured.preferences === undefined ? {} : { preferences: captured.preferences }),
	});
	run.assertRunning();
	const current = run.visits.get(captured.name);
	if (current?.gone) return retryKnown(run, captured, current);
	if (committed === undefined && current !== undefined) return current;
	if (current !== undefined) current.gone = true;
	const runtime: VisitRuntime = { person: captured, gone: false };
	run.visits.set(captured.name, runtime);
	return runtime;
}

async function retryKnown(
	run: RoomRunState,
	captured: PersonDefinition,
	known: VisitRuntime,
): Promise<VisitRuntime> {
	if (known.departure !== undefined) await known.departure.catch(() => {});
	else await endVisit(run, known);
	return arrive(run, captured);
}

function assertVisitable(run: RoomRunState, person: PersonDefinition): void {
	if (run.defs.has(person.name))
		throw new AmbionError(
			'duplicate_name',
			`'${person.name}' is an agent in this room: one name names one participant.`,
		);
}

function handle(run: RoomRunState, runtime: VisitRuntime): Visit {
	return {
		person: runtime.person,
		get lastDeparture() {
			return run.state().people.get(runtime.person.name)?.lastDeparture;
		},
		async send(input) {
			if (runtime.gone)
				throw new AmbionError('visit_ended', `${runtime.person.name}'s visit has ended.`);
			run.assertRunning();
			return deliverFrom(run, runtime.person.name, input);
		},
		leave() {
			return endVisit(run, runtime);
		},
	};
}

async function endVisit(run: RoomRunState, runtime: VisitRuntime): Promise<void> {
	if (runtime.departure !== undefined) return runtime.departure;
	// A terminal room invalidates handles it ended itself. A handle that
	// started a departure has a stable key and must still retry its write,
	// even when shutdown also failed while the storage was unavailable.
	if (runtime.gone && runtime.departureKey === undefined && run.gone()) return;
	if (runtime.departureKey === undefined) runtime.departureKey = crypto.randomUUID();
	const key = runtime.departureKey;
	// Close this handle's admission immediately. The durable decision below
	// still checks recorded presence before any speech or departure lands.
	runtime.gone = true;
	let operation!: Promise<void>;
	operation = leaveVisit(run, runtime, key).catch((error) => {
		if (runtime.departure === operation) runtime.departure = undefined;
		throw error;
	});
	runtime.departure = operation;
	return operation;
}

async function leaveVisit(run: RoomRunState, runtime: VisitRuntime, key: string): Promise<void> {
	await run.ready;
	await run.journal.settled();
	if (run.state().people.get(runtime.person.name)?.presence === 'present') {
		const current = run.visits.get(runtime.person.name);
		if (current !== undefined && current !== runtime) {
			return;
		}
		await commitPresence(
			run,
			{ kind: 'left', from: runtime.person.name, subject: runtime.person.name },
			true,
			key,
		);
	}
	runtime.gone = true;
	if (run.visits.get(runtime.person.name) === runtime) run.visits.delete(runtime.person.name);
}

async function deliverFrom(
	run: RoomRunState,
	from: string,
	input: { to?: string; text: string; refs?: string[]; key?: string },
): Promise<ExchangeHandle> {
	const to = input.to;
	const key = input.key ?? crypto.randomUUID();
	const committed = await commitMessage(run, key, {
		type: 'deliver',
		from,
		...(to === undefined ? {} : { to }),
		text: input.text,
		bytes: run.runtime.limits.message.bytes,
		...(input.refs === undefined ? {} : { refs: input.refs }),
	});
	return run.handleForMessage(committed);
}

/**
 * One operation on the room's commit queue: the draft is built where the
 * write happens, with the wakes the room decides for it. The journal hears
 * the message inside the same link, so what the room does with it happens
 * before anything lands on top. A repeated token appends nothing, so the
 * journal hears nothing, and the room reacts to nothing.
 */
async function commitMessage(
	run: RoomRunState,
	key: string,
	command: Extract<RoomCommand, { type: 'deliver' | 'post' }>,
): Promise<Message> {
	const space = command.type === 'deliver' ? 'delivery' : 'post';
	const appended = await decideAndAppend(run, 'message', command, { key: spaced(space, key) });
	requireSubmission(appended);
	if (!('entry' in appended)) throw new Error('The room command did not append a message.');
	const message = placed(appended.entry);
	if (!deliveryMatches(command, message))
		throw new AmbionError('refused', messageKeyConflict(key, message));
	return message;
}

/** What the host posts: a message of the system to a seat, a person, or the room. */
export interface PostInput {
	to?: string;
	text: string;
	refs?: string[];
	/** The idempotency token of the post, in a key space of its own. */
	key?: string;
}

/**
 * The host posts as the system. The post has no author, and it opens an
 * exchange when none is open. A repeated key lands once, and the post it
 * landed carries it back.
 */
export async function post(run: RoomRunState, input: PostInput): Promise<ExchangeHandle> {
	run.assertRunning();
	const key = input.key ?? crypto.randomUUID();
	const committed = await commitMessage(run, key, {
		type: 'post',
		...(input.to === undefined ? {} : { to: input.to }),
		text: input.text,
		bytes: run.runtime.limits.message.bytes,
		...(input.refs === undefined ? {} : { refs: input.refs }),
	});
	return run.handleForMessage(committed);
}

/**
 * A presence change uses its caller's stable key, or a fresh key by default.
 * The decision where the message commits refuses what the room refuses.
 */
async function commitPresence(
	run: RoomRunState,
	change: PresenceDraft,
	route = true,
	key: string = crypto.randomUUID(),
): Promise<Message | undefined> {
	const appended = await decideAndAppend(
		run,
		'message',
		{ type: 'presence', change, route },
		{ key },
	);
	requireSubmission(appended);
	return 'entry' in appended ? placed(appended.entry) : undefined;
}

/** The host seats a registered agent. Executable definitions stay fixed for the run. */
export async function seatAgent(
	run: RoomRunState,
	name: string,
	options: SeatOptions = {},
): Promise<void> {
	const attention = options.attention ?? 'broadcast';
	run.assertRunning();
	await run.ready;
	const definition = run.defs.get(name);
	if (definition === undefined)
		throw new AmbionError('missing_definition', `Unknown agent '${name}'.`);
	const change: PresenceDraft = {
		kind: 'seated',
		subject: name,
		identity: definition.identity,
		attention,
		...(options.fixed === undefined ? {} : { fixed: options.fixed }),
	};
	await commitPresence(run, change);
}

/** The host takes an agent off the roster. */
export async function unseatAgent(run: RoomRunState, name: string): Promise<void> {
	run.assertRunning();
	await run.ready;
	if (!run.defs.has(name)) throw new AmbionError('missing_definition', `Unknown agent '${name}'.`);
	await commitPresence(run, { kind: 'unseated', subject: name });
	await run.reconcile();
}

/**
 * A deliberate shutdown observed everybody leaving, so the record says
 * so, and the host hears it. It wakes nobody: an activation started to
 * hear that the room is closing is an activation nobody reads.
 */
export async function leaveEverybody(run: RoomRunState): Promise<void> {
	for (const person of run.state().people.values()) {
		if (person.presence !== 'present') continue;
		const runtime = run.visits.get(person.name);
		await commitPresence(run, { kind: 'left', from: person.name, subject: person.name }, false);
		if (runtime) {
			runtime.gone = true;
			if (run.visits.get(person.name) === runtime) run.visits.delete(person.name);
		}
	}
}
