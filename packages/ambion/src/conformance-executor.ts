/**
 * The cases every `Executor` must pass. The suite plays the driver and the
 * room for one executor. It runs the executor through the real driver over a
 * scripted room, then checks the room calls and the trace journal. It never
 * checks what an executor says beyond the neutral plans it asks for.
 */
import { type JournalOpener, memoryJournals } from '@ambionframework/journal';
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
import { DEFAULT_TRACE, defineAgent, describeExecutor } from './define.ts';
import type { Executor } from './execution/executor.ts';
import { inProcessTransport } from './execution/runner.ts';
import { readTrace, traceJournals, traceOpener } from './execution/trace.ts';
import { systemClock } from './host/clock.ts';
import {
	type AgentPort,
	type CommitRequest,
	type CommitResult,
	type LeaseRequest,
	type LeaseResponse,
	type RoomProtocol,
	roundTrip,
	type ViewResponse,
} from './protocol.ts';
import {
	type AgentDefinition,
	addUsage,
	type ExecutionEvent,
	type FailureCause,
	type Message,
	type Seq,
	type TraceStep,
	type Usage,
} from './types.ts';

/** The neutral behaviours the suite asks an executor to perform. The suite owns this set. */
export type ExecutorPlan =
	/** Say `text` once, then stop. */
	| { kind: 'sayOnce'; text: string }
	/** Say `text`. When the room answers `missed`, say it again. */
	| { kind: 'missThenResay'; text: string }
	/** Say `text` on the first pass and again on the pass that follows a moved record. */
	| { kind: 'sayEachPass'; text: string }
	/** Say `text`, and say it again after a `missed` answer. The room can hold the first commit. */
	| { kind: 'holdSay'; text: string }
	/** Say `text` only after the steered line reaches the live pass. */
	| { kind: 'awaitSteer'; text: string }
	/** End the activation as a failure of `cause`. */
	| { kind: 'fail'; cause: FailureCause }
	/** Record `usage` once, then say `text`. */
	| { kind: 'usage'; text: string; usage: Usage };

/** What one executor family can do. The suite drops a case that a capability gates. */
export interface ExecutorCapabilities {
	/** The executor takes a steer into a live pass. When false, a steer waits for the record. */
	readonly steer: boolean;
	/** The executor records `usage` steps. */
	readonly usage: boolean;
	/** The executor can end an activation as a permanent failure. */
	readonly permanentFailure: boolean;
}

/** What an executor under test gives the suite. */
export interface ExecutorHarness {
	/**
	 * Build the executor for one seat, ready to perform `plan`. The scripted
	 * family maps the plan to a script, and a model family maps it to a fake
	 * model stream or a fake executable.
	 */
	open(plan: ExecutorPlan, definition: AgentDefinition): Executor | Promise<Executor>;
	readonly can: ExecutorCapabilities;
	/** How long a case waits, in milliseconds. The default is 5_000. */
	readonly patience?: number;
	/** Runs after every case. */
	close?(): Promise<void>;
}

interface RoomScript {
	/** The first commit waits until the case calls `release`. */
	readonly hold?: boolean;
	/** The first `said` commit finds a new message from the person. */
	readonly misses?: boolean;
	/** The first renewal after a landed say finds a new message from the person. */
	readonly advances?: boolean;
}

interface ExecutorRoom {
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
function executorRoom(name: string, seat: string, script: RoomScript): ExecutorRoom {
	const activation = `message:1:${seat}:1`;
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
	const state = { ended: false, missed: false, advanced: false };
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

	const view = (): ViewResponse => ({
		view: {
			spec: { id: activation, seat, attempt: 1, purpose: { kind: 'respond', message: 1 } },
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
			activationId: activation,
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
		if (state.ended || request.activation !== activation) return stale;
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
		if (state.ended || request.activation !== activation) return stale;
		if (request.operation === 'release') state.ended = true;
		const moves = request.operation === 'renew' && script.advances === true && !state.advanced;
		if (moves && byKey.size > 0) {
			state.advanced = true;
			append('And bring the forms.');
		}
		return { ok: { expiresAt: Date.now() + LEASE_MS, lastSeq: lastSeq() } };
	};

	const protocol: RoomProtocol = {
		view: (id) =>
			record('view', { id }, () => (id === activation && !state.ended ? view() : stale)),
		commit: (request) => record('commit', request, () => commit(request)),
		lease: (request) => record('lease', request, () => lease(request)),
	};
	return { protocol, calls, release: open, append, landed: () => [...byKey.values()] };
}

interface Run {
	readonly port: AgentPort;
	readonly room: ExecutorRoom;
	readonly events: ExecutionEvent[];
	readonly names: { room: string; seat: string };
	readonly activation: string;
	readonly patience: number;
	wake(): Promise<void>;
	waitFor(read: () => boolean, what: string): Promise<void>;
	/** The trace steps once the `end` step landed. */
	trace(): Promise<TraceStep[]>;
}

interface ExecutorCase {
	readonly name: string;
	readonly plan: ExecutorPlan;
	readonly room: RoomScript;
	readonly body: (run: Run) => Promise<void>;
}

const commitsOf = (room: ExecutorRoom) =>
	operations(room, 'commit').filter(
		(c) => c.response !== undefined && 'committed' in (c.response as CommitResult),
	);

type Release = LeaseRequest & { operation: 'release' };

/** The release the room saw, with the read position it carries. */
function releaseWith(run: Run): Release {
	const request = leases(run.room).find((r) => r.operation === 'release');
	if (request?.operation !== 'release') throw new Error('The seat sent no release.');
	return request;
}

const stepsOf = <T extends TraceStep['type']>(steps: readonly TraceStep[], type: T) =>
	steps.filter((step): step is Extract<TraceStep, { type: T }> => step.type === type);

const TEXT = 'The pour is Saturday.';

/** A failed activation: an event, a failed release, and an `end` step with the same cause. */
async function failure(run: Run, cause: FailureCause): Promise<void> {
	await run.wake();
	await run.waitFor(() => released(run.room), 'the release');
	const release = releaseWith(run);
	check(release.reason === 'failed', `the release reason is ${release.reason}`);
	check(release.cause === cause, `the release cause is ${release.cause}`);
	const errors = run.events.filter((event) => event.type === 'error');
	check(
		errors.length > 0 && errors.every((event) => event.cause === cause),
		'no error event, or one with another cause',
	);
	const end = stepsOf(await run.trace(), 'end');
	check(end.length === 1 && end[0]?.failure?.cause === cause, 'the end step has another cause');
}

const isBefore = (a: TraceStep, b: TraceStep) =>
	a.pass < b.pass || (a.pass === b.pass && a.index < b.index);

const baseCases: readonly ExecutorCase[] = [
	{
		name: 'carries a wake to a pass that says once, and releases with the position it read',
		plan: { kind: 'sayOnce', text: TEXT },
		room: {},
		body: async (run) => {
			await run.wake();
			await run.waitFor(() => released(run.room), 'the release');
			check(claims(run.room) === 1, `${claims(run.room)} claims for one activation`);
			check(operations(run.room, 'view').length >= 1, 'the seat never read the record');
			check(commitsOf(run.room).length === 1, 'the seat did not land one say');
			const say = run.room.landed()[0];
			const release = releaseWith(run);
			check(release.reason === 'released', `the release reason is ${release.reason}`);
			check(
				say !== undefined && release.readThrough >= say.seq,
				'the release reads through less than the say',
			);
			const steps = await run.trace();
			const room = stepsOf(steps, 'room');
			check(stepsOf(steps, 'pass')[0]?.input === 'view', 'the first pass does not read the view');
			check(room.length === 1 && room[0]?.result === 'committed', 'no committed room step');
			check(stepsOf(steps, 'end')[0]?.stop === 'stopped', 'the activation did not stop');
		},
	},
	{
		name: 'says again a say the room missed, and lands one say',
		plan: { kind: 'missThenResay', text: TEXT },
		room: { misses: true },
		body: async (run) => {
			await run.wake();
			await run.waitFor(() => released(run.room), 'the release');
			const responses = operations(run.room, 'commit').map((c) => c.response as CommitResult);
			check(
				responses.some((r) => 'missed' in r),
				'the room never answered missed',
			);
			check(run.room.landed().length === 1, `${run.room.landed().length} says landed, expected 1`);
			const say = run.room.landed()[0];
			check(
				say !== undefined && say.seq === 3 && releaseWith(run).readThrough >= say.seq,
				'the release does not read through the say that followed the miss',
			);
			const results = stepsOf(await run.trace(), 'room').map((step) => step.result);
			check(results.join() === 'missed,committed', `the room steps are ${results.join()}`);
		},
	},
	{
		name: 'runs a second pass on a delta when the record moved',
		plan: { kind: 'sayEachPass', text: TEXT },
		room: { advances: true },
		body: async (run) => {
			await run.wake();
			await run.waitFor(() => released(run.room), 'the release');
			check(run.room.landed().length === 2, `${run.room.landed().length} says landed, expected 2`);
			const steps = await run.trace();
			const inputs = stepsOf(steps, 'pass').map((step) => step.input);
			check(inputs.join() === 'view,delta', `the passes are ${inputs.join()}`);
			check(stepsOf(steps, 'room').length === 2, 'a pass wrote no room step');
			check(claims(run.room) === 1, 'the second pass claimed again');
		},
	},
	{
		name: 'cuts a pass in flight, and nothing lands under its lease',
		plan: { kind: 'holdSay', text: TEXT },
		room: { hold: true },
		body: async (run) => {
			await run.wake();
			await run.waitFor(() => operations(run.room, 'commit').length > 0, 'the held commit');
			await run.port.cut(run.activation);
			await run.waitFor(() => released(run.room), 'the release');
			run.room.release();
			await pause(run.patience / 10);
			check(run.room.landed().length === 0, 'a say landed after the cut');
			check(claims(run.room) === 1, 'the seat claimed again after the cut');
			check(releaseWith(run).readThrough >= 1, 'the release reads through less than the view');
			const end = stepsOf(await run.trace(), 'end');
			check(end.length === 1 && end[0]?.stop === 'aborted', 'the end step is not aborted');
		},
	},
	{
		name: 'ends the activation as a transient failure',
		plan: { kind: 'fail', cause: 'transient' },
		room: {},
		body: (run) => failure(run, 'transient'),
	},
];

/** The steered line arrives while a commit is held. The executor cannot take it into the pass. */
const heldSteer: ExecutorCase = {
	name: 'holds a steer for the record when the executor cannot steer',
	plan: { kind: 'holdSay', text: TEXT },
	room: { hold: true },
	body: async (run) => {
		await run.wake();
		await run.waitFor(() => operations(run.room, 'commit').length > 0, 'the held commit');
		const line = run.room.append('Also, bring the forms.');
		await run.port.steer({
			room: run.names.room,
			seat: run.names.seat,
			activation: run.activation,
			after: 1,
			message: line,
		});
		run.room.release();
		await run.waitFor(() => released(run.room), 'the release');
		const say = run.room.landed()[0];
		check(run.room.landed().length === 1, `${run.room.landed().length} says landed, expected 1`);
		check(say !== undefined && say.seq > line.seq, 'the say landed before the steered line');
		check(releaseWith(run).readThrough >= line.seq, 'the release does not read the steered line');
		check(
			stepsOf(await run.trace(), 'steer').every((step) => !step.consumed),
			'a steer shows as consumed',
		);
	},
};

/** The steered line arrives in the live pass. The executor says only after it sees the line. */
const liveSteer: ExecutorCase = {
	name: 'takes a steer into the live pass when the executor can steer',
	plan: { kind: 'awaitSteer', text: TEXT },
	room: {},
	body: async (run) => {
		await run.wake();
		await run.waitFor(() => operations(run.room, 'view').length > 0, 'the view');
		const line = run.room.append('Also, bring the forms.');
		await run.port.steer({
			room: run.names.room,
			seat: run.names.seat,
			activation: run.activation,
			after: 1,
			message: line,
		});
		await run.waitFor(() => released(run.room), 'the release');
		check(run.room.landed().length === 1, `${run.room.landed().length} says landed, expected 1`);
		const steps = await run.trace();
		check(stepsOf(steps, 'pass').length === 1, 'the steer needed a second pass');
		check(
			stepsOf(steps, 'steer').some((step) => step.seq === line.seq && step.consumed),
			'no consumed steer step',
		);
	},
};

const permanentFailure: ExecutorCase = {
	name: 'ends the activation as a permanent failure',
	plan: { kind: 'fail', cause: 'permanent' },
	room: {},
	body: (run) => failure(run, 'permanent'),
};

const SPENT: Usage = { input: 120, output: 30, cacheRead: 10, cacheWrite: 5 };

const usageCase: ExecutorCase = {
	name: 'reports usage on the release',
	plan: { kind: 'usage', text: TEXT, usage: SPENT },
	room: {},
	body: async (run) => {
		await run.wake();
		await run.waitFor(() => released(run.room), 'the release');
		const steps = stepsOf(await run.trace(), 'usage');
		check(steps.length > 0, 'the trace holds no usage step');
		const total = steps.reduce<Usage | undefined>((sum, step) => addUsage(sum, step), undefined);
		check(
			JSON.stringify(releaseWith(run).usage) === JSON.stringify(total),
			'the release usage differs from the sum of the usage steps',
		);
		check(total?.input === SPENT.input && total.output === SPENT.output, 'the sum is not the plan');
	},
};

const orderCase: ExecutorCase = {
	name: 'writes the trace in order, with one end step and one pass step for each pass',
	plan: { kind: 'sayEachPass', text: TEXT },
	room: { advances: true },
	body: async (run) => {
		await run.wake();
		await run.waitFor(() => released(run.room), 'the release');
		const steps = await run.trace();
		check(
			steps.every((step, at) => at === 0 || isBefore(steps[at - 1] as TraceStep, step)),
			'the steps are out of order',
		);
		check(stepsOf(steps, 'end').length === 1, 'the trace holds more or less than one end step');
		const passes = new Set(steps.map((step) => step.pass));
		check(stepsOf(steps, 'pass').length === passes.size, 'a pass has no pass step, or has two');
		const committed = stepsOf(steps, 'room').filter((step) => step.result === 'committed');
		check(committed.length === commitsOf(run.room).length, 'a committed say has no room step');
	},
};

/** The cases every executor must pass. The order is stable and the names are the contract. */
export function executorConformance(harness: ExecutorHarness): readonly ConformanceCase[] {
	const suite = Math.random().toString(36).slice(2);
	const patience = harness.patience ?? 5_000;
	const { can } = harness;
	const cases = [
		...baseCases,
		can.steer ? liveSteer : heldSteer,
		...(can.permanentFailure ? [permanentFailure] : []),
		...(can.usage ? [usageCase] : []),
		orderCase,
	];
	let count = 0;
	const run = async (one: ExecutorCase): Promise<void> => {
		count += 1;
		const names = { room: `executor-${suite}-${count}`, seat: 'product' };
		const room = executorRoom(names.room, names.seat, one.room);
		const activation = `message:1:${names.seat}:1`;
		const events: ExecutionEvent[] = [];
		const traces = traceJournals(memoryJournals());
		const definition = defineAgent({
			name: names.seat,
			identity: 'Says a plan.',
			executor: describeExecutor({ kind: 'conformance', instructions: '' }),
		});
		try {
			const executor = await harness.open(one.plan, definition);
			const emit = (event: ExecutionEvent) => void events.push(event);
			const port = inProcessTransport().connect(room.protocol, {
				clock: systemClock(),
				call: { attempts: 2, timeout: patience },
				definition,
				room: names.room,
				seat: names.seat,
				executor,
				emit,
				trace: traceOpener({
					room: names.room,
					agent: names.seat,
					traces,
					limits: { toolOutputBytes: 65_536, stepsPerPass: 1_000 },
					policy: definition.trace ?? DEFAULT_TRACE,
					emit,
					now: () => Date.now(),
				}),
			});
			await one.body({
				port,
				room,
				events,
				names,
				activation,
				patience,
				wake: () => port.wake({ room: names.room, seat: names.seat, activation }),
				waitFor: (read, what) => until(read, patience, what),
				trace: () => traceWhenEnded(traces, names.room, activation, patience),
			});
		} finally {
			room.release();
			await harness.close?.();
		}
	};
	return cases.map((one) => ({ name: one.name, run: () => run(one) }));
}

/** The steps of the activation once its `end` step is in the journal. The driver writes it last. */
async function traceWhenEnded(
	traces: JournalOpener,
	room: string,
	activation: string,
	patience: number,
): Promise<TraceStep[]> {
	const deadline = Date.now() + patience;
	for (;;) {
		const steps = await readTrace(traces, room, activation);
		if (steps.some((step) => step.type === 'end')) return steps;
		if (Date.now() > deadline) throw new Error(`No end step came within ${patience} ms.`);
		await pause(20);
	}
}
