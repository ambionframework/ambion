import { describe, expect, it } from 'vitest';
import { type Choices, parse, type RoomChoice, suggest } from '../src/commands.ts';

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
};

describe('parse', () => {
	it('reads plain text as a message', () => {
		expect(parse('  Which resistor?  ')).toEqual({ kind: 'message', text: 'Which resistor?' });
	});

	it('reads a command and its argument', () => {
		expect(parse('/room bringup')).toEqual({ kind: 'command', name: 'room', argument: 'bringup' });
		expect(parse('/ABORT')).toEqual({ kind: 'command', name: 'abort', argument: '' });
	});

	it('reports an unknown command by name', () => {
		expect(parse('/library/led-5mm.md')).toEqual({ kind: 'unknown', name: 'library/led-5mm.md' });
	});

	it('lets a double slash send a message that starts with one slash', () => {
		expect(parse('//library/led-5mm.md is the datasheet')).toEqual({
			kind: 'message',
			text: '/library/led-5mm.md is the datasheet',
		});
	});

	it('sends a multi-line text as a message, even after a slash', () => {
		expect(parse('/abort\nand then explain')).toMatchObject({ kind: 'message' });
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
				'/stop',
				'/resume',
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

	it('lists the rooms after /room, with their state', () => {
		const rows = suggest('/room ', choices);
		expect(rows.map((row) => [row.label, row.detail])).toEqual([
			['bringup', 'running'],
			['sensing', 'working'],
			['power', 'stopped'],
		]);
		expect(rows[0]).toMatchObject({ insert: '/room bringup', run: true });
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

	it('only completes /new, which takes free text', () => {
		expect(suggest('/n', choices)[0]).toMatchObject({ insert: '/new ', run: false });
		expect(suggest('/new bringup2', choices)).toEqual([]);
	});

	it('filters the rooms by what follows /room', () => {
		expect(suggest('/room PO', choices).map((row) => row.label)).toEqual(['power']);
	});

	it('opens no palette for text, for a double slash, or for an argument of another command', () => {
		expect(suggest('hello', choices)).toEqual([]);
		expect(suggest('//path', choices)).toEqual([]);
		expect(suggest('/abort now', choices)).toEqual([]);
		expect(suggest('/room a\nb', choices)).toEqual([]);
	});
});

describe('the steps command', () => {
	it('parses with its argument and appears in the palette', () => {
		expect(parse('/steps 2')).toEqual({ kind: 'command', name: 'steps', argument: '2' });
		expect(suggest('/st', choices).map((row) => row.label)).toContain('/steps');
	});
});
