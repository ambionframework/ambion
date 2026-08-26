/**
 * An interactive multi-agent session in your terminal.
 *
 * Three agents share the room with you, and each mechanic of the session is
 * observable by hand:
 *
 * - `pragma` (idle) answers; when a question needs the room's memory, it
 *   calls the archivist in with a directed say.
 * - `contrarian` (idle) speaks only to disagree — most messages end with
 *   "· contrarian stayed quiet", which is silence working.
 * - `archivist` (passive) hears nothing until named: `@archivist …`, or a
 *   colleague's directed say.
 *
 * Run it:  ANTHROPIC_API_KEY=… pnpm start   (from examples/room)
 */

import * as readline from 'node:readline';
import {
	defineAgent,
	defineHuman,
	defineTool,
	openSession,
	passive,
	type SessionEvent,
} from '@ambionframework/ambion';
import { Type } from 'typebox';

const MODEL = process.env['AMBION_MODEL'] ?? 'anthropic/claude-sonnet-4-5';

// -- one tool, so tool_execution events are visible ---------------------------

const ciStatus = defineTool({
	name: 'ci_status',
	description: 'Check the current CI status of the main branch.',
	parameters: Type.Object({}),
	execute: () =>
		'main is green; integration suite last flaked 3 days ago (job #4182, timeout in setup).',
});

// -- the cast -----------------------------------------------------------------

const you = defineHuman({
	name: 'you',
	identity: 'The human in the room. Address them plainly.',
});

const pragma = defineAgent({
	name: 'pragma',
	identity: 'Pragmatic tech lead. Answers crisply, decides quickly.',
	instructions: `
		Answer the human's questions concisely — two or three sentences, no
		preamble. Use ci_status when asked about the build. When a question
		needs the room's history or past decisions, do not guess: call the
		archivist in with a directed say and tell the human you have done so.
	`,
	model: MODEL,
	tools: [ciStatus],
});

const contrarian = defineAgent({
	name: 'contrarian',
	identity: 'Challenges plans. Silent unless it disagrees.',
	instructions: `
		Speak only when a stated plan or claim in the room has a concrete
		flaw worth naming — then name it in one or two pointed sentences,
		and propose the smaller alternative. If you have no real objection,
		end your turn without saying anything. Most turns, you say nothing.
	`,
	model: MODEL,
});

const archivist = defineAgent({
	name: 'archivist',
	identity: 'The room’s memory. Knows what was decided and when.',
	instructions: `
		You keep the room's history. When called in, answer from the record
		of this session — what was said, decided, or asked earlier — and
		say plainly when the record holds no answer. Keep to the question;
		return the room to whoever asked.
	`,
	model: MODEL,
});

// -- the room -----------------------------------------------------------------

const session = openSession({
	name: 'room',
	participants: [you, pragma, contrarian, passive(archivist)],
});

const colors: Record<string, string> = {
	pragma: '\x1b[36m', // cyan
	contrarian: '\x1b[33m', // yellow
	archivist: '\x1b[35m', // magenta
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
		default:
			break;
	}
});

const byName = { pragma, contrarian, archivist, you } as const;

function help(): void {
	console.log(
		[
			'',
			'  <text>            broadcast: pragma and contrarian look; archivist does not',
			'  @<name> <text>    directed: wakes exactly that agent — @archivist reaches the passive seat',
			'  /seats            the roster with live statuses',
			'  /record           the session record',
			'  /abort            cancel every active turn',
			'  /quit             leave the room',
			'',
			'  Try: a question (watch contrarian stay quiet), a bad plan (watch it wake up),',
			'  "@archivist what did we decide?", and typing again while agents are mid-turn.',
			'',
		].join('\n'),
	);
}

async function handle(line: string): Promise<void> {
	const input = line.trim();
	if (input === '') return;
	if (input === '/quit') {
		rl.close();
		process.exit(0);
	}
	if (input === '/help') return help();
	if (input === '/abort') return session.abort();
	if (input === '/seats') {
		for (const seat of session.seats()) {
			const status = seat.status ? `, ${seat.status}` : '';
			console.log(`  ${seat.name} (${seat.kind}${status}): ${seat.identity}`);
		}
		return;
	}
	if (input === '/record') {
		for (const m of await session.messages()) {
			console.log(`  [${m.from}${m.to ? ` → ${m.to}` : ''}] ${m.text}`);
		}
		return;
	}
	const directed = /^@([a-z-]+)\s+(.+)$/.exec(input);
	try {
		if (directed) {
			const target = byName[directed[1] as keyof typeof byName];
			if (!target || target === you) {
				console.log(`${red}no such agent: ${directed[1]}${reset}`);
				return;
			}
			await session.deliver({ from: you, to: target, text: directed[2] as string });
		} else {
			await session.deliver({ from: you, text: input });
		}
	} catch (error) {
		console.log(`${red}${error instanceof Error ? error.message : String(error)}${reset}`);
	}
}

console.log(`\nThe room is open. Model: ${MODEL} (set AMBION_MODEL to change).`);
if (!process.env['ANTHROPIC_API_KEY']) {
	console.log(`${red}ANTHROPIC_API_KEY is not set — agents will fail to answer.${reset}`);
}
help();
rl.setPrompt('you › ');
rl.prompt();
rl.on('line', (line) => {
	void handle(line).then(() => rl.prompt(true));
});
rl.on('close', () => process.exit(0));
