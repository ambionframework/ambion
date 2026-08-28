/**
 * An interactive multi-agent session in your terminal: a working room
 * advancing an initiative you bring to it.
 *
 * - `lead` (idle) — the tech lead, managing an engineering team: feasibility,
 *   estimates, sequencing, technical risk. Checks team capacity with a tool.
 * - `designer` (idle) — speaks when the user experience is at stake, and is
 *   otherwise the quiet seat: "· designer stayed quiet" is silence working.
 * - `product` (idle) — owns scope and priority, and pulls the right colleague
 *   in with a directed say instead of asking the room.
 * - `exec` (idle) — engages on resource allocation and time-to-market
 *   decisions; everything else passes without a word.
 * - `planner` (passive) — the project manager: hears nothing until named.
 *   The room routes every decision to it with a directed say, so the plan
 *   and progress summary stay current. Ask `@planner where are we?`.
 *
 * Run it:  ANTHROPIC_API_KEY=… pnpm start   (from examples/room)
 */

import * as readline from 'node:readline';
import {
	defineAgent,
	defineHuman,
	defineTool,
	isSpoken,
	passive,
	type SessionEvent,
	startSession,
	stopSession,
	type Visit,
	visitSession,
} from '@ambionframework/ambion';
import { Type } from 'typebox';

const MODEL = process.env.AMBION_MODEL ?? 'anthropic/claude-sonnet-4-5';

// -- one tool, so tool_execution events are visible ---------------------------

const teamStatus = defineTool({
	name: 'team_status',
	description: "Check the engineering team's current sprint capacity and workload.",
	parameters: Type.Object({}),
	execute: () =>
		'6 engineers; 2 committed to the payments migration through next sprint; ' +
		'4 available; on-call rotation costs ~0.5 heads; no planned leave for 3 weeks.',
});

// -- the cast -----------------------------------------------------------------

const you = defineHuman({
	name: 'you',
	identity: 'The human sponsor of the initiative. Address them plainly.',
});

const lead = defineAgent({
	name: 'lead',
	identity: 'Tech lead. Manages the engineering team; owns feasibility, estimates, and sequencing.',
	instructions: `
		Speak to what engineering can build, in what order, and at what risk —
		two or three sentences, no preamble. Use team_status before making
		capacity or staffing claims; never guess at it. Give estimates as
		ranges and name the assumption they rest on. When an estimate, a
		technical decision, or a delivery date lands, call the planner in with
		a directed say stating exactly what changed, so the plan stays current.
	`,
	model: MODEL,
	tools: [teamStatus],
});

const designer = defineAgent({
	name: 'designer',
	identity: 'Product designer. Guards the user experience.',
	instructions: `
		Speak only when the user experience is at stake: a flow being cut, a
		decision that trades usability for speed, a scope change that needs
		design work nobody has counted. Name the implication concretely and
		what design needs to deliver, with a rough effort. Otherwise end your
		turn without saying anything — most turns are not design turns.
	`,
	model: MODEL,
});

const product = defineAgent({
	name: 'product',
	identity: 'Product manager. Owns scope, priority, and the why.',
	instructions: `
		Own what ships and why, in that order of importance. Keep scope
		honest: when something is added, say what moves out. Pull the right
		colleague in with a directed say — lead for feasibility, designer for
		experience, exec for resources or dates — rather than asking the room.
		When scope or priority changes, call the planner in with a directed
		say stating the change, so the plan stays current.
	`,
	model: MODEL,
});

const exec = defineAgent({
	name: 'exec',
	identity: 'Executive sponsor. Decides on resources and time to market.',
	instructions: `
		You engage on exactly two things: resource allocation (headcount,
		budget, borrowing people from other teams) and time to market (dates,
		what to cut to hit them, whether a date is worth hitting). On those,
		decide in two sentences — a decision, not a discussion. On everything
		else, end your turn without saying anything. After you decide, call
		the planner in with a directed say stating the decision.
	`,
	model: MODEL,
});

const planner = defineAgent({
	name: 'planner',
	identity:
		'Project manager. Keeps the project plan and progress summary — ' +
		'call them in to record a decision or ask where things stand.',
	instructions: `
		You own the plan of record. When called in, restate it whole and
		current: milestones with owners and dates, decisions made, open risks,
		and a one-line progress summary — folding in whatever changed since
		you last spoke, from the record. Mark what changed. If asked where
		things stand, lead with the progress summary. Say plainly when the
		record holds no plan yet, and propose the skeleton of one.
	`,
	model: MODEL,
});

// -- the room -----------------------------------------------------------------

const session = startSession({
	name: 'initiative',
	goal: `
		Advance the initiative the sponsor brings: decide scope, sequence the
		work, and keep the plan of record current.
	`,
	agents: [lead, designer, product, exec, passive(planner)],
});

/** The room runs whether or not anybody watches; this is somebody watching. */
let visit: Visit | undefined;

const colors: Record<string, string> = {
	lead: '\x1b[36m', // cyan
	designer: '\x1b[33m', // yellow
	product: '\x1b[32m', // green
	exec: '\x1b[34m', // blue
	planner: '\x1b[35m', // magenta
};
const dim = '\x1b[2m';
const red = '\x1b[31m';
const reset = '\x1b[0m';
const paint = (name: string, text: string) => `${colors[name] ?? ''}${text}${reset}`;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const say = (line: string) => {
	// keep the prompt line clean while events stream in
	readline.cursorTo(process.stdout, 0);
	readline.clearLine(process.stdout, 0);
	console.log(line);
	rl.prompt(true);
};

const errored = new Set<string>();
session.subscribe((event: SessionEvent) => {
	switch (event.type) {
		case 'agent_start':
			say(`${dim}· ${event.agent} is reading…${reset}`);
			break;
		case 'say': {
			const arrow = event.message.to ? ` → ${event.message.to}` : '';
			say(`${paint(event.agent, `${event.agent}${arrow}:`)} ${event.message.text}`);
			break;
		}
		case 'tool_execution_start':
			say(`${dim}· ${event.agent} uses ${event.toolName}…${reset}`);
			break;
		case 'agent_end':
			if (!event.spoke && !errored.delete(event.agent))
				say(`${dim}· ${event.agent} stayed quiet${reset}`);
			break;
		case 'say_conflict':
			say(
				`${dim}· ${event.agent} spoke over the room (${event.missed.length} missed) — retrying${reset}`,
			);
			break;
		case 'error':
			errored.add(event.agent);
			say(`${red}! ${event.agent}: ${event.error.message}${reset}`);
			break;
		case 'settled':
			say(`${dim}— room is quiet —${reset}`);
			break;
		case 'delivery':
			if (!isSpoken(event.message))
				say(`${dim}· ${event.message.from} ${event.message.kind}${reset}`);
			break;
		default:
			break;
	}
});

const byName = { lead, designer, product, exec, planner, you } as const;

function help(): void {
	console.log(
		[
			'',
			'  <text>            broadcast: lead, designer, product and exec look; planner does not',
			'  @<name> <text>    directed: wakes exactly that agent — @planner reaches the passive seat',
			'  /seats            the roster with live statuses',
			'  /record           the session record',
			'  /missed           what landed since you last stopped reading',
			'  /abort            cancel every active turn',
			'  /quit             leave the room',
			'',
			'  Try: kick off an initiative ("we are shipping payments v2 this quarter — thoughts?"),',
			'  watch decisions get routed to the planner, ask for headcount (exec wakes up),',
			'  then "@planner where are we?" for the plan of record.',
			'',
		].join('\n'),
	);
}

function showSeats(): void {
	for (const seat of session.seats()) {
		const state = seat.kind === 'agent' ? seat.status : seat.presence;
		console.log(`  ${seat.name} (${seat.kind}, ${state}): ${seat.identity}`);
	}
}

async function showRecord(): Promise<void> {
	for (const m of await session.messages()) {
		if (isSpoken(m)) console.log(`  [${m.from}${m.to ? ` → ${m.to}` : ''}] ${m.text}`);
		else console.log(`  · ${m.from} ${m.kind}`);
	}
}

/** What landed since this visitor last stopped reading. */
async function showMissed(): Promise<void> {
	const since = visit?.since;
	if (since === undefined) {
		console.log('  (you have not been here before — the whole record is new)');
		return;
	}
	for (const m of await session.messages({ since })) {
		console.log(isSpoken(m) ? `  [${m.from}] ${m.text}` : `  · ${m.from} ${m.kind}`);
	}
}

/** Everything that is not a message. One entry per line of `help()`. */
const commands = new Map<string, () => void | Promise<void>>(
	// A Map, not an object: the key is whatever the user typed, and a plain
	// object would answer `toString` with something from Object.prototype.
	Object.entries({
		'/help': help,
		'/seats': showSeats,
		'/record': showRecord,
		'/missed': showMissed,
		'/abort': () => session.abort(),
		'/quit': async () => {
			await visit?.leave();
			await stopSession(session);
			rl.close();
			process.exit(0);
		},
	}),
);

/** `@name text` reaches one seat; anything else reaches the room. */
async function deliver(input: string): Promise<void> {
	const here = visit;
	if (!here) return;
	const directed = /^@([a-z-]+)\s+(.+)$/.exec(input);
	if (!directed) return here.deliver({ text: input });
	const target = byName[directed[1] as keyof typeof byName];
	if (!target || target === you) {
		console.log(`${red}no such agent: ${directed[1]}${reset}`);
		return;
	}
	await here.deliver({ to: target, text: directed[2] as string });
}

async function handle(line: string): Promise<void> {
	const input = line.trim();
	if (input === '') return;
	const command = commands.get(input);
	if (command) return command();
	try {
		await deliver(input);
	} catch (error) {
		console.log(`${red}${error instanceof Error ? error.message : String(error)}${reset}`);
	}
}

console.log(`\nThe room is open. Model: ${MODEL} (set AMBION_MODEL to change).`);
if (!process.env.ANTHROPIC_API_KEY) {
	console.log(`${red}ANTHROPIC_API_KEY is not set — agents will fail to answer.${reset}`);
}
help();
visit = await visitSession(session, you);
rl.setPrompt('you › ');
rl.prompt();
rl.on('line', (line) => {
	void handle(line).then(() => rl.prompt(true));
});
rl.on('close', () => process.exit(0));
