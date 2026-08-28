/**
 * One scripted run of the workspace, captured as JSON for a demo report.
 *
 * The products, their APIs and the people all live in `workspace.ts`; this
 * file only decides who arrives, what they ask, and when they leave — then
 * writes out the event timeline, every activation with its outcome, and each
 * product's own downstream session.
 *
 * Run it:  ANTHROPIC_API_KEY=… pnpm demo   (from examples/site)
 */
import { writeFileSync } from 'node:fs';
import {
	InMemorySessionRepo,
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
	if (event.type === 'delivery' || event.type === 'say') {
		lastSeq = event.message.seq;
		lastFrom = event.message.from;
		return;
	}
	if (event.type === 'agent_start') {
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
	const open = openBySeat.get('agent' in event ? event.agent : '');
	if (!open) return;
	if (event.type === 'tool_execution_start') open.tools.push(event.toolName);
	if (event.type === 'say_conflict') open.conflicts += 1;
	if (event.type === 'agent_end') {
		open.endedAt = at;
		open.spoke = event.spoke;
		openBySeat.delete(event.agent);
	}
}

/** A running commentary, so the run is watchable while it happens. */
function narrate(event: SessionEvent): void {
	if (event.type === 'say') {
		const to = event.message.to ? ` → ${event.message.to}` : '';
		process.stderr.write(`${event.agent}${to}: ${event.message.text.slice(0, 78)}\n`);
	}
	if (event.type === 'tool_execution_start') {
		process.stderr.write(`  · ${event.agent}.${event.toolName}()\n`);
	}
	if (event.type === 'error') process.stderr.write(`! ${event.agent}: ${event.error.message}\n`);
}

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
await session.settled();

step('priya asks the question she has to answer today');
await priyaVisit.deliver({ text: 'Can I tell the client Thursday for the Level 3 pour, or not?' });
await session.settled();

step('priya leaves for a site walk without giving a new date');
await priyaVisit.leave();
await session.settled();

step('sam opens it from the deck with a forecast');
const samVisit = await visitSession(session, sam);
await samVisit.deliver({
	text: 'Rain all Thursday morning. I am not pouring into that. What do you need from me to move it?',
});
await session.settled();

step('dan opens it to price the move');
const danVisit = await visitSession(session, dan);
await danVisit.deliver({
	text: 'What does moving cost, and is there anything of mine holding this up?',
});
await session.settled();

step('priya comes back to decisions she did not see made');
const priyaBack = await visitSession(session, priya);
await session.settled();

const finalRecord: Message[] = await session.messages();
const missed =
	priyaBack.since === undefined ? [] : await session.messages({ since: priyaBack.since });
const sinceOnReturn = priyaBack.since;
const seats = session.seats();

const seatSessions: {
	agent: string;
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
	seatSessions.push({ agent: metadata.id.slice(NAME.length + 1), sessionId: metadata.id, blocks });
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
			missedOnReturn: missed,
			sinceOnReturn,
			seats,
			seatSessions,
			activations,
			toolCalls: apiLog,
			tasksAfter: tasksState,
			deliveriesAfter: materialsState.deliveries,
			overtimeAfter: shiftsState.overtimeRequests,
			people: [priya, sam, dan].map((p) => ({ name: p.name, identity: p.identity })),
		},
		null,
		2,
	),
);
process.stderr.write(`\nwrote ${OUT}\n`);
