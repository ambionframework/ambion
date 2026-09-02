/**
 * The room, open in your terminal.
 *
 * Three products wait in it. You visit as one of three people, and can open a
 * second and third visit to watch presence work with more than one of you in
 * the room at once. Each person brings an assistant: ask a question, let the room
 * work it out, and read the one message your assistant writes when it goes quiet.
 *
 * Run it:  ANTHROPIC_API_KEY=… pnpm start   (from examples/site)
 */
import * as readline from 'node:readline';
import {
	type Attention,
	isReminder,
	isSpoken,
	isSummary,
	type Message,
	readSession,
	type SessionEvent,
	type SummaryMessage,
	startSession,
	stopSession,
	type Visit,
	visitSession,
} from '@ambionframework/ambion';
import { AGENTS, apiLog, DRIVE_ROOT, driveFiles, GOAL, MODEL, PEOPLE, ROOM_NAME } from './room.ts';

const session = startSession({ name: ROOM_NAME, goal: GOAL, agents: AGENTS });

/** Who is in the room, by name. A person may be here more than once. */
const visits = new Map<string, Visit>();
let speaking = 'priya';

const colours: Record<string, string> = {
	'time-tracker': '\x1b[34m',
	'task-management': '\x1b[32m',
	'materials-tracker': '\x1b[33m',
	priya: '\x1b[36m',
	sam: '\x1b[35m',
	dan: '\x1b[31m',
	'priya-assistant': '\x1b[96m',
	'sam-assistant': '\x1b[95m',
	'dan-assistant': '\x1b[91m',
};
const dim = '\x1b[2m';
const red = '\x1b[31m';
const reset = '\x1b[0m';
const paint = (name: string, text: string) => `${colours[name] ?? ''}${text}${reset}`;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const show = (line: string) => {
	readline.cursorTo(process.stdout, 0);
	readline.clearLine(process.stdout, 0);
	console.log(line);
	rl.prompt(true);
};

/** One line per message, whoever wrote it: four kinds, one record. */
function showMessage(m: Message): void {
	if (isSummary(m)) {
		// The one message its person reads instead of the working. The
		// range it stands for is above it, and it wakes nobody.
		show(`${paint(m.from, `∎ ${m.from} → ${m.to}`)} (${span(m)}): ${m.text}`);
		return;
	}
	if (isReminder(m)) {
		// A reminder the agent set for itself, come due: it wakes that agent alone.
		show(`${dim}· reminder for ${paint(m.from, m.from)}${dim}: ${m.text}${reset}`);
		return;
	}
	if (!isSpoken(m)) {
		show(`${dim}· ${m.from} ${m.kind}${reset}`);
		return;
	}
	const arrow = m.to ? ` → ${m.to}` : '';
	show(`${paint(m.from, `${m.from}${arrow}:`)} ${m.text}`);
}

const errored = new Set<string>();
session.subscribe((event: SessionEvent) => {
	switch (event.type) {
		case 'activation_start':
			show(`${dim}· ${event.agent} is reading…${reset}`);
			break;
		case 'message':
			showMessage(event.message);
			break;
		case 'tool_execution_start':
			show(`${dim}· ${event.agent} calls ${event.toolName}…${reset}`);
			break;
		case 'activation_end':
			if (!event.spoke && !errored.delete(event.agent)) {
				show(`${dim}· ${event.agent} read it and stayed idle${reset}`);
			}
			break;
		case 'conflict':
			show(
				`${dim}· ${event.author} was refused — the record moved (${event.missed.length} missed)${reset}`,
			);
			break;
		case 'error':
			errored.add(event.agent);
			show(`${red}! ${event.agent}: ${event.error.message}${reset}`);
			break;
		// The exchange somebody asked for. A client that could re-render would fold
		// the working between these two into a thinking state; a terminal cannot,
		// so it draws the boundary instead.
		case 'exchange_opened':
			show(`${dim}— ${event.exchange.owner} asked; the room is working —${reset}`);
			break;
		case 'exchange_closed':
			show(
				`${dim}— the exchange is over (${event.exchange.from}–${event.exchange.through}) —${reset}`,
			);
			break;
		// Quiet, not settled: settled is the seats alone, and an assistant writes after it.
		case 'quiet':
			show(`${dim}— the room is quiet —${reset}`);
			break;
		default:
			break;
	}
});

function help(): void {
	console.log(
		[
			'',
			'  <text>            say it to the room, as whoever you are speaking as',
			'  @<name> <text>    say it to one product or one person',
			'  /join <name>      open a visit for priya, sam or dan',
			'  /as <name>        speak as somebody already in the room',
			'  /leave <name>     end that person’s visit',
			'  /who              the seats, their attention, and who is reading',
			'  /record           everything on the record',
			'  /missed           what landed since you last stopped reading',
			'  /api              every call the products made into their own data',
			'  /diary            the site diary, as the products have left it',
			'  /summaries        what each assistant wrote, and the range it stands for',
			'  /abort            cancel every activation in flight',
			'  /quit             leave, stop the room, and exit',
			'',
			'  The task list watches the door. Try /join dan and see whether it has',
			'  anything of his; then ask "can I promise Thursday for the pour?"',
			'  When the room goes quiet, your assistant writes the one message you read.',
			'',
		].join('\n'),
	);
}

/** What wakes a seat, in the words the roster uses rather than the enum. */
const WAKES: Record<Attention, string> = {
	none: 'for nothing said',
	named: 'only when named',
	broadcast: 'on anything said',
	presence: 'on anything said, and on arrivals',
};

function who(): void {
	for (const seat of session.seats()) {
		if (seat.kind === 'agent') {
			const owner = seat.owner ? `, writes for ${seat.owner}` : '';
			console.log(
				`  ${paint(seat.name, seat.name)} (${seat.status}, wakes ${WAKES[seat.attention]}${owner}): ${seat.identity}`,
			);
		} else {
			const assistant = seat.assistant ? `, brings ${seat.assistant}` : '';
			console.log(
				`  ${paint(seat.name, seat.name)} (${seat.presence}${assistant}): ${seat.identity}`,
			);
		}
	}
}

const span = (m: SummaryMessage) => `${m.covers.from}–${m.covers.through}`;

/** One line per entry, whoever wrote it: four kinds, one record. */
function line(m: Message): string {
	if (isSummary(m)) return `[${m.seq}] ∎ ${m.from} → ${m.to} (${span(m)}): ${m.text}`;
	if (isReminder(m)) return `[${m.seq}] · reminder for ${m.from}: ${m.text}`;
	if (isSpoken(m)) return `[${m.seq}] ${m.from}${m.to ? ` → ${m.to}` : ''}: ${m.text}`;
	return `[${m.seq}] · ${m.from} ${m.kind}`;
}

async function record(): Promise<void> {
	for (const m of await session.messages()) console.log(`  ${line(m)}`);
}

/** One exchange, one message: what each assistant wrote, and what it stands for. */
async function summaries(): Promise<void> {
	const written = (await session.messages()).filter(isSummary);
	if (written.length === 0) return console.log('  (no assistant has written yet)');
	for (const m of written) {
		console.log(`  [${m.seq}] ${paint(m.from, m.from)} → ${m.to}, for ${span(m)}:`);
		console.log(`      ${m.text.replace(/\n/g, '\n      ')}`);
	}
}

async function missed(): Promise<void> {
	const since = visits.get(speaking)?.since;
	if (since === undefined) {
		console.log('  (you have not stopped reading yet — nothing to catch up on)');
		return;
	}
	for (const m of await session.messages({ since })) console.log(`  ${line(m)}`);
}

/** The diary is the one document every product writes to; the host reads it off the disk. */
function diary(): void {
	console.log(`  ${dim}the drive is at ${DRIVE_ROOT}${reset}`);
	for (const file of driveFiles()) {
		if (!file.path.startsWith('site/diary/')) continue;
		console.log(`  ${file.path}`);
		console.log(`    ${file.text.trim().replace(/\n/g, '\n    ')}`);
	}
}

function api(): void {
	for (const call of apiLog)
		console.log(`  ${call.app}.${call.tool}(${JSON.stringify(call.params)})`);
	if (apiLog.length === 0) console.log('  (no product API calls yet)');
}

async function join(name: string): Promise<void> {
	const person = PEOPLE[name];
	if (!person) return console.log(`${red}no such person: ${name}${reset}`);
	if (visits.has(name)) return console.log(`${red}${name} is already here${reset}`);
	visits.set(name, await visitSession(session, person));
	speaking = name;
	rl.setPrompt(`${speaking} › `);
}

async function leave(name: string): Promise<void> {
	const visit = visits.get(name);
	if (!visit) return console.log(`${red}${name} is not here${reset}`);
	await visit.leave();
	visits.delete(name);
	if (speaking === name) speaking = [...visits.keys()][0] ?? 'priya';
	rl.setPrompt(`${speaking} › `);
}

async function quit(): Promise<void> {
	for (const name of [...visits.keys()]) await leave(name);
	await stopSession(session);
	rl.close();
	process.exit(0);
}

const commands = new Map<string, (arg: string) => void | Promise<void>>(
	Object.entries({
		'/help': help,
		'/who': who,
		'/record': record,
		'/missed': missed,
		'/api': api,
		'/diary': diary,
		'/summaries': summaries,
		'/join': join,
		'/leave': leave,
		'/as': (name: string) => {
			if (!visits.has(name))
				return console.log(`${red}${name} is not here — /join ${name} first${reset}`);
			speaking = name;
			rl.setPrompt(`${speaking} › `);
		},
		'/abort': () => session.abort(),
		'/quit': quit,
	}),
);

async function say(input: string): Promise<void> {
	const visit = visits.get(speaking);
	if (!visit)
		return console.log(`${red}${speaking} is not in the room — /join ${speaking}${reset}`);
	const directed = /^@([a-z-]+)\s+(.+)$/.exec(input);
	if (!directed) return visit.deliver({ text: input });
	const [, name, text] = directed;
	const target = session.seats().find((s) => s.name === name);
	if (!target || !text) return console.log(`${red}no such participant: ${name}${reset}`);
	await visit.deliver({ to: { name } as never, text });
}

async function handle(line: string): Promise<void> {
	const input = line.trim();
	if (input === '') return;
	const [word = '', ...rest] = input.split(' ');
	const command = commands.get(word);
	if (command) return command(rest.join(' '));
	try {
		await say(input);
	} catch (error) {
		console.log(`${red}${error instanceof Error ? error.message : String(error)}${reset}`);
	}
}

console.log(`\n${ROOM_NAME} is running. Model: ${MODEL} (set AMBION_MODEL to change).`);
if (!process.env.ANTHROPIC_API_KEY) {
	console.log(`${red}ANTHROPIC_API_KEY is not set — the products will fail to answer.${reset}`);
}
console.log(
	`${dim}Reading it takes no run: readSession('${ROOM_NAME}') works from anywhere.${reset}`,
);
void readSession(ROOM_NAME);
help();
await join('priya');
rl.setPrompt(`${speaking} › `);
rl.prompt();
rl.on('line', (line) => {
	void handle(line).then(() => rl.prompt(true));
});
rl.on('close', () => process.exit(0));
