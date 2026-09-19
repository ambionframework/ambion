/** A slash command the composer understands. */
export interface Command {
	name: string;
	summary: string;
	/** The kind of argument the command takes. A command with none runs at once. */
	argument?: 'room';
}

export const COMMANDS: readonly Command[] = [
	{ name: 'room', summary: 'Switch to another room', argument: 'room' },
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

/** One row of the palette above the composer. */
export interface Suggestion {
	label: string;
	detail: string;
	/** The text the composer holds after the person accepts this row. */
	insert: string;
	/** True when accepting the row runs the command, not only completes it. */
	run: boolean;
}

function roomSuggestions(prefix: string, rooms: readonly RoomChoice[]): Suggestion[] {
	const wanted = prefix.trim().toLowerCase();
	return rooms
		.filter((room) => room.name.toLowerCase().startsWith(wanted))
		.map((room) => ({
			label: room.name,
			detail: room.working ? 'working' : room.status,
			insert: `/room ${room.name}`,
			run: true,
		}));
}

function commandSuggestions(prefix: string): Suggestion[] {
	return COMMANDS.filter((command) => command.name.startsWith(prefix.toLowerCase())).map(
		(command) => ({
			label: `/${command.name}`,
			detail: command.summary,
			insert: command.argument ? `/${command.name} ` : `/${command.name}`,
			run: command.argument === undefined,
		}),
	);
}

/**
 * The rows the palette shows for what the person has typed so far. Only a single
 * line that starts with a slash opens the palette. `/room ` lists the rooms.
 */
export function suggest(input: string, rooms: readonly RoomChoice[]): Suggestion[] {
	if (!input.startsWith('/') || input.startsWith('//') || input.includes('\n')) return [];
	const space = input.indexOf(' ');
	if (space === -1) return commandSuggestions(input.slice(1));
	const name = input.slice(1, space).toLowerCase();
	return name === 'room' ? roomSuggestions(input.slice(space + 1), rooms) : [];
}
