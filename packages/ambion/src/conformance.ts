/**
 * The cases every `Transport` must pass. A transport carries a wake, a
 * steer, and a cut from the room to a seat, and carries the seat's `view`,
 * `commit`, and `lease` calls back. The suite plays the room: it serves one
 * scripted activation, records every call the seat makes, and checks the
 * sequence and the shape of those calls. It never checks what an executor
 * says, so any executor that speaks once passes the same cases.
 *
 * `executorConformance` is the second suite. It lives in
 * `conformance-executor.ts` and is exported here.
 *
 * A case is a name and a `run` that throws on failure. The suite needs no
 * test framework, so it runs in Node and in workerd alike.
 */
import type { ConformanceCase } from '@ambionframework/journal/conformance';
import {
	type Call,
	check,
	claims,
	LEASE_MS,
	leases,
	operations,
	pause,
	released,
	until,
} from './conformance-support.ts';
import type {
	Executor,
	ExecutorActivation,
	ExecutorSession,
	PassInput,
} from './execution/executor.ts';
import {
	type AgentPort,
	assertWire,
	type CommitRequest,
	type CommitResult,
	type LeaseRequest,
	type LeaseResponse,
	type RoomProtocol,
	roundTrip,
	type ViewResponse,
} from './protocol.ts';
import type { Message, Seq } from './types.ts';

export {
	type ExecutorCapabilities,
	type ExecutorHarness,
	type ExecutorPlan,
	executorConformance,
} from './conformance-executor.ts';
export type { ConformanceCase };

/** What a transport under test gives the suite. */
export interface TransportHarness {
	/**
	 * Serve `room` to the seat side and connect one seat's port. In process,
	 * `room` is the argument to `Transport.connect`. Over a boundary, the
	 * harness installs `room` where the seat's `view`, `commit`, and `lease`
	 * arrive, so the suite observes every call the seat makes.
	 *
	 * The seat side must run an executor that says once on a `respond`
	 * activation (`speakOnce()` in process, a scripted model over RPC) and
	 * must allow at least two attempts per room call.
	 */
	connect(room: RoomProtocol, names: { room: string; seat: string }): Promise<AgentPort>;
	/** How long a case waits for the seat side, in milliseconds. The default is 5_000. */
	readonly patience?: number;
	/** Runs after every case. */
	close?(): Promise<void>;
}

const SAID = 'The pour is Saturday.';

/**
 * An executor for an in-process harness. One pass commits one `said` under
 * the key `${activation}:say` with `readThrough: view.through`, acknowledges
 * the committed seq, then stops. `steer` records the line, `abort` sets
 * `cancelled`, and `shouldRefresh` answers false.
 */
export function speakOnce(): Executor {
	return {
		open(activation: ExecutorActivation): ExecutorSession {
			let readThrough: Seq = 0;
			let cancelled = false;
			const lines: string[] = [];
			return {
				get readThrough() {
					return readThrough;
				},
				get cancelled() {
					return cancelled;
				},
				async pass({ view }: PassInput) {
					const response = await activation.room.commit({
						activation: activation.id,
						key: `${activation.id}:say`,
						readThrough: view.through,
						intent: { kind: 'said', text: SAID },
					});
					readThrough = 'committed' in response ? response.committed.seq : view.through;
					return { failed: false };
				},
				steer(_after, _seq, line) {
					lines.push(line);
				},
				shouldRefresh: () => false,
				abort() {
					cancelled = true;
				},
			};
		},
	};
}

// -- the scripted room --------------------------------------------------------

interface Script {
	/** The view answer waits until the case calls `release`. */
	readonly holdView?: boolean;
	/** The first commit records its request, then throws once. */
	readonly failFirstCommit?: boolean;
}

interface ScriptedRoom {
	readonly protocol: RoomProtocol;
	/** Lets a held view answer. */
	release(): void;
	readonly calls: Call[];
	readonly violations: string[];
}

/** The room the suite plays: one person, one question, one seat, one activation. */
function scriptedRoom(name: string, seat: string, script: Script): ScriptedRoom {
	const activation = `message:1:${seat}:1`;
	const calls: Call[] = [];
	const violations: string[] = [];
	const landed = new Map<string, Message>();
	let lastSeq: Seq = 1;
	let ended = false;
	let open = () => {};
	const held =
		script.holdView === true
			? new Promise<void>((resolve) => {
					open = resolve;
				})
			: undefined;
	let failed = false;
	const question: Message = {
		kind: 'said',
		seq: 1,
		at: new Date(0).toISOString(),
		from: 'priya',
		text: 'When is the pour?',
	};

	const record = <T>(op: Call['op'], request: unknown, answer: () => T | Promise<T>) => {
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

	const stale = { stale: 'the lease ended' };

	const view = (): ViewResponse => ({
		view: {
			spec: {
				id: activation,
				seat,
				attempt: 1,
				purpose: { kind: 'respond', message: 1 },
			},
			through: 1,
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
						identity: 'Answers once.',
						status: 'active',
						attention: 'broadcast',
					},
				],
				messages: [question],
				exchange: { owner: 'priya', from: 1 },
				reserve: [],
			},
		},
	});

	const commit = (request: CommitRequest): CommitResult => {
		if (ended || request.activation !== activation) return stale;
		const again = landed.get(request.key);
		if (again !== undefined) return { committed: again };
		if (request.intent.kind !== 'said') return { refused: 'the suite takes a said only' };
		lastSeq += 1;
		const message: Message = {
			kind: 'said',
			seq: lastSeq,
			key: request.key,
			activationId: activation,
			at: new Date().toISOString(),
			from: seat,
			text: request.intent.text,
		};
		landed.set(request.key, message);
		return { committed: message };
	};

	const lease = (request: LeaseRequest): LeaseResponse => {
		if (ended || request.activation !== activation) return stale;
		if (request.operation === 'release') ended = true;
		return { ok: { expiresAt: Date.now() + LEASE_MS, lastSeq } };
	};

	const protocol: RoomProtocol = {
		view: (id, range) =>
			record('view', range === undefined ? { id } : { id, range }, async () => {
				await held;
				return id === activation && !ended ? view() : stale;
			}),
		commit: (request) =>
			record('commit', request, () => {
				if (script.failFirstCommit === true && !failed) {
					failed = true;
					throw new Error('the commit answer was lost');
				}
				return commit(request);
			}),
		lease: (request) => record('lease', request, () => lease(request)),
	};
	return { protocol, release: open, calls, violations };
}

// -- the cases ----------------------------------------------------------------

interface Session {
	readonly port: AgentPort;
	readonly room: ScriptedRoom;
	readonly names: { room: string; seat: string };
	readonly activation: string;
	readonly patience: number;
	wake(): Promise<void>;
	waitFor(read: () => boolean, what: string): Promise<void>;
}

type Body = (session: Session) => Promise<void>;
const cases: readonly (readonly [string, Script, Body])[] = [
	[
		'carries a wake to the seat, which claims, views, commits, and releases over the wire',
		{},
		async (s) => {
			await s.wake();
			await s.waitFor(() => released(s.room), 'the release');
			const { calls } = s.room;
			check(
				(calls[0]?.request as LeaseRequest | undefined)?.operation === 'claim',
				'the first call is not a claim',
			);
			check(
				leases(s.room).every((r) => r.activation === s.activation),
				'a lease names another activation',
			);
			const firstView = calls.findIndex((c) => c.op === 'view');
			const firstCommit = calls.findIndex((c) => c.op === 'commit');
			check(firstView >= 0 && firstCommit > firstView, 'a commit came before a view');
			for (const c of operations(s.room, 'commit')) {
				const request = c.request as CommitRequest;
				check(request.activation === s.activation, 'a commit names another activation');
				check(typeof request.key === 'string' && request.key !== '', 'a commit has no key');
			}
			const last = calls.at(-1)?.request as LeaseRequest | undefined;
			check(
				last?.operation === 'release' && last.reason === 'released' && last.readThrough >= 1,
				'the last call is not a release with reason released past the view',
			);
		},
	],
	[
		'sends every request and answer as plain JSON',
		{},
		async (s) => {
			await s.wake();
			await s.waitFor(() => released(s.room), 'the release');
			check(s.room.violations.length === 0, `the wire broke: ${s.room.violations.join('; ')}`);
		},
	],
	[
		'runs a wake that arrives twice once',
		{},
		async (s) => {
			await s.wake();
			await s.wake();
			await s.waitFor(() => released(s.room), 'the release');
			const before = s.room.calls.length;
			await pause(s.patience / 10);
			check(claims(s.room) === 1, `${claims(s.room)} claims for one activation`);
			check(s.room.calls.length === before, 'a call came after the release');
			check(
				operations(s.room, 'commit').every((c) => (c.response as CommitResult) !== undefined),
				'a commit went unanswered',
			);
		},
	],
	[
		'ignores a steer for an activation the seat does not run',
		{},
		async (s) => {
			const other = `message:9:${s.names.seat}:1`;
			await s.port.steer({
				room: s.names.room,
				seat: s.names.seat,
				activation: other,
				after: 1,
				message: {
					kind: 'said',
					seq: 2,
					at: new Date(0).toISOString(),
					from: 'priya',
					text: 'A line for nobody.',
				},
			});
			await pause(s.patience / 10);
			check(s.room.calls.length === 0, 'the room saw a call');
		},
	],
	[
		'cuts nothing when no activation runs',
		{},
		async (s) => {
			await s.port.cut(`message:9:${s.names.seat}:1`);
			await pause(s.patience / 10);
			check(s.room.calls.length === 0, 'the room saw a call');
		},
	],
	[
		'cuts the running activation, and nothing more lands under its lease',
		{ holdView: true },
		async (s) => {
			await s.wake();
			await s.waitFor(() => operations(s.room, 'view').length > 0, 'the view request');
			await s.port.cut(s.activation);
			s.room.release();
			await pause(s.patience / 10);
			check(operations(s.room, 'commit').length === 0, 'a commit came after the cut');
			check(claims(s.room) === 1, 'the seat claimed again after the cut');
		},
	],
	[
		'retries a commit under one key and lands it once',
		{ failFirstCommit: true },
		async (s) => {
			await s.wake();
			await s.waitFor(() => released(s.room), 'the release');
			const commits = operations(s.room, 'commit').map((c) => c.request as CommitRequest);
			check(commits.length === 2, `${commits.length} commit requests, expected 2`);
			check(commits[0]?.key === commits[1]?.key, 'the retry used a new key');
			check(
				JSON.stringify(commits[0]?.intent) === JSON.stringify(commits[1]?.intent),
				'the retry changed the intent',
			);
			const landed = operations(s.room, 'commit').filter(
				(c) => c.response !== undefined && 'committed' in (c.response as CommitResult),
			);
			check(landed.length === 1, `${landed.length} commits landed, expected 1`);
		},
	],
];

/** The cases every `Transport` must pass. The order is stable and the names are the contract. */
export function transportConformance(harness: TransportHarness): readonly ConformanceCase[] {
	const suite = Math.random().toString(36).slice(2);
	const patience = harness.patience ?? 5_000;
	let count = 0;
	const run = async (script: Script, body: Body): Promise<void> => {
		count += 1;
		const names = { room: `transport-${suite}-${count}`, seat: 'product' };
		const room = scriptedRoom(names.room, names.seat, script);
		const activation = `message:1:${names.seat}:1`;
		try {
			const port = await harness.connect(room.protocol, names);
			await body({
				port,
				room,
				names,
				activation,
				patience,
				wake: () => port.wake({ room: names.room, seat: names.seat, activation }),
				waitFor: (read, what) => until(read, patience, what),
			});
		} finally {
			room.release();
			await harness.close?.();
		}
	};
	return cases.map(([name, script, body]) => ({ name, run: () => run(script, body) }));
}
