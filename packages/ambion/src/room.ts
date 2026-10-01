/** Public room facade that composes collaboration and execution services. */

import { assertRoomName, captureAgent } from './define.ts';
import { AmbionError } from './errors.ts';
import { route } from './execution/route.ts';
import {
	defaultRuntime,
	type Execution,
	type ExecutionConnector,
	executionsOf,
	type Runtime,
	type RuntimeState,
	stateOf,
	tokenWindowOf,
} from './host/runtime.ts';
import { roomJournal } from './journal/journal.ts';
import { discussionMessages } from './room/exchange.ts';
import { projectState, replay } from './room/projection.ts';
import type { MessageSelection } from './room/read.ts';
import { captureMessageSelection, readView } from './room/read.ts';
import { type CompositionDraft, type Room, RoomHost, type Visit } from './room-host/room.ts';
import type {
	AgentDefinition,
	Attention,
	ExchangeView,
	Message,
	RoomRead,
	SeatOptions,
	Seq,
} from './types.ts';

export type { ExchangeHandle, PostInput, Room, RoomRead, Visit } from './room-host/room.ts';

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
	/**
	 * The execution for this room, such as `piExecution()`, or one for each
	 * executor kind. A seat runs on the first that serves its kind, then on
	 * the runtime's, then on the default of its kind.
	 */
	execution?: Execution | readonly Execution[];
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
	/** The execution for this room, as `StartRoomOptions.execution` states. */
	execution?: Execution | readonly Execution[];
}

/**
 * The connector for one room: the room's executions, then the runtime's,
 * then the default of each seat's executor kind. A seat that none serves
 * fails when the room wakes it. A room with no execution still runs its
 * people and its record.
 */
function connectorFor(
	state: RuntimeState,
	own: Execution | readonly Execution[] | undefined,
): ExecutionConnector {
	return route({
		executions: [...executionsOf(own), ...state.executions],
		host: state,
		built: state.defaults,
	});
}

export function startRoom(options: StartRoomOptions): Promise<Room> {
	return acquire(options.name, options, (state, connector) => {
		const cast = composeFrom(options);
		assertEstimators(cast.definitions, state);
		return RoomHost.start(options.name, state, cast, connector);
	});
}

export function resumeRoom(name: string, options: ResumeRoomOptions): Promise<Room> {
	return acquire(name, options, (state, connector) => {
		const bindings = definitionsOf(options.agents);
		assertEstimators(bindings.values(), state);
		return RoomHost.resume(name, state, bindings, connector);
	});
}

/**
 * One run takes a name in its runtime. The room is built over the runtime,
 * registered, and started as one step: a start that fails releases the name,
 * and the runtime then holds no room under it. `open` builds the room from
 * its definitions; only the start and the resume differ there.
 */
async function acquire(
	name: string,
	options: Pick<StartRoomOptions, 'runtime' | 'execution'>,
	open: (state: RuntimeState, connector: ExecutionConnector) => RoomHost,
): Promise<Room> {
	assertRoomName(name);
	const state = stateOf(options.runtime ?? defaultRuntime());
	assertFree(state, name);
	const room = open(state, connectorFor(state, options.execution));
	state.running.set(room.name, room);
	try {
		await room.started();
	} catch (error) {
		state.release(room.name, room);
		throw error;
	}
	return room;
}

/**
 * The visit of a person whom the record of a running room holds present, or
 * undefined. It writes nothing, so a host that resumed a room reaches the
 * people who stayed without a second arrival.
 */
export function visitOf(room: Room, name: string): Visit | undefined {
	if (!(room instanceof RoomHost))
		throw new TypeError('The room must come from startRoom or resumeRoom.');
	return room.presentVisit(name);
}

/** Observe a room's recorded state without requiring a running handle. */
export async function readRoom(name: string, options: ReadRoomOptions = {}): Promise<RoomRead> {
	assertRoomName(name);
	const runtime = options.runtime ?? defaultRuntime();
	const messages = captureMessageSelection(options.messages);
	const state = stateOf(runtime);
	const live = state.running.get(name);
	if (live instanceof RoomHost) return live.read({ messages });
	const journal = roomJournal(state.journals.open(name));
	await journal.ready;
	await journal.settled();
	return readView(
		name,
		projectState(replay(journal.entries, state.limits.activation)),
		state.clock.now(),
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

function assertFree(state: RuntimeState, name: string): void {
	if (state.running.has(name))
		throw new AmbionError(
			'room_running',
			`Room '${name}' is already running: stop it before starting it again.`,
		);
}

/**
 * Every estimator a definition names is in the registry of the runtime. The
 * room checks when a run starts, the first point where the definition and the
 * registry meet, so a wrong name fails the start and never an activation.
 */
function assertEstimators(definitions: Iterable<AgentDefinition>, state: RuntimeState): void {
	for (const agent of definitions) tokenWindowOf(agent, state);
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
