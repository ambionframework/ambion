import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
	type CreateRuntimeOptions,
	createRuntime,
	type Room,
	type RoomNotification,
	readRoom,
	resumeRoom,
	startRoom,
} from '@ambionframework/ambion';
import { type Sql, type SqlValue, sqliteJournals } from '@ambionframework/journal';
import { directoryBackend, openWorkspace } from '@ambionframework/workspace';
import { team } from './definitions.ts';
import { scenarios, seedWorkspace } from './scenarios.ts';

/** What a person can do to a room's work. Abort ends the open exchange. Stop and resume end and start a run. */
export type RoomAction = 'abort' | 'stop' | 'resume';

export function fail(message: string): never {
	throw new Error(message);
}

interface CatalogEntry {
	name: string;
	goal: string;
	enabled: number;
}
interface Activity {
	at: string;
	type: string;
	agent?: string;
	text: string;
}
type HostLifecycle =
	{ status: 'stopped' } | { status: 'running'; room: Room } | { status: 'stopping'; room: Room };
interface HostedRoom extends CatalogEntry {
	lifecycle: HostLifecycle;
	team: ReturnType<typeof team>;
	activity: Activity[];
	tail: Promise<unknown>;
	/** The change listeners a caller registered with `watch`. They survive a stop. */
	watchers: Set<() => void>;
}

/** The catalog records hosting intent. Collaboration state stays in each room journal. */
export async function openRooms(
	database: DatabaseSync,
	directory: string,
	stream?: CreateRuntimeOptions['stream'],
) {
	const sql: Sql = {
		run: (query, ...params) => {
			database.prepare(query).run(...params);
		},
		all: (query, ...params) => database.prepare(query).all(...params) as Record<string, SqlValue>[],
	};
	const runtime = createRuntime({ storage: sqliteJournals(sql), stream });
	database.exec(
		'CREATE TABLE IF NOT EXISTS workbench_rooms (name TEXT PRIMARY KEY, goal TEXT NOT NULL, enabled INTEGER NOT NULL)',
	);
	const entries = new Map<string, HostedRoom>();
	let closing = false;
	const workspacePath = resolve(directory, 'workspace');
	const workspace = openWorkspace({ name: 'workbench', backend: directoryBackend(workspacePath) });
	try {
		await seedWorkspace(workspacePath);
	} catch (error) {
		await workspace.dispose().catch(() => {});
		throw error;
	}
	const roomTeam = team(workspace);
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
	function attach(row: CatalogEntry): HostedRoom {
		const entry = {
			...row,
			lifecycle: { status: 'stopped' as const },
			team: roomTeam,
			activity: [],
			tail: Promise.resolve(),
			watchers: new Set<() => void>(),
		};
		entries.set(row.name, entry);
		return entry;
	}
	function save(entry: HostedRoom): void {
		database
			.prepare('UPDATE workbench_rooms SET enabled = ? WHERE name = ?')
			.run(entry.enabled, entry.name);
	}
	function serial<T>(entry: HostedRoom, operation: () => Promise<T>): Promise<T> {
		const result = entry.tail.then(operation);
		entry.tail = result.catch(() => {});
		return result;
	}
	async function run(entry: HostedRoom): Promise<void> {
		if (entry.lifecycle.status === 'running') return;
		// A failed stop still owns its room handle. Complete that cleanup before
		// creating a new run, so a stopped run cannot admit new work.
		if (entry.lifecycle.status === 'stopping') await stopEntry(entry);
		entry.enabled = 1;
		save(entry);
		const options = { agents: entry.team.agents, runtime };
		const scenario = scenarios.find((candidate) => candidate.name === entry.name);
		const recorded = await readRoom(entry.name, { runtime, messages: false });
		const room = recorded.initialized
			? await resumeRoom(entry.name, options)
			: await startRoom({
					agents: entry.team.specialists,
					assistant: entry.team.assistant,
					runtime,
					name: entry.name,
					goal: entry.goal,
					seats: scenario?.seats ?? { design: 'named' },
				});
		// The handle is owned before subscription. A later host failure leaves a
		// usable running room that shutdown can still clean up.
		entry.lifecycle = { status: 'running', room };
		room.subscribe((event) => notify(entry, event));
	}
	async function status(entry: HostedRoom) {
		return roomView(entry, await readRoom(entry.name, { runtime, messages: false }));
	}
	async function create(name: string, goal: string) {
		if (closing) fail('The host is stopping.');
		if (entries.has(name)) fail('This room already exists.');
		database
			.prepare('INSERT INTO workbench_rooms (name, goal, enabled) VALUES (?, ?, 1)')
			.run(name, goal);
		const entry = attach({ name, goal, enabled: 1 });
		return serial(entry, async () => {
			await run(entry);
			return status(entry);
		});
	}
	async function withRoom<T>(name: string, operation: (entry: HostedRoom) => Promise<T>) {
		if (closing) fail('The host is stopping.');
		const entry = entries.get(name);
		if (!entry) fail('Unknown room.');
		return serial(entry, () => operation(entry));
	}
	function watch(name: string, changed: () => void): () => void {
		const entry = entries.get(name);
		if (!entry) fail('Unknown room.');
		entry.watchers.add(changed);
		return () => {
			entry.watchers.delete(changed);
		};
	}
	async function lifecycle(name: string, action: RoomAction) {
		return withRoom(name, async (entry) => {
			switch (action) {
				case 'resume':
					await run(entry);
					break;
				case 'stop':
					await stopEntry(entry);
					// Persist the stopped intent only after durable cleanup succeeds.
					// A restart then reopens an unresolved stop for another retry.
					entry.enabled = 0;
					save(entry);
					break;
				case 'abort':
					await liveRoom(entry).abort();
					break;
			}
			return status(entry);
		});
	}
	async function closeEntry(entry: HostedRoom): Promise<void> {
		await stopEntry(entry);
	}
	async function closeEntries(): Promise<void> {
		const results = await Promise.allSettled(
			[...entries.values()].map((entry) => serial(entry, () => closeEntry(entry))),
		);
		const failure = results.find(
			(result): result is PromiseRejectedResult => result.status === 'rejected',
		);
		if (failure) throw failure.reason;
	}
	async function stopEntry(entry: HostedRoom): Promise<void> {
		if (entry.lifecycle.status === 'stopped') return;
		const room = entry.lifecycle.room;
		// Keep the handle while cleanup is in flight and after a failed write.
		entry.lifecycle = { status: 'stopping', room };
		await room.stop();
		entry.lifecycle = { status: 'stopped' };
	}
	try {
		for (const row of database.prepare('SELECT * FROM workbench_rooms ORDER BY rowid').all()) {
			const entry = attach({
				name: String(row.name),
				goal: String(row.goal),
				enabled: Number(row.enabled),
			});
			if (entry.enabled) await run(entry);
		}
	} catch (error) {
		closing = true;
		await closeEntries().catch(() => {});
		await workspaceTail.catch(() => {});
		await workspace.dispose().catch(() => {});
		throw error;
	}
	return {
		create,
		withRoom,
		watch,
		withWorkspace,
		workspace,
		lifecycle,
		list: () =>
			Promise.all([...entries.values()].map((entry) => serial(entry, () => status(entry)))),
		read: (name: string, since?: number) =>
			withRoom(name, async (entry) =>
				roomView(
					entry,
					await readRoom(entry.name, {
						runtime,
						messages: since === undefined ? undefined : { since },
					}),
				),
			),
		async close() {
			closing = true;
			// Preserve hosting intent so process restart resumes previously running rooms.
			// Each step keeps its resources when it fails, so a later close retries
			// the retained room handles before disposing shared resources.
			await closeEntries();
			await workspaceTail;
			await workspace.dispose();
		},
	};
}

/** A room as the host presents it: the recorded read, plus the hosting state and the recent work. */
export type RoomView = ReturnType<typeof roomView>;

function roomView(entry: HostedRoom, snapshot: Awaited<ReturnType<typeof readRoom>>) {
	return {
		...snapshot,
		goal: snapshot.initialized ? snapshot.goal : entry.goal,
		status: entry.lifecycle.status,
		activity: [...entry.activity],
		pattern: scenarios.find((scenario) => scenario.name === entry.name)?.pattern,
		prompt: scenarios.find((scenario) => scenario.name === entry.name)?.prompt,
	};
}

export function liveRoom(entry: HostedRoom): Room {
	if (entry.lifecycle.status !== 'running') fail('Resume this room first.');
	return entry.lifecycle.room;
}

/** One room event: record the activity it shows, then tell every watcher to read again. */
function notify(entry: HostedRoom, event: RoomNotification): void {
	recordActivity(entry, event);
	for (const watcher of [...entry.watchers]) watcher();
}

function recordActivity(entry: HostedRoom, event: RoomNotification): void {
	const activity = describeEvent(event);
	if (!activity) return;
	entry.activity.push({ at: new Date().toISOString(), ...activity });
	entry.activity.splice(0, Math.max(0, entry.activity.length - 30));
}
function describeEvent(event: RoomNotification): Omit<Activity, 'at'> | undefined {
	switch (event.type) {
		case 'error':
		case 'audit_error':
		case 'delivery_error':
			return { type: event.type, agent: event.agent, text: event.error.message };
		case 'activation_start':
			return { type: event.type, agent: event.agent, text: 'Reading and working' };
		case 'activation_end':
			return { type: event.type, agent: event.agent, text: 'Finished activation' };
		case 'tool_execution_start':
			return { type: event.type, agent: event.agent, text: `Using ${event.toolName}` };
		case 'abandoned':
			return { type: event.type, agent: event.agent, text: 'Retry limit reached' };
		default:
			return undefined;
	}
}
