/**
 * The cases every port of an `Execution` must pass. A port carries a wake,
 * a steer, and a cut from the room to a seat, and the seat's `view`,
 * `commit`, and `lease` calls go back. The suite plays the room: it serves one
 * scripted activation, records every call the seat makes, and checks the
 * sequence and the shape of those calls. It never checks what an executor
 * says, so any executor that speaks once passes the same cases.
 *
 * `executorConformance` is the second suite. It lives in
 * `conformance-executor.ts` and is exported here. `composeRuntimeConformance` is
 * the third suite. It checks an `ComposeRuntime` of the `compose` tool, and it
 * lives in `conformance-compose.ts`.
 *
 * A case is a name and a `run` that throws on failure. The suite needs no
 * test framework, so it runs in Node and in workerd alike.
 */
import {
	type ConformanceCase,
	type ConformanceFixture,
	check,
	conformanceSuite,
} from '@ambionframework/journal/conformance';
import { type RoomScript, type ScriptedRoom, scriptedRoom } from './conformance-room.ts';
import { claims, leases, operations, pause, released, until } from './conformance-support.ts';
import type {
	ActivationOpener,
	ExecutorActivation,
	Pass,
	RunningActivation,
} from './execution/contract.ts';
import type {
	AgentPort,
	CommitRequest,
	CommitResult,
	LeaseRequest,
	RoomProtocol,
} from './protocol.ts';

export { composeRuntimeConformance } from './conformance-compose.ts';
export {
	type ExecutorCapabilities,
	type ExecutorCaseReport,
	type ExecutorFixture,
	type ExecutorPlan,
	executorConformance,
} from './conformance-executor.ts';
export { type ConformanceCase, type ConformanceFixture, check, conformanceSuite };

/** What an execution under test gives the suite. */
export interface PortFixture {
	/**
	 * Serve `room` to the seat side and connect one seat's port. In process,
	 * `room` is the argument to `connect` of the connector of an `Execution`. Over a boundary, the
	 * fixture installs `room` where the seat's `view`, `commit`, and `lease`
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
 * An opener for an in-process fixture. One pass reads the view, then calls
 * `say` once under the key `${activation}:say`, and stops. `steer` records
 * the line.
 */
export function speakOnce(): ActivationOpener {
	return (activation: ExecutorActivation): RunningActivation => {
		const lines: string[] = [];
		return {
			async pass({ view, tools }: Pass) {
				activation.read({ after: 0, through: view.through });
				const say = tools.find((tool) => tool.name === 'say');
				await say?.run({ text: SAID }, `${activation.id}:say`);
				return { failed: false };
			},
			steer(_after, _seq, line) {
				lines.push(line);
			},
		};
	};
}

// -- the cases ----------------------------------------------------------------

interface Session {
	readonly port: AgentPort;
	readonly room: ScriptedRoom;
	readonly names: { room: string; seat: string };
	readonly activation: string;
	readonly patience: number;
	wake(): Promise<void>;
	waitFor(read: () => boolean | Promise<boolean>, what: string): Promise<void>;
}

type Body = (session: Session) => Promise<void>;
const cases: readonly (readonly [string, RoomScript, Body])[] = [
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
		{ hold: 'view' },
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

/** The cases every port must pass. The order is stable and the names are the contract. */
export function portConformance(fixture: PortFixture): readonly ConformanceCase[] {
	const suite = Math.random().toString(36).slice(2);
	const patience = fixture.patience ?? 5_000;
	let count = 0;
	const run = async (script: RoomScript, body: Body): Promise<void> => {
		count += 1;
		const names = { room: `port-${suite}-${count}`, seat: 'product' };
		const room = scriptedRoom(names.room, names.seat, script);
		const activation = `message:1:${names.seat}:1`;
		try {
			const port = await fixture.connect(room.protocol, names);
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
			await fixture.close?.();
		}
	};
	return cases.map(([name, script, body]) => ({ name, run: () => run(script, body) }));
}
