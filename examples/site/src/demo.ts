/**
 * One scripted run of the room, captured as JSON for a demo report.
 *
 * The products, the specialists on call, their APIs, the people and the
 * assistant all live in `room.ts`; this file only decides who arrives, what
 * they ask, when they leave, and when the runtime is evicted — then writes out
 * the event timeline, every activation with its outcome, whom the assistant
 * seated and what it wrote, the room's own journal, and each seat's own
 * downstream room.
 *
 * The run evicts one runtime once, on purpose: as the first answer to Sam's
 * question lands, that in-process runtime is dropped, and a second runtime
 * resumes the room over the same journal. What the evicted runtime held
 * expires, what it left pending is sent again, and the exchange closes into
 * one message.
 *
 * The room state is one SQLite database on disk, and each runtime opens the
 * file for itself. The second runtime reconstructs the room from the journal;
 * this same-process demo still shares the workspace and product state that
 * live in `room.ts`.
 *
 * Run it:  ANTHROPIC_API_KEY=… pnpm demo   (from examples/site)
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
	createRuntime,
	isPresence,
	isSeatedAgent,
	isSpoken,
	isSummary,
	type Message,
	type Room,
	type RoomNotification,
	resumeRoom,
	startRoom,
} from '@ambionframework/ambion';
import { namespaced, type Sql, type SqlValue, sqliteJournals } from '@ambionframework/journal';
import { piSessions } from '@ambionframework/journal/pi';
import {
	AGENTS,
	ASSISTANT,
	AVAILABLE,
	apiLog,
	dan,
	driveFiles,
	GOAL,
	inspectionsState,
	MODEL,
	materialsState,
	plantState,
	priya,
	ROOM_NAME,
	SITE_DRIVE,
	sam,
	shiftsState,
	TODAY,
	tasksState,
	temporaryWorksState,
} from './room.ts';

const OUT = process.env.DEMO_OUT ?? 'demo-run.json';

/** The commentary names the products, so it needs to know who is not one. */
const PEOPLE = new Set([priya.name, sam.name, dan.name]);
/** The four tools a workspace binds; every other tool is a product's own API. */
const WORKSPACE_TOOLS = new Set(['read', 'write', 'edit', 'bash']);
const NAME = ROOM_NAME;
const DB = join(mkdtempSync(join(tmpdir(), 'ambion-demo-')), 'room.db');

/** The two calls the core's SQLite storage makes. A host wraps its own driver in them. */
function nodeSql(database: DatabaseSync): Sql {
	return {
		run: (query, ...params) => {
			database.prepare(query).run(...params);
		},
		all: (query, ...params) => database.prepare(query).all(...params) as Record<string, SqlValue>[],
	};
}

/** One connection per runtime, on one file: a resumed room reads what a dead one wrote. */
function openDatabase(): DatabaseSync {
	const database = new DatabaseSync(DB);
	database.exec('PRAGMA journal_mode = WAL');
	return database;
}
const timeline: { at: string; event: RoomNotification }[] = [];
const steps: { at: string; step: string }[] = [];

interface Activation {
	agent: string;
	trigger: number;
	triggerFrom: string;
	startedAt: string;
	endedAt?: string;
	spoke?: boolean;
	tools: string[];
	conflicts: number;
	block?: number | null;
	cost?: number;
	tokens?: number;
}
const activations: Activation[] = [];
const openBySeat = new Map<string, Activation>();
let lastSeq = 0;
let lastFrom = '(the room opening)';

/** The drive as every run starts: the seed, before any product touches it. */
const driveBefore = await driveFiles();

/**
 * A short lease, so the leases the evicted runtime held expire within seconds of the
 * resume. A host picks the lease policy; the journal retains the complete
 * ordered history so a resumed room derives the same state.
 */
const LEASE = { wake: { expiry: 15_000 } };
const firstDatabase = openDatabase();
const firstSql = nodeSql(firstDatabase);
const first = createRuntime({
	storage: sqliteJournals(firstSql),
	...LEASE,
});
let room: Room = await startRoom({
	name: NAME,
	goal: GOAL,
	assistant: ASSISTANT,
	agents: AGENTS,
	available: AVAILABLE,
	runtime: first,
});

/** The roster as the run starts, before any question composes it. */
const seatsAtStart = room.seats();

/** Bookkeeping: correlate every activation with the message that caused it. */
function track(event: RoomNotification, at: string): void {
	if (event.type === 'message') {
		lastSeq = event.message.seq;
		// A seating the host decided has no author, so the room itself caused it.
		lastFrom = event.message.from ?? '(the room)';
		return;
	}
	if (event.type === 'activation_start') {
		const a: Activation = {
			agent: event.agent,
			trigger: lastSeq,
			triggerFrom: lastFrom,
			startedAt: at,
			tools: [],
			conflicts: 0,
		};
		activations.push(a);
		openBySeat.set(event.agent, a);
		return;
	}
	const open = openBySeat.get(
		'agent' in event ? event.agent : 'author' in event ? event.author : '',
	);
	if (!open) return;
	if (event.type === 'tool_execution_start') open.tools.push(event.toolName);
	if (event.type === 'conflict') open.conflicts += 1;
	if (event.type === 'activation_end') {
		open.endedAt = at;
		open.spoke = event.spoke;
		openBySeat.delete(event.agent);
	}
}

/** One line per tool call, and the four workspace tools say where they reach. */
function toolLine(event: { agent: string; toolName: string }): string {
	const where = WORKSPACE_TOOLS.has(event.toolName) ? ' on the drive' : '';
	return `  · ${event.agent}.${event.toolName}()${where}\n`;
}

/** One message on the record, as the commentary shows it. */
function narrateMessage(m: Message): void {
	if (isSummary(m)) {
		process.stderr.write(`∎ ${m.from} → ${m.to} (${m.covers.from}–${m.covers.through})\n`);
		process.stderr.write(`  ${m.text.replace(/\n/g, '\n  ')}\n`);
		return;
	}
	if (isPresence(m) && m.kind === 'seated') {
		process.stderr.write(`+ ${m.subject} seated${m.from ? ` by ${m.from}` : ''}\n`);
		return;
	}
	if (isSpoken(m) && !PEOPLE.has(m.from)) {
		const to = m.to ? ` → ${m.to}` : '';
		process.stderr.write(`${m.from}${to}: ${m.text.slice(0, 78)}\n`);
	}
}

/** A running commentary, so the run is watchable while it happens. */
function narrate(event: RoomNotification): void {
	if (event.type === 'message') narrateMessage(event.message);
	if (event.type === 'tool_execution_start') process.stderr.write(toolLine(event));
	if (event.type === 'exchange_closed') {
		const { owner, from, through } = event.exchange;
		process.stderr.write(`  — ${owner}'s exchange closed (${from}–${through})\n`);
	}
	if (event.type === 'error') process.stderr.write(`! ${event.agent}: ${event.error.message}\n`);
	if (event.type === 'abandoned') {
		process.stderr.write(`! the room gave up on ${event.agent} (${event.activation})\n`);
	}
}

/**
 * An exchange handle waits for its durable close and its assistant response.
 */

/** Every event, from the run that holds the room now. A resumed room is watched again. */
function watch(room: Room): void {
	room.subscribe((event) => {
		const at = new Date().toISOString();
		track(event, at);
		narrate(event);
		timeline.push(
			event.type === 'error'
				? { at, event: { ...event, error: { message: event.error.message } } as never }
				: { at, event },
		);
	});
}
watch(room);

/**
 * The room's alarm never holds the process open: `systemClock` unrefs its
 * timer, so a host decides how long its own process lives. This one lives for
 * the whole run, because the room waits on an alarm while the evicted runtime's
 * leases run out and nothing else is in flight.
 */
const alive = setInterval(() => {}, 1000);

const step = (s: string) => {
	process.stderr.write(`\n=== ${s} ===\n`);
	steps.push({ at: new Date().toISOString(), step: s });
};

step('priya opens the room to confirm the pour date for the client');
const priyaVisit = await room.visit(priya);
const initial = await priyaVisit.send({
	text: 'Can I tell the client Thursday for the Level 3 pour, or not?',
});
await initial.response();

step(
	'priya asks the question she has to answer today; the assistant composes the room for it, then writes her the answer',
);
// The response above is the durable result of Priya's exchange.

step('priya leaves for a site walk without giving a new date');
await priyaVisit.leave();

step('sam opens it from the deck with a forecast; the products already seated hold what he needs');
const samVisit = await room.visit(sam);
/** The seq of the first product answer to sam: the message the crash lands on. */
let stopWatchingForIt = () => {};
const firstAnswer = new Promise<number>((resolve) => {
	stopWatchingForIt = room.subscribe((event) => {
		if (event.type !== 'message' || !isSpoken(event.message)) return;
		if (PEOPLE.has(event.message.from)) return;
		resolve(event.message.seq);
	});
});
const samExchange = await samVisit.send({
	text: 'Rain all Thursday morning. I am not pouring into that. What do you need from me to move it?',
});
// The delivery opened the exchange, so the room goes quiet only when it
// closes. A run where every product declines has nothing to crash into: it
// takes the close instead of waiting for an answer that never comes.
const crashedAt = await Promise.race([firstAnswer, samExchange.waitForClose().then(() => lastSeq)]);
stopWatchingForIt();

step(
	'the runtime is evicted as the first answer to sam lands: the leases it held stay on the journal, and nothing is released',
);
first.evict(NAME);
const crashedAtTime = new Date().toISOString();

step(
	'a second runtime resumes the room over the same journal: the wakes still pending are sent again, the leases the evicted run held expire, and the exchange closes',
);
const secondDatabase = openDatabase();
const secondSql = nodeSql(secondDatabase);
const second = createRuntime({
	storage: sqliteJournals(secondSql),
	...LEASE,
});
room = await resumeRoom(NAME, {
	runtime: second,
	agents: [ASSISTANT, ...AGENTS, ...AVAILABLE].map((value) =>
		isSeatedAgent(value) ? value.agent : value,
	),
});
watch(room);
// sam is present on the journal, so the visit puts nothing on the record.
await room.visit(sam);

step('dan opens it to price the move; the plant desk is on call for exactly this');
const danVisit = await room.visit(dan);
const danExchange = await danVisit.send({
	text: 'What does moving cost, and is there anything of mine holding this up?',
});
await danExchange.response();

step('priya comes back to decisions she did not see made');
const priyaBack = await room.visit(priya);

// The proof the design asks for: a follow-up whose answer sits inside a range
// that has left every seat's context. The seats answer it from their summary
// and their own APIs, not from the messages the fold replaced.
step(
	'priya asks a follow-up about a range the seats now read as one message; the specialists are seated and hear it',
);
const followUp = await priyaBack.send({
	text: 'Remind me what Saturday needs from me before I ring the client.',
});
await followUp.response();

const missed = priyaBack.since === undefined ? [] : await room.messages({ since: priyaBack.since });
const sinceOnReturn = priyaBack.since;

// Stop before capture so the room journal and record include the same final presence entries.
await room.stop();
const finalRecord: Message[] = await room.messages();
const seats = room.seats();
/** The seat that writes for people: the roster names its role, and nothing else tells it apart. */
const assistants = new Set(
	seats.flatMap((seat) => (seat.kind === 'agent' && seat.assistant ? [seat.name] : [])),
);

/**
 * Every downstream room the run wrote: `<room>:<agent>` for a seat, the
 * assistant's among them.
 */
const seatSessions: {
	agent: string;
	kind: 'agent' | 'assistant';
	sessionId: string;
	blocks: { at: string; turns: unknown[] }[];
}[] = [];
/** The record, read back through a third connection: nothing of the run is in it. */
const readerDatabase = openDatabase();
const readerStorage = sqliteJournals(nodeSql(readerDatabase));
const reader = piSessions(readerStorage);
for (const seat of seats) {
	if (seat.kind !== 'agent') continue;
	const id = seat.sessionId;
	const piSeat = await reader.open(id);
	const entries = await piSeat.findEntries();
	entries.sort((a, b) => a.seq - b.seq);
	const blocks: { at: string; turns: unknown[] }[] = [];
	for (const entry of entries) {
		if (entry.type === 'custom' && entry.customType === 'ambion/activation') {
			blocks.push({ at: (entry.data as { at: string }).at, turns: [] });
			continue;
		}
		if (entry.type !== 'message') continue;
		const message = (entry as { message?: unknown }).message;
		if (message !== undefined) blocks.at(-1)?.turns.push(message);
	}
	seatSessions.push({
		agent: seat.name,
		// The assistant is a seat like any other; the roster says which seat writes
		// for people, and that is the only thing that tells them apart.
		kind: assistants.has(seat.name) ? 'assistant' : 'agent',
		sessionId: id,
		blocks,
	});
}

/** The room's own native journal envelope, in storage order. */
const roomLog = (await (await namespaced(readerStorage, 'ambion/room').open(NAME)).read(0)).entries;

clearInterval(alive);

// The drive as the run left it, then the workspace retired: the in-memory
// filesystem is dropped, and the checked-in seed on disk is untouched.
const driveAfter = await driveFiles();
await SITE_DRIVE.destroy();
firstDatabase.close();
secondDatabase.close();
readerDatabase.close();
rmSync(join(DB, '..'), { recursive: true, force: true });
process.stderr.write(`\ndrive destroyed and the record dropped after capture\n`);

writeFileSync(
	OUT,
	JSON.stringify(
		{
			model: MODEL,
			name: NAME,
			ranAt: new Date().toISOString(),
			steps,
			timeline,
			record: finalRecord,
			crash: { at: crashedAt, time: crashedAtTime, leaseExpiry: LEASE.wake.expiry },
			journal: roomLog,
			summaries: finalRecord.filter(isSummary),
			missedOnReturn: missed,
			sinceOnReturn,
			seatsAtStart,
			seats,
			reserve: AVAILABLE.map((agent) => ({ name: agent.name, identity: agent.identity })),
			seatings: finalRecord.filter(isPresence).filter((m) => m.kind === 'seated'),
			seatSessions,
			activations,
			toolCalls: apiLog,
			drive: {
				workspace: SITE_DRIVE.name,
				today: TODAY,
				before: driveBefore,
				after: driveAfter,
			},
			tasksAfter: tasksState,
			deliveriesAfter: materialsState.deliveries,
			overtimeAfter: shiftsState.overtimeRequests,
			inspectionsAfter: inspectionsState,
			hiresAfter: plantState.hires,
			checksAfter: temporaryWorksState,
			assistant: {
				name: ASSISTANT.name,
				identity: ASSISTANT.identity,
				instructions: ASSISTANT.instructions,
			},
			people: [priya, sam, dan].map((p) => ({
				name: p.name,
				identity: p.identity,
				preferences: p.preferences,
			})),
		},
		null,
		2,
	),
);
process.stderr.write(`\nwrote ${OUT}\n`);
