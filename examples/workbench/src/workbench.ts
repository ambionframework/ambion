import { access, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CreateRuntimeOptions } from '@ambionframework/ambion';
import { type Person, people } from './definitions.ts';
import { type FileContent, type FileEntry, listFiles, readFile } from './files.ts';
import { MAX_GOAL, ROOM_NAME } from './names.ts';
import { fail, liveRoom, openRooms, type RoomAction, type RoomView } from './rooms.ts';
import { scenarios } from './scenarios.ts';

export type { Person } from './definitions.ts';
export type { FileContent, FileEntry, TableView } from './files.ts';
export type { RoomAction, RoomView } from './rooms.ts';

/**
 * The Workbench host, as the terminal sees it. It runs in the same process as the
 * terminal. Opening it hosts the rooms, and closing it stops them. Nothing in this
 * interface is a network call, so a caller may treat every method as a direct one.
 */
export interface Workbench {
	readonly people: readonly Person[];
	rooms(): Promise<RoomView[]>;
	/** Read one room. Messages come back only after `since`, an exclusive position. */
	read(room: string, since: number): Promise<RoomView>;
	/** Enter a room as a person. Entering twice records one arrival. */
	join(room: string, person: string): Promise<void>;
	/** Leave a room. A person who is not present has nothing to leave. */
	leave(room: string, person: string): Promise<void>;
	/** Send a message. The same key and text return the first exchange and add no message. */
	send(room: string, person: string, key: string, text: string): Promise<void>;
	control(room: string, action: RoomAction): Promise<RoomView>;
	create(name: string, goal: string): Promise<RoomView>;
	files(): Promise<FileEntry[]>;
	file(path: string): Promise<FileContent>;
	/** Stop every room and release the storage. The journals stay, so a later open resumes them. */
	close(): Promise<void>;
}

export interface OpenOptions {
	/** Where the journals and the workspace live. A directory with no journals starts fresh. */
	directory: string;
	/** A model stream, for tests. The default calls the configured provider. */
	stream?: CreateRuntimeOptions['stream'];
}

type Rooms = Awaited<ReturnType<typeof openRooms>>;

const exists = (path: string): Promise<boolean> =>
	access(path).then(
		() => true,
		() => false,
	);

function personNamed(name: string): Person {
	const person = people.find((candidate) => candidate.name === name);
	if (!person) fail(`Unknown person '${name}'.`);
	return person;
}

/** Open the Workbench. A fresh directory gets the sample rooms. An old one resumes its rooms. */
export async function openWorkbench(options: OpenOptions): Promise<Workbench> {
	const path = resolve(options.directory, 'rooms.db');
	const fresh = !(await exists(path));
	await mkdir(options.directory, { recursive: true });
	const database = new DatabaseSync(path);
	let rooms: Rooms | undefined;
	try {
		rooms = await openRooms(database, options.directory, options.stream);
		if (fresh) await seedRooms(rooms);
	} catch (error) {
		await rooms?.close().catch(() => undefined);
		database.close();
		throw error;
	}
	return hosted(rooms, database);
}

async function seedRooms(rooms: Rooms): Promise<void> {
	for (const scenario of scenarios) await rooms.create(scenario.name, scenario.goal);
}

function present(
	snapshot: { participants: readonly { name: string; kind: string }[] },
	name: string,
) {
	return snapshot.participants.some(
		(seat) =>
			seat.name === name &&
			seat.kind === 'human' &&
			'presence' in seat &&
			seat.presence === 'present',
	);
}

function hosted(rooms: Rooms, database: DatabaseSync): Workbench {
	let closing: Promise<void> | undefined;
	const inRoom = <T>(name: string, operation: (room: ReturnType<typeof liveRoom>) => Promise<T>) =>
		rooms.withRoom(name, (entry) => operation(liveRoom(entry)));
	return {
		people,
		rooms: () => rooms.list(),
		read: (room, since) => rooms.read(room, since),
		async join(room, person) {
			const who = personNamed(person);
			await inRoom(room, async (live) => void (await live.visit(who)));
		},
		async leave(room, person) {
			const who = personNamed(person);
			await inRoom(room, async (live) => {
				const snapshot = await live.read({ messages: false });
				if (present(snapshot, who.name)) await (await live.visit(who)).leave();
			});
		},
		async send(room, person, key, text) {
			const who = personNamed(person);
			if (!key || !text.trim()) fail('Supply a nonempty key and message.');
			await inRoom(room, async (live) => {
				const snapshot = await live.read({ messages: false });
				if (!present(snapshot, who.name)) fail('Enter this room before sending.');
				await (await live.visit(who)).send({ key, text });
			});
		},
		control: (room, action) => rooms.lifecycle(room, action),
		// Async, so a refusal is a rejected promise like every other failure of this interface.
		async create(name, goal) {
			if (!ROOM_NAME.test(name))
				fail('Use a lowercase room name, up to 48 letters, digits, or dashes.');
			const trimmed = goal.trim();
			if (!trimmed || trimmed.length > MAX_GOAL)
				fail(`Give a room goal of 1 to ${MAX_GOAL} characters.`);
			return rooms.create(name, trimmed);
		},
		files: () => rooms.withWorkspace(() => listFiles(rooms.workspace)),
		file: (path) => rooms.withWorkspace(() => readFile(rooms.workspace, path)),
		close() {
			if (closing) return closing;
			const attempt = shutdown(rooms, database);
			closing = attempt.catch((error: unknown) => {
				closing = undefined;
				throw error;
			});
			return closing;
		},
	};
}

async function shutdown(rooms: Rooms, database: DatabaseSync): Promise<void> {
	// Rooms first: a failed stop keeps its handle, so a later close retries it before
	// the storage goes away.
	await rooms.close();
	database.close();
}
