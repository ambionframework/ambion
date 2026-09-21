import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
	createRuntime,
	type ExchangeRef,
	type Room,
	type RoomRead,
	readRoom,
	resumeRoom,
	startRoom,
	type Visit,
} from '@ambionframework/ambion';
import { type Sql, type SqlValue, sqliteJournals } from '@ambionframework/journal';
import { type PiExecutionOptions, piExecution } from '@ambionframework/pi';
import { AGENTS, COMPOSITION, human, ROOM_NAME } from './room.ts';

export interface HostOptions {
	/** Where the journal lives. A directory with no journal starts a new room. */
	directory: string;
	/** A model stream, for tests. The default calls the configured provider. */
	stream?: PiExecutionOptions['stream'];
	/** Called with the text of each seat or delivery error. */
	onError?: (message: string) => void;
}

/** The room as a program uses it. Every method is a direct call. */
export interface Host {
	/** A detached read. With `since`, the messages come back after that sequence. */
	read(options?: { since?: number }): Promise<RoomRead>;
	/** Bring the person into the room. A second call records no second arrival. */
	join(): Promise<void>;
	/** Send a question as the person. The room wakes the agents. */
	send(text: string): Promise<ExchangeRef>;
	/** Stop the room and close the journal. A later open resumes the same room. */
	close(): Promise<void>;
}

function sqlOver(database: DatabaseSync): Sql {
	return {
		run: (query, ...params) => {
			database.prepare(query).run(...params);
		},
		all: (query, ...params) => database.prepare(query).all(...params) as Record<string, SqlValue>[],
	};
}

/** Open the room over a SQLite journal. It resumes a room the journal already holds. */
export async function openHost(options: HostOptions): Promise<Host> {
	await mkdir(options.directory, { recursive: true });
	const database = new DatabaseSync(resolve(options.directory, 'room.db'));
	const runtime = createRuntime({
		storage: sqliteJournals(sqlOver(database)),
		execution: piExecution({ stream: options.stream }),
	});
	let room: Room;
	try {
		const recorded = await readRoom(ROOM_NAME, { runtime, messages: false });
		room = recorded.initialized
			? await resumeRoom(ROOM_NAME, { agents: AGENTS, runtime })
			: await startRoom({ ...COMPOSITION, agents: AGENTS, runtime });
	} catch (error) {
		database.close();
		throw error;
	}
	room.subscribe((event) => {
		if (event.type === 'error' || event.type === 'delivery_error' || event.type === 'audit_error')
			options.onError?.(`[${event.agent}] error: ${event.error.message}`);
	});
	let visit: Visit | undefined;
	const enter = async (): Promise<Visit> => {
		visit ??= await room.visit(human);
		return visit;
	};
	return {
		read: (readOptions) =>
			readRoom(ROOM_NAME, {
				runtime,
				...(readOptions?.since === undefined ? {} : { messages: { since: readOptions.since } }),
			}),
		join: async () => void (await enter()),
		async send(text) {
			const exchange = await (await enter()).send({ text });
			return { owner: exchange.owner, from: exchange.from, at: exchange.at };
		},
		async close() {
			await room.stop();
			database.close();
		},
	};
}
