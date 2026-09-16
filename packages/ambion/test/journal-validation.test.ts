import { describe, expect, it } from 'vitest';
import { roomJournal } from '../src/journal/journal.ts';
import { validateRoomBody } from '../src/journal/validate.ts';
import { roomName } from './support/room.ts';
import { memory } from './support/storage.ts';

const seating = { name: 'alpha', identity: 'Researcher', attention: 'broadcast' };
const at = '2026-01-01T00:00:00.000Z';

describe('room journal body validation', () => {
	it('accepts every stored message union member and its optional fields', () => {
		expect(
			validateRoomBody('message', {
				kind: 'said',
				at: '2026-01-01T00:00:00.000Z',
				from: 'alpha',
				to: 'beta',
				text: 'hello',
				activationId: 'message:1:alpha:1',
				wakes: ['beta'],
			}),
		).toBe(true);
		expect(
			validateRoomBody('message', {
				kind: 'summary',
				at: '2026-01-01T00:00:00.000Z',
				from: 'assistant',
				to: 'andrei',
				text: 'Done.',
				covers: { from: 1, through: 4 },
			}),
		).toBe(true);
		for (const kind of ['arrived', 'left', 'seated', 'unseated'])
			expect(
				validateRoomBody('message', {
					kind,
					at: '2026-01-01T00:00:00.000Z',
					subject: 'andrei',
				}),
			).toBe(true);
	});

	it('accepts both lease phases, close wakes, and a complete composition', () => {
		expect(
			validateRoomBody('lease', {
				id: 'message:1:alpha:1',
				phase: 'running',
				expiresAt: 1735689600000,
				at: '2026-01-01T00:00:00.000Z',
				readThrough: 0,
			}),
		).toBe(true);
		expect(
			validateRoomBody('lease', {
				id: 'message:1:alpha:1',
				phase: 'ended',
				reason: 'released',
				at: '2026-01-01T00:00:00.000Z',
				readThrough: 3,
			}),
		).toBe(true);
		expect(
			validateRoomBody('close', {
				owner: 'andrei',
				from: 1,
				through: 5,
				at: '2026-01-01T00:00:00.000Z',
				summary: 'assistant',
			}),
		).toBe(true);
		expect(
			validateRoomBody('composition', {
				version: 2,
				goal: 'Draft the weekly.',
				summary: 'assistant',
				agents: [seating],
				available: [{ name: 'beta', identity: 'Reviewer', attention: 'broadcast' }],
				at: '2026-01-01T00:00:00.000Z',
			}),
		).toBe(true);
		expect(validateRoomBody('run', { at: '2026-01-01T00:00:00.000Z' })).toBe(true);
	});

	it('rejects malformed activation ids after validating the stored body shape', () => {
		expect(() =>
			validateRoomBody('lease', {
				id: 'message:1:alpha:0',
				phase: 'running',
				expiresAt: 1735689600000,
				at: '2026-01-01T00:00:00.000Z',
				readThrough: 0,
			}),
		).toThrow(/kind 'lease'.*body\.id/);
		expect(() =>
			validateRoomBody('message', {
				kind: 'said',
				at: '2026-01-01T00:00:00.000Z',
				from: 'alpha',
				text: 'hello',
				activationId: 'message:1',
			}),
		).toThrow(/kind 'message'.*body\.activationId/);
	});

	it('rejects old or missing composition versions with an explicit migration boundary', () => {
		for (const body of [
			{ agents: [], available: [], at },
			{ version: 1, agents: [], available: [], at },
			{ version: 2, assistant: 'legacy', agents: [], available: [], at },
		]) {
			expect(() => validateRoomBody('composition', body)).toThrow(
				/unsupported room composition version.*version 2.*new journal.*externally/i,
			);
		}
	});

	it('skips an unknown kind without inspecting its body', () => {
		expect(validateRoomBody('future-kind', { malformed: true })).toBe(false);
		for (const kind of ['constructor', 'toString', '__proto__'])
			expect(validateRoomBody(kind, null)).toBe(false);
	});

	it('rejects a malformed known body during journal replay', async () => {
		const opened = await memory.open();
		const name = roomName('invalid-body-replay');
		const storage = await opened.journals.open(name);
		await storage.append(
			{
				kind: 'message',
				body: { kind: 'said', at: '2026-01-01T00:00:00.000Z', from: 'alpha' },
				seq: 1,
			},
			0,
		);
		const journal = roomJournal(opened.journals.open(name));
		await expect(journal.ready).rejects.toThrow(/kind 'message'.*body\.text/);
	});

	it('replays a legacy message with optional roster fields omitted', async () => {
		const opened = await memory.open();
		const name = roomName('legacy-body-replay');
		const storage = await opened.journals.open(name);
		await storage.append(
			{
				kind: 'message',
				body: { kind: 'arrived', at: '2026-01-01T00:00:00.000Z', subject: 'andrei' },
				seq: 1,
			},
			0,
		);
		const journal = roomJournal(opened.journals.open(name));
		await journal.ready;
		expect(journal.entries).toHaveLength(1);
	});

	it('skips unknown and prototype entry kinds during replay', async () => {
		const opened = await memory.open();
		const name = roomName('unknown-body-replay');
		const storage = await opened.journals.open(name);
		for (const [position, kind] of [
			'future-kind',
			'constructor',
			'toString',
			'__proto__',
		].entries())
			await storage.append({ kind, body: null, seq: position + 1 }, position);
		const journal = roomJournal(opened.journals.open(name));
		await journal.ready;
		expect(journal.entries).toEqual([]);
	});

	it.each([
		['message', { kind: 'said', at: 'now', from: 'alpha' }, 'body.text'],
		[
			'message',
			{ kind: 'summary', at: 'now', from: 'a', to: 'p', text: 'x', covers: { from: 1 } },
			'body.covers.through',
		],
		[
			'lease',
			{ id: 'x', phase: 'running', expiresAt: Infinity, at: 'now', readThrough: 0 },
			'body.expiresAt',
		],
		[
			'lease',
			{ id: 'x', phase: 'running', expiresAt: 1, at: 'nonsense', readThrough: 0 },
			'body.at',
		],
		['close', { owner: 'a', from: 1, through: 2.5, at: 'now' }, 'body.through'],
		[
			'composition',
			{ version: 2, agents: [{ ...seating, attention: 'sometimes' }], available: [], at: 'now' },
			'body.agents[0].attention',
		],
		['run', { at: 7 }, 'body.at'],
	] as const)('reports the kind and path for malformed %s bodies', (kind, body, path) => {
		const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		expect(() => validateRoomBody(kind, body)).toThrow(new RegExp(`kind '${kind}'.*${escaped}`));
	});
});
