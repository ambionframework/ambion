import { describe, expect, it } from 'vitest';
import { type Choices, type Parsed, parse, type RoomChoice, suggest } from '../src/commands.ts';

const rooms: RoomChoice[] = [
	{ name: 'bringup', status: 'running', working: false },
	{ name: 'sensing', status: 'running', working: true },
	{ name: 'power', status: 'stopped', working: false },
];

const choices: Choices = {
	rooms,
	people: [
		{ name: 'mira', role: 'Hardware lead' },
		{ name: 'theo', role: 'Firmware engineer' },
	],
	files: [
		{ path: '/library/led-5mm.md', size: 797 },
		{ path: '/shared/notes.md', size: 2048 },
	],
	says: [
		{
			seq: 41,
			seat: 'bench',
			owner: 'mira',
			due: '2026-09-25T10:00:00.000Z',
			text: 'Check the sweep.',
		},
		{
			seq: 57,
			seat: 'bench',
			owner: 'mira',
			due: '2026-09-25T11:00:00.000Z',
			text: 'Read the log.',
		},
	],
};

describe('parse', () => {
	it('reads a message, a command with its argument, an unknown command, and a slash in a message', () => {
		const cases: [string, Parsed][] = [
			['  Which resistor?  ', { kind: 'message', text: 'Which resistor?' }],
			['/room bringup', { kind: 'command', name: 'room', argument: 'bringup' }],
			['/ABORT', { kind: 'command', name: 'abort', argument: '' }],
			['/steps 2', { kind: 'command', name: 'steps', argument: '2' }],
			['/library/led-5mm.md', { kind: 'unknown', name: 'library/led-5mm.md' }],
			// A double slash sends a message that starts with one slash.
			['//library/x.md is it', { kind: 'message', text: '/library/x.md is it' }],
			// A multi-line text is a message, even after a slash.
			['/abort\nand then explain', { kind: 'message', text: '/abort\nand then explain' }],
		];
		for (const [text, parsed] of cases) expect(parse(text), text).toEqual(parsed);
	});
});

describe('suggest', () => {
	it('lists every command for a lone slash', () => {
		const labels = suggest('/', choices).map((row) => row.label);
		expect(labels).toEqual(
			expect.arrayContaining([
				'/room',
				'/new',
				'/user',
				'/files',
				'/open',
				'/attach',
				'/try',
				'/abort',
				'/dismiss',
				'/stop',
				'/resume',
				'/steps',
				'/expand',
				'/collapse',
			]),
		);
	});

	it('filters commands by prefix', () => {
		expect(suggest('/a', choices).map((row) => row.label)).toEqual(['/attach', '/abort']);
	});

	it('runs a command that takes no argument, and only completes one that does', () => {
		expect(suggest('/abo', choices)[0]).toMatchObject({ insert: '/abort', run: true });
		expect(suggest('/ro', choices)[0]).toMatchObject({ insert: '/room ', run: false });
	});

	it('lists the rooms after /room, with their state, and filters them by what follows', () => {
		const rows = suggest('/room ', choices);
		expect(rows.map((row) => [row.label, row.detail])).toEqual([
			['bringup', 'running'],
			['sensing', 'working'],
			['power', 'stopped'],
		]);
		expect(rows[0]).toMatchObject({ insert: '/room bringup', run: true });
		expect(suggest('/room PO', choices).map((row) => row.label)).toEqual(['power']);
	});

	it('lists the people after /user, with their role', () => {
		expect(suggest('/user ', choices).map((row) => [row.label, row.detail, row.insert])).toEqual([
			['mira', 'Hardware lead', '/user mira'],
			['theo', 'Firmware engineer', '/user theo'],
		]);
		expect(suggest('/user t', choices).map((row) => row.label)).toEqual(['theo']);
	});

	it('lists the files after /open, matching anywhere in the path', () => {
		expect(suggest('/open ', choices).map((row) => [row.label, row.detail])).toEqual([
			['/library/led-5mm.md', '797 B'],
			['/shared/notes.md', '2.0 KB'],
		]);
		expect(suggest('/open NOTES', choices).map((row) => row.insert)).toEqual([
			'/open /shared/notes.md',
		]);
	});

	it('lists the says that wait after /dismiss, with their seat and text, in their own palette', () => {
		const rows = suggest('/dismiss ', choices);
		expect(rows.map((row) => [row.label, row.detail, row.insert, row.kind])).toEqual([
			['41', 'bench: Check the sweep.', '/dismiss 41', 'say'],
			['57', 'bench: Read the log.', '/dismiss 57', 'say'],
		]);
		expect(suggest('/dismiss 5', choices).map((row) => row.label)).toEqual(['57']);
	});

	it('only completes /new, which takes free text', () => {
		expect(suggest('/n', choices)[0]).toMatchObject({ insert: '/new ', run: false });
		expect(suggest('/new bringup2', choices)).toEqual([]);
	});

	it('opens no palette for text, for a double slash, or for an argument of another command', () => {
		expect(suggest('hello', choices)).toEqual([]);
		expect(suggest('//path', choices)).toEqual([]);
		expect(suggest('/abort now', choices)).toEqual([]);
		expect(suggest('/room a\nb', choices)).toEqual([]);
	});
});
