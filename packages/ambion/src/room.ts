/** Public room facade that composes collaboration and execution services. */

import type { StreamFn } from '@earendil-works/pi-agent-core';
import { captureAgent } from './define.ts';
import { composeExecution } from './execution/compose.ts';
import {
	defaultRuntime,
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
import { type CompositionDraft, type Room, RoomHost } from './room-host.ts';
import type {
	AgentDefinition,
	Attention,
	ExchangeView,
	Message,
	RoomSnapshot,
	Seq,
} from './types.ts';

export type { ExchangeHandle, Room, RoomSnapshot, Visit } from './room-host.ts';

export interface StartRoomOptions {
	/** The room name shared by all runs over its journal. */
	name: string;
	/** A reusable assistant definition that joins the ordinary composition as a broadcast summary writer. */
	assistant?: AgentDefinition;
	/** The fixed executable catalog for this run. */
	agents?: readonly AgentDefinition[];
	/** Initial members and attention. Omit to seat all agents at broadcast; `{}` keeps all in reserve. */
	seats?: Readonly<Record<string, Attention>>;
	/** An ordinary catalog agent that writes closed exchange summaries. */
	summary?: string;
	/** Public context that states what the room is for. */
	goal?: string;
	/** A room specific model stream override. */
	streamFn?: StreamFn;
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
	/** A room specific model stream override. */
	streamFn?: StreamFn;
}

export async function startRoom(options: StartRoomOptions): Promise<Room> {
	const runtime = options.runtime ?? defaultRuntime;
	assertFree(runtime, options.name);
	const room = RoomHost.start(
		options.name,
		roomRuntime(runtime, options.name),
		composeFrom(options),
		composeExecution(runtime, options.streamFn),
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
	const runtime = options.runtime ?? defaultRuntime;
	assertFree(runtime, name);
	const room = RoomHost.resume(
		name,
		roomRuntime(runtime, name),
		definitionsOf(options.agents),
		composeExecution(runtime, options.streamFn),
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
export async function readRoom(name: string, options: ReadRoomOptions = {}): Promise<RoomSnapshot> {
	const runtime = options.runtime ?? defaultRuntime;
	const messages = captureMessageSelection(options.messages);
	const live = registeredRoom(runtime, name);
	if (live instanceof RoomHost) return live.read({ messages });
	const journal = roomJournal(runtime.journals.open(name));
	await journal.ready;
	await journal.settled();
	return readView(
		name,
		foldRoom(journal.entries, runtime.retry),
		runtime.clock.now(),
		journal.lastSeq,
		messages,
	);
}

/** An exchange and its original discussion at one observed journal position. */
export interface ExchangeSnapshot {
	readonly exchange: ExchangeView;
	readonly messages: readonly Message[];
	readonly watermark: Seq;
}

/** Read one exchange's durable discussion without starting or reconciling a room. */
export async function readExchange(
	name: string,
	from: Seq,
	options: { runtime?: Runtime } = {},
): Promise<ExchangeSnapshot | undefined> {
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

function assertFree(runtime: Runtime, name: string): void {
	if (registeredRoom(runtime, name) !== undefined)
		throw new Error(`Room '${name}' is already running: stop it before starting it again.`);
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

/** Expand the assistant shorthand before the existing composition validation path. */
function normalizeAssistant(options: StartRoomOptions): StartRoomOptions {
	const assistant = options.assistant;
	if (assistant === undefined) return options;
	const name = assistant.name;
	if (options.agents?.some((agent) => agent.name === name)) throw duplicate(name);
	if (options.summary !== undefined && options.summary !== name)
		throw new Error(`Assistant '${name}' conflicts with summary agent '${options.summary}'.`);
	const hasConfiguredAttention = options.seats !== undefined && Object.hasOwn(options.seats, name);
	const configuredAttention = hasConfiguredAttention ? options.seats?.[name] : undefined;
	if (configuredAttention !== undefined && configuredAttention !== 'broadcast')
		throw new Error(`Assistant '${name}' must use 'broadcast' attention.`);
	const seats =
		options.seats === undefined ? undefined : { ...options.seats, [name]: 'broadcast' as const };
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
		throw new Error(`Unknown summary agent '${options.summary}'.`);
	return definitions;
}

function initialSeats(
	options: StartRoomOptions,
	definitions: readonly AgentDefinition[],
): Map<string, Attention> {
	const configured = options.seats;
	const selected = new Set(
		configured === undefined
			? (options.agents ?? []).map((agent) => agent.name)
			: Object.keys(configured),
	);
	const names = new Set(definitions.map((agent) => agent.name));
	for (const name of selected) if (!names.has(name)) throw new Error(`Unknown agent '${name}'.`);
	return new Map(
		definitions
			.filter((agent) => selected.has(agent.name))
			.map((agent) => [agent.name, configured?.[agent.name] ?? 'broadcast']),
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

function duplicate(name: string): Error {
	return new Error(`Duplicate agent name '${name}': one name names one participant.`);
}
