import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
	type CreateRuntimeOptions,
	createRuntime,
	type Room,
	type RoomNotification,
	readExchange,
	readRoom,
	resumeRoom,
	startRoom,
} from '@ambionframework/ambion';
import { type Sql, type SqlValue, sqliteJournals } from '@ambionframework/journal';
import { directoryBackend, openWorkspace } from '@ambionframework/workspace';
import { scenarios, seedWorkspace } from './scenarios.ts';
import { team } from './team.ts';

export function fail(status: number, message: string): never {
	throw Object.assign(new Error(message), { status });
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
		'CREATE TABLE IF NOT EXISTS demo_rooms (name TEXT PRIMARY KEY, goal TEXT NOT NULL, enabled INTEGER NOT NULL)',
	);
	const columns = database.prepare('PRAGMA table_info(demo_rooms)').all() as { name: string }[];
	if (columns.some((column) => column.name === 'started'))
		database.exec('ALTER TABLE demo_rooms DROP COLUMN started');
	const entries = new Map<string, HostedRoom>();
	let closing = false;
	const workspacePath = resolve(directory, 'workspace');
	const workspace = openWorkspace({ name: 'project', backend: directoryBackend(workspacePath) });
	try {
		await seedWorkspace(workspacePath);
	} catch (error) {
		await workspace.dispose().catch(() => {});
		throw error;
	}
	const roomTeam = team(workspace);
	let workspaceTail = Promise.resolve();
	function withWorkspace<T>(operation: () => Promise<T>): Promise<T> {
		if (closing) fail(503, 'The host is stopping.');
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
		};
		entries.set(row.name, entry);
		return entry;
	}
	function save(entry: HostedRoom): void {
		database
			.prepare('UPDATE demo_rooms SET enabled = ? WHERE name = ?')
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
					...options,
					name: entry.name,
					goal: entry.goal,
					summary: 'assistant',
					seats: scenario?.seats ?? { assistant: 'broadcast', builder: 'named' },
				});
		// The handle is owned before subscription. A later host failure leaves a
		// usable running room that shutdown can still clean up.
		entry.lifecycle = { status: 'running', room };
		room.subscribe((event) => recordActivity(entry, event));
	}
	async function status(entry: HostedRoom) {
		return roomView(entry, await readRoom(entry.name, { runtime, messages: false }));
	}
	async function create(name: string, goal: string) {
		if (closing) fail(503, 'The host is stopping.');
		if (entries.has(name)) fail(409, 'This room already exists.');
		database
			.prepare('INSERT INTO demo_rooms (name, goal, enabled) VALUES (?, ?, 1)')
			.run(name, goal);
		const entry = attach({ name, goal, enabled: 1 });
		return serial(entry, async () => {
			await run(entry);
			return status(entry);
		});
	}
	async function withRoom<T>(name: string, operation: (entry: HostedRoom) => Promise<T>) {
		if (closing) fail(503, 'The host is stopping.');
		const entry = entries.get(name);
		if (!entry) fail(404, 'Unknown room.');
		return serial(entry, () => operation(entry));
	}
	async function lifecycle(name: string, action: string) {
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
				default:
					fail(404, 'Unknown lifecycle action.');
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
		for (const row of database.prepare('SELECT * FROM demo_rooms ORDER BY rowid').all()) {
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
		withWorkspace,
		workspace,
		workspacePath,
		lifecycle,
		list: () =>
			Promise.all([...entries.values()].map((entry) => serial(entry, () => status(entry)))),
		messages: (name: string, since: number) =>
			withRoom(
				name,
				async (entry) => (await readRoom(entry.name, { runtime, messages: { since } })).messages,
			),
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
		exchange: (name: string, from: number) =>
			withRoom(name, async (entry) => {
				const result = await readExchange(entry.name, from, { runtime });
				return result === undefined
					? undefined
					: { exchange: result.exchange, messages: result.messages };
			}),
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
	if (entry.lifecycle.status !== 'running') fail(409, 'Resume this room first.');
	return entry.lifecycle.room;
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
