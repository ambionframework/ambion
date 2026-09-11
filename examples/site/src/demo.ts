/**
 * One scripted run of the room, captured as JSON for a demo report.
 *
 * The products, the specialists on call, their APIs, the people and the
 * assistant all live in `room.ts`; this file only decides who arrives, what
 * they ask, when they leave, and when the process dies — then writes out
 * the event timeline, every activation with its outcome, whom the assistant
 * seated and what it wrote, the room's own log, and each seat's own
 * downstream session.
 *
 * The run crashes once, on purpose: as the first answer to Sam's question
 * lands, the runtime that holds the room is dropped, and a second runtime
 * resumes the name over the same log. What the dead run held expires, what
 * it left pending is sent again, and the exchange closes into one message.
 *
 * The record is one SQLite database on disk, and each runtime opens the file
 * for itself. The second runtime shares nothing in memory with the first, so
 * everything it knows about the room it reads off the log.
 *
 * Run it:  ANTHROPIC_API_KEY=… pnpm demo   (from examples/site)
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
	createRuntime,
	destroyWorkspace,
	isPresence,
	isSpoken,
	isSummary,
	type Message,
	resumeSession,
	type Session,
	type SessionEvent,
	type Sql,
	type SqlValue,
	sqliteSessions,
	startSession,
	stopSession,
	visitSession,
} from '@ambionframework/ambion';
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
const timeline: { at: string; event: SessionEvent }[] = [];
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
 * A short lease, so the leases the dead run held expire within seconds of the
 * resume, and a low checkpoint threshold, so the resumed room reads one row in
 * place of the rows before it. A host picks both.
 */
const LEASE = { wake: { expiry: 15_000 }, checkpoint: { rows: 24 } };
const firstDatabase = openDatabase();
const first = createRuntime({ sessions: sqliteSessions(nodeSql(firstDatabase)), ...LEASE });
let session: Session = startSession({
	name: NAME,
	goal: GOAL,
	assistant: ASSISTANT,
	agents: AGENTS,
	available: AVAILABLE,
	runtime: first,
});

/** The roster as the run starts, before any question composes it. */
const seatsAtStart = session.seats();

/** Bookkeeping: correlate every activation with the message that caused it. */
function track(event: SessionEvent, at: string): void {
	if (event.type === 'message') {
		lastSeq = event.message.seq;
		lastFrom = event.message.from;
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
		process.stderr.write(`+ ${m.from} seated${m.by ? ` by ${m.by}` : ''}\n`);
		return;
	}
	if (isSpoken(m) && !PEOPLE.has(m.from)) {
		const to = m.to ? ` → ${m.to}` : '';
		process.stderr.write(`${m.from}${to}: ${m.text.slice(0, 78)}\n`);
	}
}

/** A running commentary, so the run is watchable while it happens. */
function narrate(event: SessionEvent): void {
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
 * `settled()` is the seats alone, and the assistant writes after it: the room is
 * never held busy while one works. `quiet()` is the room with the summaries
 * in it, which is what a report wants.
 */
const quiescent = () => session.quiet();

/** Every event, from the run that holds the room now. A resumed room is watched again. */
function watch(room: Session): void {
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
watch(session);

/**
 * The room's alarm never holds the process open: `systemClock` unrefs its
 * timer, so a host decides how long its own process lives. This one lives for
 * the whole run, because the room waits on an alarm while the dead run's
 * leases run out and nothing else is in flight.
 */
const alive = setInterval(() => {}, 1000);

const step = (s: string) => {
	process.stderr.write(`\n=== ${s} ===\n`);
	steps.push({ at: new Date().toISOString(), step: s });
};

step('priya opens the room to confirm the pour date for the client');
const priyaVisit = await visitSession(session, priya);
await quiescent();

step(
	'priya asks the question she has to answer today; the assistant composes the room for it, then writes her the answer',
);
await priyaVisit.deliver({ text: 'Can I tell the client Thursday for the Level 3 pour, or not?' });
await quiescent();

step('priya leaves for a site walk without giving a new date');
await priyaVisit.leave();
await quiescent();

step('sam opens it from the deck with a forecast; the products already seated hold what he needs');
const samVisit = await visitSession(session, sam);
/** The seq of the first product answer to sam: the message the crash lands on. */
let stopWatchingForIt = () => {};
const firstAnswer = new Promise<number>((resolve) => {
	stopWatchingForIt = session.subscribe((event) => {
		if (event.type !== 'message' || !isSpoken(event.message)) return;
		if (PEOPLE.has(event.message.from)) return;
		resolve(event.message.seq);
	});
});
await samVisit.deliver({
	text: 'Rain all Thursday morning. I am not pouring into that. What do you need from me to move it?',
});
// The delivery opened the exchange, so the room goes quiet only when it
// closes. A run where every product declines has nothing to crash into: it
// takes the close instead of waiting for an answer that never comes.
const crashedAt = await Promise.race([firstAnswer, quiescent().then(() => lastSeq)]);
stopWatchingForIt();

step(
	'the process dies as the first answer to sam lands: the leases it held stay on the log, and nothing is released',
);
first.evict(NAME);
const crashedAtTime = new Date().toISOString();

step(
	'a second process resumes the room over the same log: the wakes still pending are sent again, the leases the dead run held expire, and the exchange closes',
);
const secondDatabase = openDatabase();
const second = createRuntime({
	sessions: sqliteSessions(nodeSql(secondDatabase)),
	agents: [...first.catalog.values()],
	...LEASE,
});
session = await resumeSession(NAME, { runtime: second });
watch(session);
// sam is present on the log, so the visit puts nothing on the record.
await visitSession(session, sam);
await quiescent();

step('dan opens it to price the move; the plant desk is on call for exactly this');
const danVisit = await visitSession(session, dan);
await danVisit.deliver({
	text: 'What does moving cost, and is there anything of mine holding this up?',
});
await quiescent();

step('priya comes back to decisions she did not see made');
const priyaBack = await visitSession(session, priya);
await quiescent();

// The proof the design asks for: a follow-up whose answer sits inside a range
// that has left every seat's context. The seats answer it from their summary
// and their own APIs, not from the messages the fold replaced.
step(
	'priya asks a follow-up about a range the seats now read as one message; the specialists are seated and hear it',
);
await priyaBack.deliver({
	text: 'Remind me what Saturday needs from me before I ring the client.',
});
await quiescent();

const finalRecord: Message[] = await session.messages();
const missed =
	priyaBack.since === undefined ? [] : await session.messages({ since: priyaBack.since });
const sinceOnReturn = priyaBack.since;
const seats = session.seats();
/** The seat that writes for people: the roster marks it, and nothing else tells it apart. */
const assistants = new Set(
	seats.flatMap((seat) => (seat.kind === 'agent' && seat.assistant ? [seat.name] : [])),
);

/**
 * Every downstream session the run wrote: `<room>:<agent>` for a seat, the
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
const reader = sqliteSessions(nodeSql(readerDatabase));
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

/** The room's own log: every row beside the messages, in the order they landed. */
const roomLog: { type: string; data: unknown }[] = [];
const piRoom = await reader.open(NAME);
const roomEntries = await piRoom.findEntries();
roomEntries.sort((a, b) => a.seq - b.seq);
for (const entry of roomEntries) {
	if (entry.type === 'custom') roomLog.push({ type: entry.customType, data: entry.data });
}

await stopSession(session);
clearInterval(alive);

// The drive as the run left it, then the workspace retired: the in-memory
// filesystem is dropped, and the checked-in seed on disk is untouched.
const driveAfter = await driveFiles();
await destroyWorkspace(SITE_DRIVE);
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
			record: await session.messages().catch(() => finalRecord),
			crash: { at: crashedAt, time: crashedAtTime, leaseExpiry: LEASE.wake.expiry },
			log: roomLog,
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
