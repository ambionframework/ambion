import { describe, expect, it } from 'vitest';
import { parse, type RoomChoice, suggest } from '../src/commands.ts';

const rooms: RoomChoice[] = [
	{ name: 'bringup', status: 'running', working: false },
	{ name: 'sensing', status: 'running', working: true },
	{ name: 'power', status: 'stopped', working: false },
];

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
		const labels = suggest('/', rooms).map((row) => row.label);
		expect(labels).toEqual(
			expect.arrayContaining(['/room', '/abort', '/stop', '/resume', '/expand', '/collapse']),
		);
	});

	it('filters commands by prefix', () => {
		expect(suggest('/a', rooms).map((row) => row.label)).toEqual(['/abort']);
	});

	it('runs a command that takes no argument, and only completes one that does', () => {
		expect(suggest('/abo', rooms)[0]).toMatchObject({ insert: '/abort', run: true });
		expect(suggest('/ro', rooms)[0]).toMatchObject({ insert: '/room ', run: false });
	});

	it('lists the rooms after /room, with their state', () => {
		const rows = suggest('/room ', rooms);
		expect(rows.map((row) => [row.label, row.detail])).toEqual([
			['bringup', 'running'],
			['sensing', 'working'],
			['power', 'stopped'],
		]);
		expect(rows[0]).toMatchObject({ insert: '/room bringup', run: true });
	});

	it('filters the rooms by what follows /room', () => {
		expect(suggest('/room PO', rooms).map((row) => row.label)).toEqual(['power']);
	});

	it('opens no palette for text, for a double slash, or for an argument of another command', () => {
		expect(suggest('hello', rooms)).toEqual([]);
		expect(suggest('//path', rooms)).toEqual([]);
		expect(suggest('/abort now', rooms)).toEqual([]);
		expect(suggest('/room a\nb', rooms)).toEqual([]);
	});
});
