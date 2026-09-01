/**
 * One scripted run of the workspace, captured as JSON for a demo report.
 *
 * The products, their APIs, the people and their assistants all live in
 * `workspace.ts`; this file only decides who arrives, what they ask, and when
 * they leave — then writes out the event timeline, every activation with its
 * outcome, what each assistant wrote, and each seat's own downstream session.
 *
 * Run it:  ANTHROPIC_API_KEY=… pnpm demo   (from examples/site)
 */
import { writeFileSync } from 'node:fs';
import {
	InMemorySessionRepo,
	isSpoken,
	isSummary,
	type Message,
	type SessionEvent,
	startSession,
	stopSession,
	visitSession,
} from '@ambionframework/ambion';
import {
	AGENTS,
	apiLog,
	dan,
	GOAL,
	MODEL,
	materialsState,
	priya,
	sam,
	shiftsState,
	tasksState,
	WORKSPACE,
} from './workspace.ts';

const OUT = process.env.DEMO_OUT ?? 'demo-run.json';

/** The commentary names the products, so it needs to know who is not one. */
const PEOPLE = new Set([priya.name, sam.name, dan.name]);
const repo = new InMemorySessionRepo();
const NAME = WORKSPACE;
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
let lastFrom = '(the workspace opening)';

const session = startSession({
	name: NAME,
	goal: GOAL,
	agents: AGENTS,
	repo,
});

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

/** A running commentary, so the run is watchable while it happens. */
function narrate(event: SessionEvent): void {
	if (event.type === 'message' && isSummary(event.message)) {
		const m = event.message;
		process.stderr.write(`∎ ${m.from} → ${m.to} (${m.covers.from}–${m.covers.through})\n`);
		process.stderr.write(`  ${m.text.replace(/\n/g, '\n  ')}\n`);
	}
	if (event.type === 'message' && isSpoken(event.message) && !PEOPLE.has(event.message.from)) {
		const to = event.message.to ? ` → ${event.message.to}` : '';
		process.stderr.write(`${event.message.from}${to}: ${event.message.text.slice(0, 78)}\n`);
	}
	if (event.type === 'tool_execution_start') {
		process.stderr.write(`  · ${event.agent}.${event.toolName}()\n`);
	}
	if (event.type === 'exchange_closed') {
		const { owner, from, through } = event.exchange;
		process.stderr.write(`  — ${owner}'s exchange closed (${from}–${through})\n`);
	}
	if (event.type === 'error') process.stderr.write(`! ${event.agent}: ${event.error.message}\n`);
}

/**
 * `settled()` is the seats alone, and an assistant writes after it: the room is
 * never held busy while one works. `quiet()` is the room with the summaries
 * in it, which is what a report wants.
 */
const quiescent = () => session.quiet();

session.subscribe((event) => {
	const at = new Date().toISOString();
	track(event, at);
	narrate(event);
	timeline.push(
		event.type === 'error'
			? { at, event: { ...event, error: { message: event.error.message } } as never }
			: { at, event },
	);
});

const step = (s: string) => {
	process.stderr.write(`\n=== ${s} ===\n`);
	steps.push({ at: new Date().toISOString(), step: s });
};

step('priya opens the workspace to confirm the pour date for the client');
const priyaVisit = await visitSession(session, priya);
await quiescent();

step('priya asks the question she has to answer today; her assistant writes the answer');
await priyaVisit.deliver({ text: 'Can I tell the client Thursday for the Level 3 pour, or not?' });
await quiescent();

step('priya leaves for a site walk without giving a new date');
await priyaVisit.leave();
await quiescent();

step('sam opens it from the deck with a forecast; his assistant writes for a man on a deck');
const samVisit = await visitSession(session, sam);
await samVisit.deliver({
	text: 'Rain all Thursday morning. I am not pouring into that. What do you need from me to move it?',
});
await quiescent();

step('dan opens it to price the move; his assistant writes the money');
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
step('priya asks a follow-up about a range the seats now read as one message');
await priyaBack.deliver({
	text: 'Remind me what Saturday needs from me before I ring the client.',
});
await quiescent();

const finalRecord: Message[] = await session.messages();
const missed =
	priyaBack.since === undefined ? [] : await session.messages({ since: priyaBack.since });
const sinceOnReturn = priyaBack.since;
const seats = session.seats();
/** The seats that write for somebody: an assistant is a seat with an owner. */
const assistants = new Set(
	seats.flatMap((seat) => (seat.kind === 'agent' && seat.owner ? [seat.name] : [])),
);

/**
 * Every downstream session the run wrote: `<room>:<agent>` for a seat, and
 * `<room>:<person>` for the assistant that writes for them.
 */
const seatSessions: {
	agent: string;
	kind: 'agent' | 'assistant';
	sessionId: string;
	blocks: { at: string; turns: unknown[] }[];
}[] = [];
for (const metadata of await repo.list()) {
	if (!metadata.id.startsWith(`${NAME}:`)) continue;
	const piSeat = await repo.open(metadata);
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
	const slug = metadata.id.slice(NAME.length + 1);
	seatSessions.push({
		agent: slug,
		// An assistant is a seat like any other; the roster says which seat writes
		// for a person, and that is the only thing that tells them apart.
		kind: assistants.has(slug) ? 'assistant' : 'agent',
		sessionId: metadata.id,
		blocks,
	});
}

await stopSession(session);

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
			summaries: finalRecord.filter(isSummary),
			missedOnReturn: missed,
			sinceOnReturn,
			seats,
			seatSessions,
			activations,
			toolCalls: apiLog,
			tasksAfter: tasksState,
			deliveriesAfter: materialsState.deliveries,
			overtimeAfter: shiftsState.overtimeRequests,
			people: [priya, sam, dan].map((p) => ({
				name: p.name,
				identity: p.identity,
				assistant: {
					name: p.assistant.name,
					identity: p.assistant.identity,
					instructions: p.assistant.instructions,
				},
			})),
		},
		null,
		2,
	),
);
process.stderr.write(`\nwrote ${OUT}\n`);
