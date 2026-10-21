/**
 * The cases every `ActivationOpener` must pass. The suite plays the driver and the
 * room for one executor. It runs the executor through the real driver over a
 * scripted room, then checks the room calls and the steps the logger
 * receives. It never checks what an executor says beyond the neutral plans
 * it asks for.
 */
import { type ConformanceCase, check } from '@ambionframework/journal/conformance';
import { type RoomScript, type ScriptedRoom, scriptedRoom } from './conformance-room.ts';
import {
	type Call,
	claims,
	leases,
	operations,
	pause,
	released,
	until,
} from './conformance-support.ts';
import { defineAgent, describeExecutor } from './define.ts';
import { seatContext } from './execution/connector.ts';
import type { ActivationOpener } from './execution/contract.ts';
import { AgentRunner } from './execution/runner.ts';
import { systemClock } from './host/clock.ts';
import { DEFAULT_TRACE_LIMITS } from './host/runtime.ts';
import type { AgentPort, CommitResult, LeaseRequest } from './protocol.ts';
import {
	type ActivationEvent,
	type AgentDefinition,
	addUsage,
	type FailureCause,
	type Message,
	type TracedStep,
	type TracePolicy,
	type TraceStep,
	type Usage,
	type VendorSession,
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
	/**
	 * Make two model requests, and record the `usage` of each. The first
	 * request says `text`. The second request ends the activation with no say.
	 */
	| { kind: 'usage'; text: string; requests: readonly [Usage, Usage] };

/** What one executor kind can do. The suite drops a case that a capability gates. */
export interface ExecutorCapabilities {
	/** The executor takes a steer into a live pass. When false, a steer waits for the record. */
	readonly steer: boolean;
	/** The executor records one `usage` step for each model request, and the plan sets the counts. */
	readonly usage: boolean;
	/** The executor can end an activation as a permanent failure. */
	readonly permanentFailure: boolean;
	/**
	 * The executor records a vendor session with each release, resumes the
	 * session that `spec.resume` names, and starts fresh when the view names
	 * none. Absent means false.
	 */
	readonly memory?: boolean;
	/**
	 * The executor records one `session` step that names the model, before
	 * the first step of the model. Absent means false.
	 */
	readonly session?: boolean;
}

/** What an executor under test gives the suite. */
export interface ExecutorFixture {
	/**
	 * Build the opener for one seat, ready to perform `plan`. The scripted
	 * kind maps the plan to a script, and a model kind maps it to a fake
	 * model stream or a fake executable.
	 */
	open(
		plan: ExecutorPlan,
		definition: AgentDefinition,
	): ActivationOpener | Promise<ActivationOpener>;
	readonly can: ExecutorCapabilities;
	/** How long a case waits, in milliseconds. The default is 5_000. */
	readonly patience?: number;
	/** Runs after every case, with what the case saw. */
	close?(report: ExecutorCaseReport): Promise<void>;
}

/** What one case saw: every room call with its answer, and every step the logger received. */
export interface ExecutorCaseReport {
	readonly name: string;
	readonly calls: readonly Call[];
	/** What would not survive the wire, one line for each request or answer. */
	readonly violations: readonly string[];
	readonly records: readonly TracedStep[];
}

interface Run {
	readonly port: AgentPort;
	readonly room: ScriptedRoom;
	readonly events: ActivationEvent[];
	readonly names: { room: string; seat: string };
	readonly activation: string;
	readonly patience: number;
	/** Wake the seat for the first activation, or for the one that `activation` names. */
	wake(activation?: string): Promise<void>;
	waitFor(read: () => boolean | Promise<boolean>, what: string): Promise<void>;
	/** The steps the logger received, once the `end` step landed. */
	trace(): Promise<TraceStep[]>;
}

interface ExecutorCase {
	readonly name: string;
	readonly plan: ExecutorPlan;
	readonly room: RoomScript;
	/** The trace policy of the seat. Absent keeps the default. */
	readonly trace?: TracePolicy;
	readonly body: (run: Run) => Promise<void>;
}

const commitsOf = (room: ScriptedRoom) =>
	operations(room, 'commit').filter(
		(c) => c.response !== undefined && 'committed' in (c.response as CommitResult),
	);

type Release = LeaseRequest & { operation: 'release' };

/** Every release the room saw, in order. */
const releasesOf = (run: Run): Release[] =>
	leases(run.room).filter((request): request is Release => request.operation === 'release');

/** The release the room saw, with the read position it carries. */
function releaseWith(run: Run): Release {
	const request = leases(run.room).find((r) => r.operation === 'release');
	if (request?.operation !== 'release') throw new Error('The seat sent no release.');
	return request;
}

const stepsOf = <T extends TraceStep['type']>(steps: readonly TraceStep[], type: T) =>
	steps.filter((step): step is Extract<TraceStep, { type: T }> => step.type === type);

const TEXT = 'The pour is Saturday.';

/** A failed activation: one error event, a failed release, and an `end` step with the same cause. */
async function failure(run: Run, cause: FailureCause): Promise<void> {
	await run.wake();
	await run.waitFor(() => released(run.room), 'the release');
	const release = releaseWith(run);
	check(release.reason === 'failed', `the release reason is ${release.reason}`);
	check(release.cause === cause, `the release cause is ${release.cause}`);
	const errors = run.events.filter((event) => event.type === 'error');
	check(
		errors.length === 1 && errors[0]?.cause === cause,
		`${errors.length} error events, or one with another cause`,
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
			check(!run.events.some((event) => event.type === 'tool_call'), 'a say raised a tool event');
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
		room: { hold: 'commit' },
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
			check(end.length === 1 && end[0]?.stop === 'cut', 'the end step is not cut');
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
	room: { hold: 'commit' },
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
		const steers = stepsOf(await run.trace(), 'steer').filter((step) => step.seq === line.seq);
		check(steers.length > 0, 'the trace holds no steer step for the line');
		check(
			steers.every((step) => !step.consumed),
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

const SPENT: readonly [Usage, Usage] = [
	{ input: 120, output: 30, cacheRead: 10, cacheWrite: 5 },
	{ input: 40, output: 8, cacheRead: 60, cacheWrite: 0 },
];

const countsOf = (usage: Usage) =>
	JSON.stringify([usage.input, usage.output, usage.cacheRead, usage.cacheWrite]);

const usageCase: ExecutorCase = {
	name: 'records one usage step for each model request, and reports their sum on the release',
	plan: { kind: 'usage', text: TEXT, requests: SPENT },
	room: {},
	body: async (run) => {
		await run.wake();
		await run.waitFor(() => released(run.room), 'the release');
		const steps = stepsOf(await run.trace(), 'usage');
		check(
			JSON.stringify(steps.map(countsOf)) === JSON.stringify(SPENT.map(countsOf)),
			`the usage steps are ${JSON.stringify(steps.map(countsOf))}, not one for each request`,
		);
		const total = steps.reduce<Usage | undefined>((sum, step) => addUsage(sum, step), undefined);
		check(
			JSON.stringify(releaseWith(run).usage) === JSON.stringify(total),
			'the release usage differs from the sum of the usage steps',
		);
	},
};

/** The steps that come from what the model did. */
const MODEL_STEPS = new Set<TraceStep['type']>(['thinking', 'text', 'tool_call', 'usage']);

const sessionCase: ExecutorCase = {
	name: 'records one session step that names the model, before the first step of the model',
	plan: { kind: 'sayOnce', text: TEXT },
	room: {},
	body: async (run) => {
		await run.wake();
		await run.waitFor(() => released(run.room), 'the release');
		const steps = await run.trace();
		const sessions = stepsOf(steps, 'session');
		check(sessions.length === 1, `${sessions.length} session steps, expected 1`);
		const [session] = sessions;
		check(
			typeof session?.model === 'string' && session.model !== '',
			'the session step names no model',
		);
		const first = steps.findIndex((step) => MODEL_STEPS.has(step.type));
		check(
			first === -1 || steps.indexOf(session as TraceStep) < first,
			'the session step comes after a step of the model',
		);
	},
};

const FULL_INPUT: TracePolicy = { thinking: 'omit', toolOutput: 'omit', input: 'full' };

/**
 * The driver records the text the model receives. The system part comes once,
 * in the first pass, and each pass that reads the record gives one record
 * part. Under the default policy the trace holds no `input` step.
 */
const inputCase: ExecutorCase = {
	name: 'records the system part once and the record of each pass under the full input policy',
	plan: { kind: 'sayEachPass', text: TEXT },
	room: { advances: true },
	trace: FULL_INPUT,
	body: async (run) => {
		await run.wake();
		await run.waitFor(() => released(run.room), 'the release');
		const steps = await run.trace();
		const inputs = stepsOf(steps, 'input');
		const system = inputs.filter((step) => step.part === 'system');
		check(system.length === 1, `${system.length} system parts, expected 1`);
		check(system[0]?.pass === 1, 'the system part is not in the first pass');
		for (const step of inputs) {
			const model = steps.findIndex(
				(other) => other.pass === step.pass && MODEL_STEPS.has(other.type),
			);
			check(
				model === -1 || steps.indexOf(step) < model,
				`an input step of pass ${step.pass} comes after a step of the model`,
			);
		}
		for (const pass of stepsOf(steps, 'pass')) {
			const parts = inputs.filter((step) => step.pass === pass.pass && step.part === 'record');
			check(parts.length === 1, `pass ${pass.pass} has ${parts.length} record parts, expected 1`);
			check((parts[0]?.text ?? '') !== '', `the record part of pass ${pass.pass} holds no text`);
		}
	},
};

/**
 * Two activations of one seat: the first releases, and the room wakes the
 * second on a new message. It answers the session each release recorded, and
 * the `spec.resume` the second view carried.
 */
async function twoActivations(run: Run): Promise<{
	first: VendorSession | undefined;
	second: VendorSession | undefined;
	resume: VendorSession | undefined;
	line: Message;
}> {
	await run.wake();
	await run.waitFor(() => releasesOf(run).length === 1, 'the first release');
	const first = releasesOf(run)[0]?.session;
	check(first !== undefined && first.id !== '', 'the first release records no session');
	const line = run.room.append('And the pump?');
	const next = `message:${line.seq}:${run.names.seat}:1`;
	await run.wake(next);
	await run.waitFor(() => releasesOf(run).length === 2, 'the second release');
	const view = operations(run.room, 'view').find(
		(call) => (call.request as { id?: string }).id === next,
	);
	const answer = view?.response as { view?: { spec?: { resume?: VendorSession } } } | undefined;
	return { first, second: releasesOf(run)[1]?.session, resume: answer?.view?.spec?.resume, line };
}

/**
 * Two activations of one seat in one exchange. The room hands the session
 * the first release recorded to the second activation as `spec.resume`, and
 * the executor ends the second activation with the same session.
 */
const memoryCase: ExecutorCase = {
	name: 'records a session with each release, and resumes it in the next activation',
	plan: { kind: 'sayOnce', text: TEXT },
	room: {},
	body: async (run) => {
		const { first, second: session, resume, line } = await twoActivations(run);
		check(
			JSON.stringify(resume) === JSON.stringify(first),
			'the second view does not carry the recorded session',
		);
		const second = releasesOf(run)[1];
		check(
			JSON.stringify(session) === JSON.stringify(first),
			'the second release records another session than the one it resumed',
		);
		check(run.room.landed().length === 2, `${run.room.landed().length} says landed, expected 2`);
		check(
			(second?.readThrough ?? 0) >= line.seq,
			'the second release reads through less than the new message',
		);
	},
};

/**
 * Two activations of one seat in two exchanges. The second view names no
 * session, so the executor starts a fresh one and records it.
 */
const freshCase: ExecutorCase = {
	name: 'starts a fresh session when the view names none',
	plan: { kind: 'sayOnce', text: TEXT },
	room: { forgets: true },
	body: async (run) => {
		const { first, second, resume } = await twoActivations(run);
		check(resume === undefined, 'the second view carries a session');
		check(second !== undefined && second.id !== '', 'the second release records no session');
		check(second?.id !== first?.id, 'the second release records the session it was not handed');
		check(run.room.landed().length === 2, `${run.room.landed().length} says landed, expected 2`);
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
		check(stepsOf(steps, 'input').length === 0, 'the default policy logs an input step');
		const passes = new Set(steps.map((step) => step.pass));
		check(stepsOf(steps, 'pass').length === passes.size, 'a pass has no pass step, or has two');
		const committed = stepsOf(steps, 'room').filter((step) => step.result === 'committed');
		check(committed.length === commitsOf(run.room).length, 'a committed say has no room step');
	},
};

/** The cases every executor must pass. The order is stable and the names are the contract. */
export function executorConformance(fixture: ExecutorFixture): readonly ConformanceCase[] {
	const suite = Math.random().toString(36).slice(2);
	const patience = fixture.patience ?? 5_000;
	const { can } = fixture;
	const cases = [
		...baseCases,
		can.steer ? liveSteer : heldSteer,
		...(can.permanentFailure ? [permanentFailure] : []),
		...(can.usage ? [usageCase] : []),
		...(can.memory === true ? [memoryCase, freshCase] : []),
		...(can.session === true ? [sessionCase] : []),
		inputCase,
		orderCase,
	];
	let count = 0;
	const run = async (one: ExecutorCase): Promise<void> => {
		count += 1;
		const names = { room: `executor-${suite}-${count}`, seat: 'product' };
		const room = scriptedRoom(names.room, names.seat, one.room);
		const activation = `message:1:${names.seat}:1`;
		const events: ActivationEvent[] = [];
		const records: TracedStep[] = [];
		const definition = defineAgent({
			name: names.seat,
			identity: 'Says a plan.',
			executor: describeExecutor({ kind: 'conformance', instructions: '' }),
			...(one.trace === undefined ? {} : { trace: one.trace }),
		});
		try {
			const opener = await fixture.open(one.plan, definition);
			const emit = (event: ActivationEvent) => void events.push(event);
			const port = new AgentRunner(
				room.protocol,
				seatContext({
					clock: systemClock(),
					call: { attempts: 2, timeout: patience },
					definition,
					room: names.room,
					seat: names.seat,
					opener,
					emit,
					logger: (record) => void records.push(record),
					limits: DEFAULT_TRACE_LIMITS,
				}),
			);
			await one.body({
				port,
				room,
				events,
				names,
				activation,
				patience,
				wake: (id = activation) =>
					port.wake({ room: names.room, seat: names.seat, activation: id }),
				waitFor: (read, what) => until(read, patience, what),
				trace: async () => {
					const steps = () =>
						records.flatMap((record) =>
							record.step.activation === activation ? [record.step] : [],
						);
					await until(() => steps().some((step) => step.type === 'end'), patience, 'the end step');
					return steps();
				},
			});
		} finally {
			room.release();
			await fixture.close?.({
				name: one.name,
				calls: room.calls,
				violations: room.violations,
				records,
			});
		}
	};
	return cases.map((one) => ({ name: one.name, run: () => run(one) }));
}
