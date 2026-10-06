import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
	createRuntime,
	type Room,
	type RoomNotification,
	readRoom,
	type TraceStep,
} from '@ambionframework/ambion';
import type { Execution } from '@ambionframework/ambion/hosting';
import {
	type CanvasError,
	type CanvasEvent,
	type CanvasRoom,
	type CanvasWidget,
	openCanvas,
	sqliteCanvas,
	type WidgetAct,
} from '@ambionframework/canvas';
import { claudeExecution } from '@ambionframework/claude';
import { codexExecution } from '@ambionframework/codex';
import { sqliteJournals } from '@ambionframework/journal';
import { directoryBackend } from '@ambionframework/just-bash';
import { type PiExecutionOptions, piExecution } from '@ambionframework/pi';
import { openWorkspace } from '@ambionframework/workspace';
import { sqliteBackend } from '@ambionframework/workspace/sqlite';
import type { Answered } from './action-state.ts';
import { readApprovals } from './approvals.ts';
import { type Person, team, workerNames } from './definitions.ts';
import { openInstrument } from './instrument.ts';
import {
	type Environment,
	type ExecutorKind,
	hasKey,
	keyVariable,
	unavailableSeats,
} from './kinds.ts';
import { PIN_KINDS, type Pins } from './pins.ts';
import { WORKSPACE } from './refs.ts';
import { labRepositories } from './repositories.ts';
import { instruments, labAppendOnly, labSchema, scenarios, seedWorkspace } from './scenarios.ts';
import { sqlOf } from './sql.ts';
import { stepLog } from './steps.ts';
import { unavailable } from './unavailable.ts';

/** What a person can do to a room's work. Cancel ends the open exchange. Stop and resume end and start a run. */
export type RoomAction = 'cancel' | 'stop' | 'resume';

export function fail(message: string): never {
	throw new Error(message);
}

interface Activity {
	at: string;
	type: string;
	seat?: string;
	text: string;
}
/** What the host shows of a room besides its row and its journal. The canvas owns the row. */
interface RoomState {
	activity: Activity[];
	/**
	 * Why each failed activation failed, by activation id, from the `end` step
	 * of its trace. The journal holds only the cause, so a restart loses the
	 * reason. The oldest go first past a fixed count.
	 */
	failures: Map<string, string>;
	/** The change listeners a caller registered with `watch`. They survive a stop. */
	watchers: Set<() => void>;
	/** The pins of the room, read at the last widget event or room start. */
	pins: Promise<Pins> | undefined;
}

/** What the rooms run on. A test passes `stream` and `executions` and needs no key. */
export interface RoomsOptions {
	/** A model stream for the Pi seats. */
	stream?: PiExecutionOptions['stream'];
	/**
	 * Executions that replace the executors of each kind. A test passes a
	 * scripted execution for each. Without them, the real executor runs.
	 */
	executions?: { pi?: Execution; claude?: Execution; codex?: Execution };
	/** The environment that holds the keys. The default is the environment of the process. */
	env?: Environment;
}

/**
 * The execution of each executor kind, for the seats of that kind alone. A kind
 * with a replacement or a stream runs that. A live kind with no key gets
 * an execution that fails its seats with the name of the missing variable,
 * so the other seats keep running.
 */
function kindExecutions(options: RoomsOptions = {}): readonly Execution[] {
	const { stream, executions, env = process.env } = options;
	const scripted = stream !== undefined || executions !== undefined;
	const pick = (kind: ExecutorKind, live: () => Execution, replacement?: Execution): Execution => {
		if (replacement) return { kind, connector: (host) => replacement.connector(host) };
		if (scripted)
			return unavailable(kind, `the test gave the ${kind} executor no scripted execution.`);
		if (hasKey(kind, env)) return live();
		return unavailable(
			kind,
			`${keyVariable(kind, env)} is not set, and the ${kind} executor needs it.`,
		);
	};
	return [
		pick(
			'pi',
			() => piExecution({ stream }),
			// A test gives the stream, and its sessions stay in memory.
			executions?.pi ?? (stream && piExecution({ stream, sessions: 'memory' })),
		),
		// The Claude seat takes the allowlist of the host environment, unless the caller gave an env.
		pick(
			'claude',
			() => (options.env === undefined ? claudeExecution() : claudeExecution({ env: options.env })),
			executions?.claude,
		),
		pick('codex', () => codexExecution({ env }), executions?.codex),
	];
}

/** The canvas records hosting intent. Collaboration state stays in each room journal. */
export async function openRooms(
	database: DatabaseSync,
	directory: string,
	options: RoomsOptions = {},
) {
	const sql = sqlOf(database);
	// A test that supplies executions runs no live executor, so no seat lacks a key.
	const missing =
		options.stream || options.executions
			? []
			: unavailableSeats(options.env ?? process.env).map(({ seat }) => seat);
	const states = new Map<string, RoomState>();
	const stateOf = (name: string): RoomState => {
		const found = states.get(name);
		if (found) return found;
		const created = {
			activity: [],
			failures: new Map<string, string>(),
			watchers: new Set<() => void>(),
			pins: undefined,
		};
		states.set(name, created);
		return created;
	};
	// The steps of each activation go to a log in this process. Each step
	// tells the watchers of its room to read again.
	const log = stepLog();
	const runtime = createRuntime({
		storage: sqliteJournals(sql),
		execution: kindExecutions(options),
		logger: (record) => {
			log.logger(record);
			const state = stateOf(record.room);
			recordFailure(state, record.step);
			// A file can change through any tool, so the end of an activation reads the pins again.
			if (record.step.type === 'end') state.pins = undefined;
			changed(state);
		},
	});
	let closing = false;
	const workspacePath = resolve(directory, 'workspace');
	const workspace = openWorkspace({
		name: WORKSPACE,
		backend: {
			bash: directoryBackend(workspacePath, {
				git: labRepositories(resolve(directory, 'git.db')),
			}),
			// The lab records live in their own file, apart from the journal database.
			sql: sqliteBackend(resolve(directory, 'lab.db'), {
				schema: labSchema,
				appendOnly: labAppendOnly,
				provenance: true,
			}),
		},
		audit: {},
		rooms: true,
	});
	const lab = workspace.sql;
	if (lab === undefined) fail('The workspace has no lab database.');
	try {
		await seedWorkspace(workspacePath);
		// The first call opens the lab database, runs its schema, and guards its tables.
		await lab.use(workspace.mirrorAgent, (env) => env.run('SELECT 1', { maxRows: 0 }));
	} catch (error) {
		await workspace.dispose().catch(() => {});
		throw error;
	}
	let workspaceTail = Promise.resolve();
	function withWorkspace<T>(operation: () => Promise<T>): Promise<T> {
		if (closing) fail('The host is stopping.');
		const result = workspaceTail.then(operation);
		workspaceTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
	// The canvas attaches the mirror of each room, so the host attaches none.
	const canvas = openCanvas({
		name: 'workbench',
		runtime,
		store: sqliteCanvas(sql),
		workspace,
		breakout: { team: workerNames },
		widgets: { kinds: PIN_KINDS },
		onError: (failure) => reportFailure(stateOf(failure.room), failure),
	});
	// The canvas exists first: an agent reads its bundle when it is defined.
	const roomTeam = team(workspace, openInstrument({ lab, instruments }), canvas);
	canvas.subscribe((event) => heardEvent(event, stateOf, (name) => canvas.room(name)));
	/**
	 * The pins of a room. `read` runs once after each widget event, room start,
	 * archive, and end of an activation, and the answer stays until the next one.
	 * A stopped room reads nothing again, and an archived room has no pins.
	 */
	async function pinned(
		name: string,
		read: (
			widgets: readonly CanvasWidget[],
			answers: ReadonlyMap<string, Answered>,
		) => Promise<Pins>,
	): Promise<Pins> {
		if (known(name).state === 'archived') return { pins: [], more: 0 };
		const state = stateOf(name);
		const widgets = canvas.widgets(name);
		state.pins ??= answered(name)
			.then((answers) => read(widgets, answers))
			.catch((error: unknown) => {
				state.pins = undefined;
				throw error;
			});
		return state.pins;
	}
	/** The answers of a room, each with the person who answered it. A stopped room names no person. */
	async function answered(name: string): Promise<Map<string, Answered>> {
		const seqs = canvas.answers(name);
		const first = Math.min(...seqs.values());
		const read =
			seqs.size > 0 ? await canvas.room(name)?.read({ messages: { after: first - 1 } }) : undefined;
		const from = new Map<number, string>();
		for (const message of read?.messages ?? [])
			if (message.kind === 'said') from.set(message.seq, message.from);
		return new Map(
			[...seqs].map(([revision, seq]) => {
				const by = from.get(seq);
				return [revision, by === undefined ? { seq } : { seq, by }];
			}),
		);
	}
	try {
		await canvas.resume({ agents: roomTeam.agents });
	} catch (error) {
		closing = true;
		await canvas.close().catch(() => {});
		await workspaceTail.catch(() => {});
		await workspace.dispose().catch(() => {});
		throw error;
	}
	/** The row of a room, or a refusal. */
	function known(name: string): CanvasRoom {
		return canvas.rooms().find((row) => row.name === name) ?? fail('Unknown room.');
	}
	/** The live room, or a refusal that tells the person to resume it. */
	function liveRoom(name: string): Room {
		if (closing) fail('The host is stopping.');
		known(name);
		return canvas.room(name) ?? fail('Resume this room first.');
	}
	async function inRoom<T>(name: string, operation: (room: Room) => Promise<T>) {
		return operation(liveRoom(name));
	}
	async function view(row: CanvasRoom, messages: ReadMessages = false) {
		return roomView(
			row,
			stateOf(row.name),
			await readRoom(row.name, { runtime, messages }),
			canvas.room(row.name) !== undefined,
			missing,
		);
	}
	async function create(name: string, goal: string) {
		if (closing) fail('The host is stopping.');
		if (canvas.rooms().some((row) => row.name === name)) fail('This room already exists.');
		const scenario = scenarios.find((candidate) => candidate.name === name);
		await canvas.open({
			name,
			goal,
			agents: roomTeam.specialists.map((agent) => agent.name),
			assistant: roomTeam.assistant.name,
			seats: scenario?.seats ?? { design: 'named' },
		});
		return view(known(name));
	}
	function watch(name: string, listener: () => void): () => void {
		known(name);
		const { watchers } = stateOf(name);
		watchers.add(listener);
		return () => {
			watchers.delete(listener);
		};
	}
	async function lifecycle(name: string, action: RoomAction) {
		if (closing) fail('The host is stopping.');
		known(name);
		switch (action) {
			case 'resume':
				await canvas.start(name);
				break;
			case 'stop':
				await canvas.stop(name);
				break;
			case 'cancel':
				await liveRoom(name).cancel();
				break;
		}
		return view(known(name));
	}
	let shutdown: Promise<void> | undefined;
	async function close(): Promise<void> {
		closing = true;
		// Each room keeps its row, so a restart resumes the rooms that ran. The
		// canvas reports a stop that failed and stops the other rooms.
		await canvas.close();
		await workspaceTail;
		await workspace.dispose();
	}
	return {
		create,
		inRoom,
		pinned,
		/** Press an action of a widget as a person. The canvas checks it and sends it as a message. */
		act(person: Person, act: WidgetAct) {
			if (closing) fail('The host is stopping.');
			return canvas.act(person, act);
		},
		watch,
		withWorkspace,
		workspace,
		lifecycle,
		/** The steps of one activation that this process logged. */
		activation: async (name: string, id: string) => {
			known(name);
			return log.read(name, id);
		},
		/** The operations of a room that wait for the person of their exchange. */
		approvals: async (name: string) => {
			known(name);
			return readApprovals(lab, name);
		},
		list: () => Promise.all(canvas.rooms().map((row) => view(row))),
		read: async (name: string, after?: number) =>
			view(known(name), after === undefined ? undefined : { after }),
		close() {
			shutdown ??= close().catch((error: unknown) => {
				shutdown = undefined;
				throw error;
			});
			return shutdown;
		},
	};
}

type ReadMessages = NonNullable<Parameters<typeof readRoom>[1]>['messages'];

/** A room as the host presents it: the recorded read, plus the hosting state and the recent work. */
export type RoomView = Awaited<ReturnType<typeof roomView>>;

function roomView(
	row: CanvasRoom,
	state: RoomState,
	snapshot: Awaited<ReturnType<typeof readRoom>>,
	running: boolean,
	unavailable: readonly string[],
) {
	const scenario = scenarios.find((candidate) => candidate.name === row.name);
	return {
		...snapshot,
		/** The seats that cannot run because their executor kind has no key. */
		unavailable,
		goal: snapshot.initialized ? snapshot.goal : row.goal,
		/** The parent of a breakout room. A root room has none. */
		parent: row.start.kind === 'breakout' ? row.start.parent : undefined,
		status: running ? ('running' as const) : ('stopped' as const),
		activity: [...state.activity],
		failures: new Map(state.failures) as ReadonlyMap<string, string>,
		pattern: scenario?.pattern,
		prompt: scenario?.prompt,
	};
}

/** Tell every watcher of a room to read again. */
function changed(state: RoomState): void {
	for (const watcher of [...state.watchers]) watcher();
}

/** A room that the canvas starts: hear its events, and tell the watchers of each change. */
function heardEvent(
	event: CanvasEvent,
	stateOf: (name: string) => RoomState,
	room: (name: string) => Room | undefined,
): void {
	const name = roomOf(event);
	const state = stateOf(name);
	// A widget event, an answer, a start, and an archive change what the pins show.
	if (['widget', 'answered', 'started', 'archived'].includes(event.type)) state.pins = undefined;
	if (event.type === 'started') room(name)?.subscribe((heard) => notify(state, heard));
	changed(state);
}

/** The name of the room that an event is about. */
function roomOf(event: CanvasEvent): string {
	if (event.type === 'widget') return event.widget.room;
	return event.type === 'opened' ? event.room.name : event.room;
}

/** A failure that the canvas survived goes to the activity list, where the person reads it. */
function reportFailure(state: RoomState, failure: CanvasError): void {
	const reason = failure.error instanceof Error ? failure.error.message : String(failure.error);
	const text =
		failure.operation === 'mirror'
			? `The room mirror failed: ${reason}`
			: `The ${failure.operation} of the room failed: ${reason}`;
	pushActivity(state, { type: 'error', text });
	changed(state);
}

/** One room event: record the activity it shows, then tell every watcher to read again. */
function notify(state: RoomState, event: RoomNotification): void {
	recordActivity(state, event);
	changed(state);
}

/** How many failure reasons a room keeps. */
const FAILURES_KEPT = 100;

/** Keep the reason of an activation that ended on a failure. */
function recordFailure(state: RoomState, step: TraceStep): void {
	if (step.type !== 'end' || step.failure === undefined) return;
	state.failures.set(step.activation, step.failure.message);
	for (const oldest of state.failures.keys()) {
		if (state.failures.size <= FAILURES_KEPT) break;
		state.failures.delete(oldest);
	}
}

function recordActivity(state: RoomState, event: RoomNotification): void {
	const activity = describeEvent(event);
	if (activity) pushActivity(state, activity);
}

function pushActivity(state: RoomState, activity: Omit<Activity, 'at'>): void {
	state.activity.push({ at: new Date().toISOString(), ...activity });
	state.activity.splice(0, Math.max(0, state.activity.length - 30));
}
function describeEvent(event: RoomNotification): Omit<Activity, 'at'> | undefined {
	switch (event.type) {
		case 'error':
		case 'port_error':
			return { type: event.type, seat: event.seat, text: event.error.message };
		case 'activation_start':
			return { type: event.type, seat: event.seat, text: 'Reading and working' };
		case 'activation_end':
			return { type: event.type, seat: event.seat, text: 'Finished activation' };
		case 'tool_call':
			return { type: event.type, seat: event.seat, text: `Using ${event.name}` };
		case 'abandoned':
			return { type: event.type, seat: event.seat, text: 'Retry limit reached' };
		default:
			return undefined;
	}
}
