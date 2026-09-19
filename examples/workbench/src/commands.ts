/** A slash command the composer understands. */
interface Command {
	name: string;
	summary: string;
	/** What the command takes after its name. A command with nothing runs at once. */
	argument?: 'room' | 'person' | 'file' | 'text';
}

const COMMANDS: readonly Command[] = [
	{ name: 'room', summary: 'Switch to another room', argument: 'room' },
	{ name: 'new', summary: 'Create a room: /new <name> [goal]', argument: 'text' },
	{ name: 'user', summary: 'Switch to another person', argument: 'person' },
	{ name: 'files', summary: 'Search the workspace files' },
	{ name: 'open', summary: 'Open a workspace file in the side panel', argument: 'file' },
	{ name: 'try', summary: 'Fill the composer with the room’s suggested question' },
	{ name: 'abort', summary: 'Cancel the open exchange' },
	{ name: 'stop', summary: 'Stop the room' },
	{ name: 'resume', summary: 'Resume the room' },
	{ name: 'expand', summary: 'Open every discussion' },
	{ name: 'collapse', summary: 'Close every discussion' },
	{ name: 'help', summary: 'Show the commands and keys' },
	{ name: 'quit', summary: 'Leave the terminal' },
];

/** What the person typed, once read. */
export type Parsed =
	| { kind: 'message'; text: string }
	| { kind: 'command'; name: string; argument: string }
	| { kind: 'unknown'; name: string };

/**
 * Read one composer submission. A leading `//` sends a message that starts with
 * one slash, so a person can still write a path such as `/library/led-5mm.md`.
 */
export function parse(input: string): Parsed {
	const text = input.trim();
	if (text.startsWith('//')) return { kind: 'message', text: text.slice(1) };
	if (!text.startsWith('/') || text.includes('\n')) return { kind: 'message', text };
	const [head = '', ...rest] = text.slice(1).split(/\s+/);
	const name = head.toLowerCase();
	if (!COMMANDS.some((command) => command.name === name)) return { kind: 'unknown', name };
	return { kind: 'command', name, argument: rest.join(' ').trim() };
}

/** A room the person can switch to. */
export interface RoomChoice {
	name: string;
	status: string;
	working: boolean;
}

/** A person the terminal can act as. */
interface PersonChoice {
	name: string;
	role: string;
}

/** A workspace file the person can open. */
interface FileChoice {
	path: string;
	size: number;
}

/** Everything a command argument can complete to. */
export interface Choices {
	rooms: readonly RoomChoice[];
	people: readonly PersonChoice[];
	files: readonly FileChoice[];
}

/** What a palette row completes to. It names the palette. */
type Kind = 'command' | 'room' | 'person' | 'file';

/** One row of the palette above the composer. */
export interface Suggestion {
	kind: Kind;
	label: string;
	detail: string;
	/** The text the composer holds after the person accepts this row. */
	insert: string;
	/** True when accepting the row runs the command, not only completes it. */
	run: boolean;
}

const bytes = (size: number): string =>
	size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`;

function commandSuggestions(prefix: string): Suggestion[] {
	return COMMANDS.filter((command) => command.name.startsWith(prefix.toLowerCase())).map(
		(command) => ({
			kind: 'command' as const,
			label: `/${command.name}`,
			detail: command.summary,
			insert: command.argument ? `/${command.name} ` : `/${command.name}`,
			run: command.argument === undefined,
		}),
	);
}

function argumentSuggestions(name: string, wanted: string, choices: Choices): Suggestion[] {
	const text = wanted.trim().toLowerCase();
	const kind: Kind = name === 'user' ? 'person' : name === 'open' ? 'file' : 'room';
	const row = (label: string, detail: string): Suggestion => ({
		kind,
		label,
		detail,
		insert: `/${name} ${label}`,
		run: true,
	});
	if (name === 'room')
		return choices.rooms
			.filter((room) => room.name.toLowerCase().startsWith(text))
			.map((room) => row(room.name, room.working ? 'working' : room.status));
	if (name === 'user')
		return choices.people
			.filter((person) => person.name.toLowerCase().startsWith(text))
			.map((person) => row(person.name, person.role));
	if (name === 'open')
		return choices.files
			.filter((file) => file.path.toLowerCase().includes(text))
			.map((file) => row(file.path, bytes(file.size)));
	return [];
}

/**
 * The rows the palette shows for what the person has typed so far. Only a single
 * line that starts with a slash opens the palette. `/room `, `/user `, and `/open `
 * list what they can take.
 */
export function suggest(input: string, choices: Choices): Suggestion[] {
	if (!input.startsWith('/') || input.startsWith('//') || input.includes('\n')) return [];
	const space = input.indexOf(' ');
	if (space === -1) return commandSuggestions(input.slice(1));
	return argumentSuggestions(input.slice(1, space).toLowerCase(), input.slice(space + 1), choices);
}
