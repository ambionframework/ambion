/** Public room facade that composes collaboration and execution services. */

import { decodeActivationId } from './activation-id.ts';
import { assertRoomName, captureAgent, DEFAULT_TRACE } from './define.ts';
import { AmbionError } from './errors.ts';
import type { Executor } from './execution/executor.ts';
import { inProcessTransport } from './execution/runner.ts';
import { readTrace, traceOpener } from './execution/trace.ts';
import {
	defaultConnectorOf,
	defaultRuntime,
	type Execution,
	type ExecutionConnector,
	type ExecutionHost,
	executionHostOf,
	hostingOf,
	type Runtime,
	registeredRoom,
	registerRoom,
	releaseRoom,
	roomRuntime,
} from './host/runtime.ts';
import { roomJournal } from './journal/journal.ts';
import { discussionMessages } from './room/exchange.ts';
import { foldRoom } from './room/fold.ts';
import type { MessageSelection } from './room/read.ts';
import { captureMessageSelection, readView } from './room/read.ts';
import { type CompositionDraft, type Room, RoomHost } from './room-host/room.ts';
import type {
	AgentDefinition,
	Attention,
	ExchangeView,
	Message,
	RoomRead,
	SeatOptions,
	Seq,
	TraceStep,
} from './types.ts';

export type { ExchangeHandle, Room, RoomRead, Visit } from './room-host/room.ts';

export interface StartRoomOptions {
	/** The room name shared by all runs over its journal. */
	name: string;
	/** A reusable assistant definition that joins the ordinary composition as a broadcast summary writer. */
	assistant?: AgentDefinition;
	/** The fixed executable definitions for this run. */
	agents?: readonly AgentDefinition[];
	/** Initial members and attention. Omit to seat all agents at broadcast; `{}` keeps all in reserve. */
	seats?: Readonly<Record<string, Attention | SeatOptions>>;
	/** An ordinary defined agent that writes closed exchange summaries. */
	summary?: string;
	/** Public context that states what the room is for. */
	goal?: string;
	/** The execution for this room, such as `piExecution()`. Defaults to the runtime's. */
	execution?: Execution;
	/** The runtime that owns storage and lifecycle. Defaults to `defaultRuntime`. */
	runtime?: Runtime;
}

export interface ReadRoomOptions {
	/** The runtime that owns the room journal. */
	runtime?: Runtime;
	/** Include all messages, omit them, or select those after an exclusive cursor. */
	messages?: MessageSelection;
}

export interface ResumeRoomOptions {
	/** Definitions that resolve every recorded roster and reserve name. */
	agents: readonly AgentDefinition[];
	/** The runtime that owns the room journal. */
	runtime?: Runtime;
	/** The execution for this room, such as `piExecution()`. Defaults to the runtime's. */
	execution?: Execution;
}

/**
 * The connector for one room: its own execution, else the runtime's, else
 * the default of each seat's executor kind, else one whose seats fail when
 * the room wakes them. A room with no execution
 * still runs its people, its record, and any transport it was given.
 */
function connectorFor(runtime: Runtime, own: Execution | undefined): ExecutionConnector {
	const host = executionHostOf(runtime);
	const execution = own ?? hostingOf(runtime).execution;
	if (execution !== undefined) return execution.connector(host);
	const missing = missingConnector(runtime, host);
	return {
		connect(room, request) {
			const kind = request.definition.executor.kind;
			return (defaultConnectorOf(runtime, kind) ?? missing).connect(room, request);
		},
	};
}

/** The connector for a seat whose kind has no execution: its activations fail. */
function missingConnector(runtime: Runtime, host: ExecutionHost): ExecutionConnector {
	const transport = host.transport ?? inProcessTransport();
	return {
		connect(room, request) {
			return transport.connect(room, {
				clock: host.clock,
				call: host.limits.call,
				definition: request.definition,
				room: request.room,
				seat: request.seat,
				executor: missingExecutor(request.seat),
				emit: request.emit,
				trace: traceOpener({
					room: request.room,
					agent: request.seat,
					traces: hostingOf(runtime).traces,
					limits: host.limits.trace,
					policy: request.definition.trace ?? DEFAULT_TRACE,
					emit: request.emit,
					now: () => host.clock.now(),
				}),
			});
		},
	};
}

/** The executor of a room that has none: each activation fails at once, and a retry cannot fix it. */
function missingExecutor(seat: string): Executor {
	return {
		open(activation) {
			const error = new AmbionError(
				'no_execution',
				'The room has no execution. Load the executor package of the agent, or pass `execution`, such as `piExecution()` from @ambionframework/pi, to startRoom or createRuntime.',
			);
			return {
				readThrough: 0,
				cancelled: false,
				async pass() {
					activation.emit({
						type: 'error',
						agent: seat,
						activation: activation.id,
						error,
						cause: 'permanent',
					});
					return { failed: true, cause: 'permanent' };
				},
				shouldRefresh: () => false,
				abort() {},
			};
		},
	};
}

export async function startRoom(options: StartRoomOptions): Promise<Room> {
	assertRoomName(options.name);
	const runtime = options.runtime ?? defaultRuntime();
	assertFree(runtime, options.name);
	const room = RoomHost.start(
		options.name,
		roomRuntime(runtime, options.name),
		composeFrom(options),
		connectorFor(runtime, options.execution),
	);
	registerRoom(runtime, room);
	try {
		await room.started();
	} catch (error) {
		releaseRoom(runtime, room.name, room);
		throw error;
	}
	return room;
}

export async function resumeRoom(name: string, options: ResumeRoomOptions): Promise<Room> {
	assertRoomName(name);
	const runtime = options.runtime ?? defaultRuntime();
	assertFree(runtime, name);
	const room = RoomHost.resume(
		name,
		roomRuntime(runtime, name),
		definitionsOf(options.agents),
		connectorFor(runtime, options.execution),
	);
	registerRoom(runtime, room);
	try {
		await room.started();
	} catch (error) {
		releaseRoom(runtime, room.name, room);
		throw error;
	}
	return room;
}

/** Observe a room's recorded state without requiring a running handle. */
export async function readRoom(name: string, options: ReadRoomOptions = {}): Promise<RoomRead> {
	assertRoomName(name);
	const runtime = options.runtime ?? defaultRuntime();
	const messages = captureMessageSelection(options.messages);
	const live = registeredRoom(runtime, name);
	if (live instanceof RoomHost) return live.read({ messages });
	const hosting = hostingOf(runtime);
	const journal = roomJournal(hosting.journals.open(name));
	await journal.ready;
	await journal.settled();
	return readView(
		name,
		foldRoom(journal.entries, hosting.limits.activation),
		runtime.clock.now(),
		journal.lastSeq,
		messages,
	);
}

/** An exchange and its original discussion at one observed journal position. */
export interface ExchangeRead {
	readonly exchange: ExchangeView;
	readonly messages: readonly Message[];
	readonly watermark: Seq;
}

/** Read one exchange's durable discussion without starting or reconciling a room. */
export async function readExchange(
	name: string,
	from: Seq,
	options: { runtime?: Runtime } = {},
): Promise<ExchangeRead | undefined> {
	if (!Number.isSafeInteger(from) || from <= 0)
		throw new RangeError('Exchange reference must be a positive safe integer.');
	const snapshot = await readRoom(name, {
		runtime: options.runtime,
		messages: { since: from - 1 },
	});
	const exchange = snapshot.exchanges.find((candidate) => candidate.from === from);
	if (exchange === undefined) return undefined;
	const through = exchange.status === 'closed' ? exchange.through : snapshot.watermark;
	return {
		exchange,
		messages: discussionMessages(snapshot.messages, from, through),
		watermark: snapshot.watermark,
	};
}

/** One pass of an activation: what it read and the steps it took. */
export interface ActivationPass {
	readonly pass: number;
	/** Whether the pass read the whole view or only what changed. */
	readonly input: 'view' | 'delta';
	/** The last seq the pass read. */
	readonly through: Seq;
	readonly steps: readonly TraceStep[];
}

/** What the trace journal holds of one activation. */
export interface ActivationRead {
	readonly activation: string;
	readonly passes: readonly ActivationPass[];
}

/**
 * Read the trace of one activation without starting a room and without
 * waiting. A running activation returns the steps written so far. A
 * malformed id returns nothing. An activation without a trace returns no
 * passes.
 */
export async function readActivation(
	name: string,
	activation: string,
	options: { runtime?: Runtime } = {},
): Promise<ActivationRead | undefined> {
	assertRoomName(name);
	if (decodeActivationId(activation) === undefined) return undefined;
	const runtime = options.runtime ?? defaultRuntime();
	const steps = await readTrace(hostingOf(runtime).traces, name, activation);
	return { activation, passes: passesOf(steps) };
}

/** Group steps, already in pass and index order, into passes. A `pass` step opens each one. */
function passesOf(steps: readonly TraceStep[]): ActivationPass[] {
	const passes: { pass: number; input: 'view' | 'delta'; through: Seq; steps: TraceStep[] }[] = [];
	for (const step of steps) {
		if (step.type === 'pass')
			passes.push({ pass: step.pass, input: step.input, through: step.through, steps: [] });
		passes.at(-1)?.steps.push(step);
	}
	return passes;
}

function assertFree(runtime: Runtime, name: string): void {
	if (registeredRoom(runtime, name) !== undefined)
		throw new AmbionError(
			'room_running',
			`Room '${name}' is already running: stop it before starting it again.`,
		);
}

function composeFrom(options: StartRoomOptions): CompositionDraft {
	const normalized = normalizeAssistant(options);
	const definitions = capturedDefinitions(normalized);
	return {
		goal: normalized.goal?.trim() || undefined,
		summary: normalized.summary,
		definitions,
		seats: initialSeats(normalized, definitions),
	};
}

/** A bare attention shorthand, normalized to the options shape it stands for. */
function seatOptionsOf(value: Attention | SeatOptions | undefined): SeatOptions {
	return typeof value === 'string' ? { attention: value } : (value ?? {});
}

/** Expand the assistant shorthand before the existing composition validation path. */
function normalizeAssistant(options: StartRoomOptions): StartRoomOptions {
	const assistant = options.assistant;
	if (assistant === undefined) return options;
	const name = assistant.name;
	if (options.agents?.some((agent) => agent.name === name)) throw duplicate(name);
	if (options.summary !== undefined && options.summary !== name)
		throw new AmbionError(
			'refused',
			`Assistant '${name}' conflicts with summary agent '${options.summary}'.`,
		);
	const configured = seatOptionsOf(options.seats?.[name]);
	if (configured.attention !== undefined && configured.attention !== 'broadcast')
		throw new AmbionError('refused', `Assistant '${name}' must use 'broadcast' attention.`);
	const seats =
		options.seats === undefined
			? undefined
			: { ...options.seats, [name]: { ...configured, attention: 'broadcast' as const } };
	return {
		...options,
		agents: [assistant, ...(options.agents ?? [])],
		seats,
		summary: name,
	};
}

function capturedDefinitions(options: StartRoomOptions): AgentDefinition[] {
	const definitions = (options.agents ?? []).map(captureAgent);
	const names = new Set<string>();
	for (const definition of definitions) {
		if (names.has(definition.name)) throw duplicate(definition.name);
		names.add(definition.name);
	}
	if (options.summary !== undefined && !names.has(options.summary))
		throw new AmbionError('missing_definition', `Unknown summary agent '${options.summary}'.`);
	return definitions;
}

function initialSeats(
	options: StartRoomOptions,
	definitions: readonly AgentDefinition[],
): Map<string, SeatOptions> {
	const configured = options.seats;
	const selected = new Set(
		configured === undefined
			? (options.agents ?? []).map((agent) => agent.name)
			: Object.keys(configured),
	);
	const names = new Set(definitions.map((agent) => agent.name));
	for (const name of selected)
		if (!names.has(name)) throw new AmbionError('missing_definition', `Unknown agent '${name}'.`);
	if (options.summary !== undefined && !selected.has(options.summary))
		throw new AmbionError(
			'refused',
			`Summary writer '${options.summary}' is not seated: add it to 'seats' or omit 'summary'.`,
		);
	return new Map(
		definitions
			.filter((agent) => selected.has(agent.name))
			.map((agent) => [agent.name, seatOptionsOf(configured?.[agent.name])]),
	);
}

function definitionsOf(agents: readonly AgentDefinition[]): Map<string, AgentDefinition> {
	const bindings = new Map<string, AgentDefinition>();
	for (const agent of agents) {
		const captured = captureAgent(agent);
		if (bindings.has(captured.name)) throw duplicate(captured.name);
		bindings.set(captured.name, captured);
	}
	return bindings;
}

function duplicate(name: string): AmbionError {
	return new AmbionError(
		'duplicate_name',
		`Duplicate agent name '${name}': one name names one participant.`,
	);
}
