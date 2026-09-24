/**
 * The scripted room the executor suite runs an executor against. It answers
 * `missed`, holds a commit, moves the record, and serves more than one
 * activation of the seat. It hands each the session the last release
 * recorded, as the room does inside one exchange.
 */
import { type Call, LEASE_MS } from './conformance-support.ts';
import {
	type CommitRequest,
	type CommitResult,
	type LeaseRequest,
	type LeaseResponse,
	type RoomProtocol,
	roundTrip,
	type ViewResponse,
} from './protocol.ts';
import type { HarnessSession, Message, Seq } from './types.ts';

export interface RoomScript {
	/** The first commit waits until the case calls `release`. */
	readonly hold?: boolean;
	/** The first `said` commit finds a new message from the person. */
	readonly misses?: boolean;
	/** The first renewal after a landed say finds a new message from the person. */
	readonly advances?: boolean;
	/** The room hands no session to a later activation, as the room does in a new exchange. */
	readonly forgets?: boolean;
}

export interface ExecutorRoom {
	readonly protocol: RoomProtocol;
	readonly calls: Call[];
	/** Lets a held commit answer. */
	release(): void;
	/** Add a message from the person to the record. */
	append(text: string): Message;
	/** The messages the seat landed, in order. */
	landed(): Message[];
}

/** A room like `scriptedRoom` that also answers `missed`, holds a commit, and moves the record. */
export function executorRoom(name: string, seat: string, script: RoomScript): ExecutorRoom {
	const calls: Call[] = [];
	const messages: Message[] = [
		{
			kind: 'said',
			seq: 1,
			at: new Date(0).toISOString(),
			from: 'priya',
			text: 'When is the pour?',
		},
	];
	const byKey = new Map<string, Message>();
	const state = { missed: false, advanced: false };
	/** The activations the room ended. A later activation has its own lease. */
	const ended = new Set<string>();
	/** The session the latest release recorded. The room hands it to the next activation. */
	let recorded: HarnessSession | undefined;
	const isActivation = (id: string) => id.startsWith('message:') && id.endsWith(`:${seat}:1`);
	let open = () => {};
	const held =
		script.hold === true
			? new Promise<void>((resolve) => {
					open = resolve;
				})
			: undefined;
	const lastSeq = (): Seq => messages.at(-1)?.seq ?? 1;
	const append = (text: string): Message => {
		const message: Message = {
			kind: 'said',
			seq: lastSeq() + 1,
			at: new Date().toISOString(),
			from: 'priya',
			text,
		};
		messages.push(message);
		return message;
	};

	const record = <T>(op: Call['op'], request: unknown, answer: () => T | Promise<T>) => {
		const entry = { op, request: roundTrip(request), response: undefined as unknown };
		calls.push(entry);
		return Promise.resolve()
			.then(answer)
			.then((response) => {
				calls[calls.indexOf(entry)] = { ...entry, response: roundTrip(response) };
				return response;
			});
	};

	const stale = { stale: 'the lease ended' };

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
				participants: [
					{
						kind: 'human',
						name: 'priya',
						identity: 'Project manager.',
						presence: 'present',
						messagesSinceDeparture: 0,
					},
					{
						kind: 'agent',
						name: seat,
						identity: 'Says a plan.',
						status: 'active',
						attention: 'broadcast',
					},
				],
				messages: [...messages],
				exchange: { owner: 'priya', from: 1 },
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
			activationId: request.activation,
			at: new Date().toISOString(),
			from: seat,
			text,
		};
		messages.push(message);
		byKey.set(request.key, message);
		return { committed: message };
	};

	const commit = async (request: CommitRequest): Promise<CommitResult> => {
		await held;
		if (ended.has(request.activation) || !isActivation(request.activation)) return stale;
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
		if (ended.has(request.activation) || !isActivation(request.activation)) return stale;
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
		view: (id) =>
			record('view', { id }, () => (isActivation(id) && !ended.has(id) ? view(id) : stale)),
		commit: (request) => record('commit', request, () => commit(request)),
		lease: (request) => record('lease', request, () => lease(request)),
	};
	return { protocol, calls, release: open, append, landed: () => [...byKey.values()] };
}
