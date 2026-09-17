import type {
	ExchangeView,
	HumanDefinition,
	Message,
	Room,
	RoomSnapshot,
} from '@ambionframework/ambion';
import { cloneJson, deepFreeze, toJsonValue } from './json.ts';
import type {
	HumanAction,
	HumanDecision,
	HumanSimulator,
	SimulationDiagnostic,
	SimulationExchange,
	SimulationLimits,
	SimulationResult,
	SimulationTermination,
} from './simulation-types.ts';

interface RunSimulationOptions {
	readonly room: Room;
	readonly humans: readonly HumanDefinition[];
	readonly simulator: HumanSimulator;
	readonly limits: SimulationLimits;
	readonly signal: AbortSignal;
	readonly beforeAction?: (context: {
		readonly fixture: unknown;
		readonly action: HumanAction;
		readonly index: number;
		readonly signal: AbortSignal;
	}) => Promise<void> | void;
	readonly fixture: unknown;
	readonly deliveryPrefix: string;
}

interface SimulationState {
	readonly actions: HumanAction[];
	readonly decisions: HumanDecision[];
	readonly errors: string[];
	readonly diagnostics: SimulationDiagnostic[];
	readonly visits: Map<string, Awaited<ReturnType<Room['visit']>>>;
	readonly exchangeFroms: Set<number>;
	readonly roomErrors: string[];
	snapshot: RoomSnapshot;
	termination: SimulationTermination;
	unsafeToContinue: boolean;
	settled: boolean;
}

interface PendingOperation<T> {
	readonly promise: Promise<T>;
	readonly label: string;
	readonly timeoutMs: number;
	readonly signal: AbortSignal;
}

class SimulationTimeoutError extends Error {
	readonly unsafeToContinue: boolean;

	constructor(label: string, unsafeToContinue: boolean) {
		super(`${label} did not settle within its deadline.`);
		this.name = 'SimulationTimeoutError';
		this.unsafeToContinue = unsafeToContinue;
	}
}

class SimulationAbortError extends Error {
	readonly unsafeToContinue: boolean;

	constructor(reason: unknown, unsafeToContinue: boolean) {
		super(reason instanceof Error ? reason.message : 'The simulation was aborted.');
		this.name = 'SimulationAbortError';
		this.unsafeToContinue = unsafeToContinue;
	}
}

export async function runSimulation(options: RunSimulationOptions): Promise<SimulationResult> {
	const state = createState(options.room.name);
	const unsubscribe = options.room.subscribe((event) => {
		if (event.type === 'error' || event.type === 'audit_error')
			state.roomErrors.push(`${event.type}: ${event.error.message}`);
	});

	try {
		await driveActions(state, options);
	} catch (error) {
		recordFailure(state, error, options.signal);
		await abortRoom(options.room);
	}
	await finalSettle(state, options);
	recordRoomErrors(state);
	unsubscribe();

	return {
		settled: state.settled,
		settledSnapshot: normalizeSnapshot(state.snapshot),
		exchanges: simulationExchanges(state.snapshot, state.exchangeFroms),
		actions: state.actions.map(cloneAction),
		decisions: state.decisions.map(cloneDecision),
		termination: state.termination,
		errors: state.errors,
		diagnostics: state.diagnostics,
		unsafeToContinue: state.unsafeToContinue,
	};
}

function createState(name: string): SimulationState {
	return {
		actions: [],
		decisions: [],
		errors: [],
		diagnostics: [],
		visits: new Map(),
		exchangeFroms: new Set(),
		roomErrors: [],
		snapshot: emptySnapshot(name),
		termination: { status: 'failed', reason: 'Simulation did not finish.' },
		unsafeToContinue: false,
		settled: false,
	};
}

async function driveActions(state: SimulationState, options: RunSimulationOptions): Promise<void> {
	state.snapshot = await settleSimulation(
		options.room,
		options.limits.settleTimeoutMs,
		options.signal,
	);
	state.settled = true;
	let sayCount = 0;
	for (;;) {
		throwIfAborted(options.signal);
		const decision = await decide(options, state.snapshot, state.actions);
		const action = validateDecision(decision, options.humans);
		state.decisions.push(cloneDecision(decision));
		if (action.kind === 'finish') {
			state.termination = finishTermination(action, sayCount);
			return;
		}
		if (sayCount >= options.limits.maxActions) {
			state.termination = {
				status: 'action_limit',
				reason: `The simulation reached its ${options.limits.maxActions}-action limit.`,
			};
			return;
		}
		await performSay(state, options, action, sayCount);
		sayCount += 1;
	}
}

async function performSay(
	state: SimulationState,
	options: RunSimulationOptions,
	action: Extract<HumanAction, { kind: 'say' }>,
	sayCount: number,
): Promise<void> {
	const acceptedAction = cloneAction(action) as Extract<HumanAction, { kind: 'say' }>;
	deepFreeze(acceptedAction);
	await runBeforeAction(options, acceptedAction, state.actions.length);
	const visit = await getVisit(state.visits, options.room, options.humans, action.human);
	const exchange = await visit.send({
		text: acceptedAction.text,
		...(acceptedAction.to === undefined ? {} : { to: acceptedAction.to }),
		key: `${options.deliveryPrefix}:action-${sayCount + 1}`,
	});
	state.exchangeFroms.add(exchange.from);
	state.actions.push(acceptedAction);
	state.settled = false;
	await waitForExchange(exchange, options.limits.settleTimeoutMs, options.signal);
	state.snapshot = await settleSimulation(
		options.room,
		options.limits.settleTimeoutMs,
		options.signal,
	);
	state.settled = true;
}

function recordFailure(state: SimulationState, error: unknown, signal: AbortSignal): void {
	state.termination = classifyFailure(error, signal);
	state.unsafeToContinue ||= isUnsafe(error);
	state.errors.push(errorMessage(error));
	state.diagnostics.push(diagnostic(error));
}

async function finalSettle(state: SimulationState, options: RunSimulationOptions): Promise<void> {
	if (state.unsafeToContinue) return;
	try {
		state.snapshot = await settleSimulation(
			options.room,
			options.limits.settleTimeoutMs,
			options.signal,
		);
		state.settled = true;
	} catch (error) {
		recordFailure(state, error, options.signal);
		await abortRoom(options.room);
	}
}

function recordRoomErrors(state: SimulationState): void {
	if (state.roomErrors.length === 0) return;
	state.errors.push(...state.roomErrors);
	for (const message of state.roomErrors) state.diagnostics.push({ name: 'RoomError', message });
	if (state.termination.status === 'finished')
		state.termination = { status: 'failed', reason: 'The room emitted an execution error.' };
}

async function decide(
	options: RunSimulationOptions,
	snapshot: RoomSnapshot,
	actions: readonly HumanAction[],
): Promise<HumanDecision> {
	const controller = new AbortController();
	const onAbort = () => controller.abort(options.signal.reason);
	options.signal.addEventListener('abort', onAbort, { once: true });
	try {
		const observation = deepFreeze(normalizeSnapshot(snapshot));
		const priorActions = deepFreeze(actions.map(cloneAction));
		return await withDeadline({
			promise: options.simulator.decide({
				humans: options.humans.map((human) => Object.freeze({ ...human })),
				observation,
				actions: priorActions,
				signal: controller.signal,
			}),
			label: 'Simulator decision',
			timeoutMs: options.limits.settleTimeoutMs,
			signal: controller.signal,
		});
	} catch (error) {
		controller.abort(error);
		throw error;
	} finally {
		options.signal.removeEventListener('abort', onAbort);
	}
}

async function runBeforeAction(
	options: RunSimulationOptions,
	action: HumanAction,
	index: number,
): Promise<void> {
	if (options.beforeAction === undefined) return;
	await options.beforeAction({ fixture: options.fixture, action, index, signal: options.signal });
}

async function getVisit(
	visits: Map<string, Awaited<ReturnType<Room['visit']>>>,
	room: Room,
	humans: readonly HumanDefinition[],
	name: string,
): Promise<Awaited<ReturnType<Room['visit']>>> {
	const existing = visits.get(name);
	if (existing !== undefined) return existing;
	const human = humans.find((candidate) => candidate.name === name);
	if (human === undefined) throw new Error(`Unknown simulation human '${name}'.`);
	const visit = await room.visit(human);
	visits.set(name, visit);
	return visit;
}

async function waitForExchange(
	exchange: Awaited<ReturnType<Awaited<ReturnType<Room['visit']>>['send']>>,
	timeoutMs: number,
	signal: AbortSignal,
): Promise<void> {
	await withDeadline({
		promise: exchange.waitForClose(),
		label: `Exchange '${exchange.from}' close`,
		timeoutMs,
		signal,
	});
	await withDeadline({
		promise: exchange.waitForSummary(),
		label: `Exchange '${exchange.from}' summary`,
		timeoutMs,
		signal,
	});
}

async function settleSimulation(
	room: Room,
	timeoutMs: number,
	signal: AbortSignal,
): Promise<RoomSnapshot> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		throwIfAborted(signal);
		await withDeadline({
			promise: room.reconcile(),
			label: 'Room reconciliation',
			timeoutMs: remaining(deadline),
			signal,
		});
		const snapshot = await withDeadline({
			promise: room.read(),
			label: 'Room read',
			timeoutMs: remaining(deadline),
			signal,
		});
		if (isSettled(snapshot)) return snapshot;
		if (Date.now() >= deadline) throw new SimulationTimeoutError('Room settling', true);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
}

function isSettled(snapshot: RoomSnapshot): boolean {
	if (snapshot.exchange !== undefined) return false;
	if (
		snapshot.exchanges.some(
			(exchange) => exchange.status === 'closed' && exchange.summary.status === 'pending',
		)
	)
		return false;
	return snapshot.participants
		.filter((participant) => participant.kind === 'agent')
		.every((participant) => participant.status === 'idle');
}

function simulationExchanges(
	snapshot: RoomSnapshot,
	exchangeFroms: ReadonlySet<number>,
): SimulationExchange[] {
	return snapshot.exchanges
		.filter((exchange) => exchangeFroms.has(exchange.from))
		.map((exchange) => toSimulationExchange(exchange, snapshot.messages));
}

function toSimulationExchange(
	exchange: ExchangeView,
	messages: readonly Message[],
): SimulationExchange {
	if (exchange.status === 'open') {
		return {
			from: exchange.from,
			owner: exchange.owner,
			messages: discussion(messages, exchange.from, Number.POSITIVE_INFINITY),
			summaryStatus: 'pending',
		};
	}
	const summary = exchange.summary;
	return {
		from: exchange.from,
		owner: exchange.owner,
		through: exchange.through,
		messages: discussion(messages, exchange.from, exchange.through),
		...(summary.status === 'published' ? { summary: summary.summary } : {}),
		summaryStatus: summary.status,
	};
}

function discussion(messages: readonly Message[], from: number, through: number): Message[] {
	return messages.filter(
		(message) => message.kind !== 'summary' && message.seq >= from && message.seq <= through,
	);
}

function validateDecision(
	decision: HumanDecision,
	humans: readonly HumanDefinition[],
): HumanAction {
	if (decision === null || typeof decision !== 'object' || !('action' in decision))
		throw new TypeError('The simulator must return { action }.');
	const action = decision.action as unknown;
	if (action === null || typeof action !== 'object' || Array.isArray(action))
		throw new TypeError('The simulator action is invalid.');
	const values = action as Record<string, unknown>;
	if (values.kind === 'finish') return validateFinish(values);
	if (values.kind === 'say') return validateSay(values, humans);
	throw new TypeError(`Unknown simulator action '${String(values.kind)}'.`);
}

function validateFinish(action: Record<string, unknown>): HumanAction {
	if (typeof action.reason !== 'string' || action.reason.trim().length === 0)
		throw new TypeError('A finish action needs a non-empty reason.');
	return { kind: 'finish', reason: action.reason };
}

function validateSay(
	action: Record<string, unknown>,
	humans: readonly HumanDefinition[],
): HumanAction {
	if (typeof action.human !== 'string' || !humans.some((human) => human.name === action.human))
		throw new TypeError(`Unknown simulation human '${String(action.human)}'.`);
	if (typeof action.text !== 'string' || action.text.trim().length === 0)
		throw new TypeError('A say action needs non-empty text.');
	if (action.to !== undefined && (typeof action.to !== 'string' || action.to.trim().length === 0))
		throw new TypeError('A say action recipient must be a non-empty string.');
	return {
		kind: 'say',
		human: action.human,
		text: action.text,
		...(action.to === undefined ? {} : { to: action.to }),
	};
}

function finishTermination(
	action: Extract<HumanAction, { kind: 'finish' }>,
	sayCount: number,
): SimulationTermination {
	return sayCount === 0
		? { status: 'incomplete', reason: 'The simulation finished before any human message.' }
		: { status: 'finished', reason: action.reason };
}

function cloneAction(action: HumanAction): HumanAction {
	return action.kind === 'say' ? { ...action } : { ...action };
}

function cloneDecision(decision: HumanDecision): HumanDecision {
	return {
		action: cloneAction(decision.action),
		...(decision.rawResponse === undefined
			? {}
			: { rawResponse: cloneJson(toJsonValue(decision.rawResponse, 'simulator raw response')) }),
	};
}

async function withDeadline<T>(operation: PendingOperation<T>): Promise<T> {
	if (operation.signal.aborted) throw new SimulationAbortError(operation.signal.reason, false);
	const result = operation.promise.then(
		(value) => ({ kind: 'value' as const, value }),
		(error: unknown) => ({ kind: 'error' as const, error }),
	);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort: (() => void) | undefined;
	const aborted = new Promise<{ kind: 'aborted'; error: SimulationAbortError }>((resolve) => {
		abort = () =>
			resolve({ kind: 'aborted', error: new SimulationAbortError(operation.signal.reason, true) });
		operation.signal.addEventListener('abort', abort, { once: true });
	});
	const timeout = new Promise<{ kind: 'timeout'; error: SimulationTimeoutError }>((resolve) => {
		timer = setTimeout(
			() => resolve({ kind: 'timeout', error: new SimulationTimeoutError(operation.label, true) }),
			Math.max(0, operation.timeoutMs),
		);
	});
	const winner = await Promise.race([result, aborted, timeout]);
	if (timer !== undefined) clearTimeout(timer);
	if (abort !== undefined) operation.signal.removeEventListener('abort', abort);
	if (winner.kind === 'value') return winner.value;
	if (winner.kind === 'error') throw winner.error;
	throw winner.error;
}

function remaining(deadline: number): number {
	const value = deadline - Date.now();
	if (value <= 0) throw new SimulationTimeoutError('Room settling', true);
	return value;
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw new SimulationAbortError(signal.reason, false);
}

function classifyFailure(error: unknown, signal: AbortSignal): SimulationTermination {
	if (signal.aborted || error instanceof SimulationAbortError)
		return { status: 'aborted', reason: errorMessage(error) };
	if (error instanceof SimulationTimeoutError)
		return { status: 'timed_out', reason: error.message };
	return { status: 'failed', reason: errorMessage(error) };
}

function isUnsafe(error: unknown): boolean {
	return (
		(error instanceof SimulationTimeoutError || error instanceof SimulationAbortError) &&
		error.unsafeToContinue
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function diagnostic(error: unknown): SimulationDiagnostic {
	if (!(error instanceof Error)) return { name: 'Error', message: String(error) };
	if (error.cause === undefined) return { name: error.name, message: error.message };
	try {
		return {
			name: error.name,
			message: error.message,
			cause: toJsonValue(error.cause, 'simulation diagnostic cause'),
		};
	} catch {
		return { name: error.name, message: error.message, cause: String(error.cause) };
	}
}

function normalizeSnapshot(snapshot: RoomSnapshot): RoomSnapshot {
	const { exchange, goal, ...rest } = snapshot;
	const value = {
		...rest,
		...(goal === undefined ? {} : { goal }),
		...(exchange === undefined ? {} : { exchange }),
	};
	return cloneJson(toJsonValue(value, 'room snapshot')) as unknown as RoomSnapshot;
}

async function abortRoom(room: Room): Promise<void> {
	try {
		await Promise.race([room.abort(), new Promise<void>((resolve) => setTimeout(resolve, 100))]);
	} catch {
		// The enclosing lifecycle owns final stop/cleanup and records this failure.
	}
}

function emptySnapshot(name: string): RoomSnapshot {
	return {
		initialized: false,
		name,
		goal: undefined,
		messages: [],
		participants: [],
		exchanges: [],
		exchange: undefined,
		watermark: 0,
	};
}
