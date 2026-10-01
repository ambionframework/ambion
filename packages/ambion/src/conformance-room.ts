/**
 * The scripted room that both conformance suites play. It holds one person,
 * one question, and one seat. It serves each activation of the seat. It
 * hands each activation the session that the last release recorded, as the
 * room does inside one exchange. It records every call the seat makes, and
 * every request and answer that would not survive the wire.
 *
 * A script adds what one case needs: a held view or commit, a lost commit
 * answer, a `missed` answer, a record that moves, or a new exchange.
 */
import { type Call, LEASE_MS } from './conformance-support.ts';
import {
	assertWire,
	type CommitRequest,
	type CommitResult,
	type LeaseRequest,
	type LeaseResponse,
	type RoomProtocol,
	roundTrip,
	type ViewResponse,
} from './protocol.ts';
import type { Message, Seq, VendorSession } from './types.ts';

export interface RoomScript {
	/** The first view or the first commit waits until the case calls `release`. */
	readonly hold?: 'view' | 'commit';
	/** The first commit records its request, then throws once. */
	readonly failFirstCommit?: boolean;
	/** The first `said` commit finds a new message from the person. */
	readonly misses?: boolean;
	/** The first renewal after a landed say finds a new message from the person. */
	readonly advances?: boolean;
	/** The room hands no session to a later activation, as the room does in a new exchange. */
	readonly forgets?: boolean;
}

export interface ScriptedRoom {
	readonly protocol: RoomProtocol;
	readonly calls: Call[];
	/** What would not survive the wire, one line for each request or answer. */
	readonly violations: string[];
	/** Lets a held view or a held commit answer. */
	release(): void;
	/** Add a message from the person to the record. */
	append(text: string): Message;
	/** The messages the seat landed, in order. */
	landed(): Message[];
}

const PERSON = 'priya';

const QUESTION: Message = {
	kind: 'said',
	seq: 1,
	at: new Date(0).toISOString(),
	from: PERSON,
	text: 'When is the pour?',
};

const STALE = { stale: 'the lease ended' };

/** Who is in the room: the person who asks, and the seat. */
function participants(seat: string) {
	return [
		{
			kind: 'human' as const,
			name: PERSON,
			identity: 'Project manager.',
			presence: 'present' as const,
			messagesSinceDeparture: 0,
		},
		{
			kind: 'agent' as const,
			name: seat,
			identity: 'Says a plan.',
			status: 'active' as const,
			attention: 'broadcast' as const,
		},
	];
}

/** Records one call and its answer, and each part that would not survive the wire. */
function recorder(calls: Call[], violations: string[]) {
	return <T>(op: Call['op'], request: unknown, answer: () => T | Promise<T>): Promise<T> => {
		const wire = (what: string, value: unknown) => {
			try {
				assertWire(value);
			} catch (error) {
				violations.push(`${op} ${what}: ${error instanceof Error ? error.message : String(error)}`);
			}
		};
		wire('request', request);
		const entry = { op, request: roundTrip(request), response: undefined as unknown };
		calls.push(entry);
		return Promise.resolve()
			.then(answer)
			.then((response) => {
				wire('response', response);
				calls[calls.indexOf(entry)] = { ...entry, response: roundTrip(response) };
				return response;
			});
	};
}

/** The room the suites play for one seat in the room `name`. */
export function scriptedRoom(name: string, seat: string, script: RoomScript): ScriptedRoom {
	const calls: Call[] = [];
	const violations: string[] = [];
	const messages: Message[] = [QUESTION];
	const byKey = new Map<string, Message>();
	const state = { missed: false, advanced: false, failed: false };
	/** The activations the room ended. A later activation has its own lease. */
	const ended = new Set<string>();
	/** The session the latest release recorded. The room hands it to the next activation. */
	let recorded: VendorSession | undefined;
	const isActivation = (id: string) => id.startsWith('message:') && id.endsWith(`:${seat}:1`);
	const live = (id: string) => isActivation(id) && !ended.has(id);
	let open = () => {};
	const held =
		script.hold === undefined
			? undefined
			: new Promise<void>((resolve) => {
					open = resolve;
				});
	const heldFor = (op: 'view' | 'commit') => (script.hold === op ? held : undefined);
	const lastSeq = (): Seq => messages.at(-1)?.seq ?? 1;
	const append = (text: string): Message => {
		const message: Message = {
			kind: 'said',
			seq: lastSeq() + 1,
			at: new Date().toISOString(),
			from: PERSON,
			text,
		};
		messages.push(message);
		return message;
	};
	const record = recorder(calls, violations);

	const view = (id: string): ViewResponse => ({
		view: {
			spec: {
				id,
				seat,
				attempt: 1,
				purpose: { kind: 'respond', message: Number(id.split(':')[1]) },
				...(recorded === undefined || script.forgets === true ? {} : { resume: recorded }),
			},
			through: lastSeq(),
			context: {
				name,
				now: Date.now(),
				participants: participants(seat),
				messages: [...messages],
				exchange: { person: PERSON, from: QUESTION.seq },
				reserve: [],
			},
		},
	});

	/** A say lands unless a message from another author sits past what the seat read. */
	const land = (request: CommitRequest, text: string): CommitResult => {
		const seen = request.readThrough ?? lastSeq();
		const newer = messages.filter((m) => m.seq > seen && m.from !== seat);
		if (newer.length > 0) return { missed: newer };
		const message: Message = {
			kind: 'said',
			seq: lastSeq() + 1,
			key: request.key,
			activation: request.activation,
			at: new Date().toISOString(),
			from: seat,
			text,
		};
		messages.push(message);
		byKey.set(request.key, message);
		return { committed: message };
	};

	const commit = async (request: CommitRequest): Promise<CommitResult> => {
		await heldFor('commit');
		if (!live(request.activation)) return STALE;
		const again = byKey.get(request.key);
		if (again !== undefined) return { committed: again };
		if (request.intent.kind !== 'said') return { refused: 'the suite takes a said only' };
		if (script.misses === true && !state.missed) {
			state.missed = true;
			append('One more thing: the crew starts at six.');
		}
		return land(request, request.intent.text);
	};

	const lease = (request: LeaseRequest): LeaseResponse => {
		if (!live(request.activation)) return STALE;
		if (request.operation === 'release') {
			ended.add(request.activation);
			recorded = request.session ?? recorded;
		}
		const moves = request.operation === 'renew' && script.advances === true && !state.advanced;
		if (moves && byKey.size > 0) {
			state.advanced = true;
			append('And bring the forms.');
		}
		return { ok: { expiresAt: Date.now() + LEASE_MS, lastSeq: lastSeq() } };
	};

	const protocol: RoomProtocol = {
		view: (id, message) =>
			record('view', message === undefined ? { id } : { id, message }, async () => {
				await heldFor('view');
				return live(id) ? view(id) : STALE;
			}),
		commit: (request) =>
			record('commit', request, () => {
				if (script.failFirstCommit === true && !state.failed) {
					state.failed = true;
					throw new Error('the commit answer was lost');
				}
				return commit(request);
			}),
		lease: (request) => record('lease', request, () => lease(request)),
	};
	return {
		protocol,
		calls,
		violations,
		release: open,
		append,
		landed: () => [...byKey.values()],
	};
}
