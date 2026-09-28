import { describe, expect, it } from 'vitest';
import { hostingOf } from '../src/hosting.ts';
import { createRuntime, startRoom } from '../src/index.ts';
import { roomJournal } from '../src/journal/journal.ts';
import { validateRoomBody } from '../src/journal/validate.ts';
import { roomName, storedOf } from './support/room.ts';
import { stopAtEnd } from './support/stop.ts';
import { memory } from './support/storage.ts';

const seating = { name: 'alpha', identity: 'Researcher', attention: 'broadcast' };
const at = '2026-01-01T00:00:00.000Z';
const summary = {
	kind: 'summary',
	at,
	from: 'a',
	to: 'b',
	text: 'x',
	covers: { from: 1, through: 2 },
};
const returned = { kind: 'returned', at, to: 'alpha', message: 3, owner: 'andrei', text: 'x' };
const ended = { id: 'message:1:alpha:1', phase: 'ended', reason: 'released', at, readThrough: 3 };

/** A journal that replays these stored entries, one place each. */
async function replay(entries: readonly { kind: string; body: unknown }[]) {
	const opened = await memory.open();
	const name = roomName('replay');
	const storage = await opened.journals.open(name);
	for (const [position, entry] of entries.entries())
		await storage.append({ ...entry, seq: position + 1 }, position);
	return roomJournal(opened.journals.open(name));
}

describe('room journal body validation', () => {
	it.each([
		[
			'message',
			{
				kind: 'said',
				at,
				from: 'alpha',
				to: 'beta',
				text: 'hello',
				activationId: 'message:1:alpha:1',
				wakes: ['beta'],
				refs: ['https://x/a', 'ambion://room/site/message/3'],
			},
		],
		['message', { ...summary, refs: ['https://x/a'] }],
		['message', summary],
		[
			'message',
			{ kind: 'said', at, from: 'alpha', to: 'alpha', text: 'x', after: 600, owner: 'andrei' },
		],
		['message', { ...returned, refs: ['https://x/a'], wakes: ['alpha'] }],
		['message', { kind: 'dismissed', at, message: 3 }],
		[
			'message',
			{ kind: 'dismissed', at, from: 'alpha', message: 3, activationId: 'message:1:alpha:1' },
		],
		['message', { kind: 'arrived', at, subject: 'andrei' }],
		['message', { kind: 'left', at, subject: 'andrei' }],
		['message', { kind: 'seated', at, subject: 'andrei' }],
		['message', { kind: 'unseated', at, subject: 'andrei' }],
		['message', { kind: 'seated', at, subject: 'andrei', fixed: true }],
		[
			'lease',
			{ id: 'message:1:alpha:1', phase: 'running', expiresAt: 1735689600000, at, readThrough: 0 },
		],
		['lease', ended],
		['lease', { ...ended, session: { harness: 'claude', id: 'abc' } }],
		['close', { owner: 'andrei', from: 1, through: 5, at, summary: 'assistant' }],
		[
			'composition',
			{
				goal: 'Draft the weekly.',
				summary: 'assistant',
				agents: [seating],
				available: [{ name: 'beta', identity: 'Reviewer', attention: 'broadcast' }],
				at,
			},
		],
		['run', { at }],
		['cancel', { at }],
	])('accepts a stored %s body with its optional fields: %j', (kind, body) => {
		expect(validateRoomBody(kind, body)).toBe(true);
	});

	it.each([
		['a non-array', 'https://x/a', /body\.refs/],
		['a number entry', [1], /body\.refs\[0\]/],
		['a relative path', ['shared/report.md'], /body\.refs: refs\[0\]/],
		['a duplicate', ['https://x/a', 'https://x/a'], /body\.refs: refs\[1\]/],
	])('rejects refs that hold %s', (_name, refs, message) => {
		expect(() =>
			validateRoomBody('message', { kind: 'said', at, from: 'a', text: 'x', refs }),
		).toThrow(message);
		expect(() => validateRoomBody('message', { ...summary, refs })).toThrow(message);
		expect(() => validateRoomBody('message', { ...returned, refs })).toThrow(message);
	});

	it.each([
		['message', { kind: 'said', at: 'now', from: 'alpha' }, 'body.text'],
		['message', { ...summary, covers: { from: 1 } }, 'body.covers.through'],
		['message', { kind: 'said', at, from: 'alpha', text: 'x', after: 0 }, 'body.after'],
		['message', { kind: 'said', at, from: 'alpha', text: 'x', after: 1.5 }, 'body.after'],
		['message', { ...returned, message: 0 }, 'body.message'],
		['message', { kind: 'returned', at, to: 'alpha', message: 3, text: 'x' }, 'body.owner'],
		['message', { ...returned, from: 'alpha' }, 'body.from'],
		['message', { kind: 'dismissed', at, message: 0 }, 'body.message'],
		['message', { kind: 'dismissed', at, message: 3, from: 'alpha' }, 'body.activationId'],
		[
			'message',
			{ kind: 'dismissed', at, message: 3, activationId: 'message:1:alpha:1' },
			'body.from',
		],
		['message', { kind: 'dismissed', at, message: 3, text: 'x' }, 'body.text'],
		[
			'message',
			{ kind: 'said', at, from: 'alpha', to: 'alpha', text: 'x', after: 60 },
			'body.owner',
		],
		['message', { kind: 'said', at, from: 'alpha', text: 'x', owner: 'andrei' }, 'body.after'],
		[
			'message',
			{ kind: 'said', at, from: 'alpha', to: 'beta', text: 'x', after: 60, owner: 'andrei' },
			'body.to',
		],
		['message', { kind: 'seated', at, subject: 'andrei', fixed: 'yes' }, 'body.fixed'],
		[
			'message',
			{ kind: 'said', at, from: 'alpha', text: 'hello', activationId: 'message:1' },
			'body.activationId',
		],
		[
			'lease',
			{ id: 'message:1:alpha:0', phase: 'running', expiresAt: 1735689600000, at, readThrough: 0 },
			'body.id',
		],
		['lease', { ...ended, session: { harness: 'claude' } }, 'body.session.id'],
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
			{ agents: [{ ...seating, attention: 'sometimes' }], available: [], at: 'now' },
			'body.agents[0].attention',
		],
		['run', { at: 7 }, 'body.at'],
		['run', null, 'body'],
	] as const)('reports the kind and the path of a malformed %s body at %s', (kind, body, path) => {
		const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		expect(() => validateRoomBody(kind, body)).toThrow(new RegExp(`kind '${kind}'.*${escaped}`));
	});

	it.each([
		['cancel', { at, close: { owner: 'andrei', from: 1, through: 2, at } }, 'body.close'],
		['close', { owner: 'andrei', from: 1, through: 2, at, cancelled: true }, 'body.cancelled'],
		['run', { at, format: 1 }, 'body.format'],
	] as const)('refuses a %s body with the old field at %s', (kind, body, path) => {
		const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		expect(() => validateRoomBody(kind, body)).toThrow(
			new RegExp(`kind '${kind}' at ${escaped}: expected no such field`),
		);
	});

	it('writes a run entry with the time alone', async () => {
		const opened = await memory.open();
		const name = roomName('run-fence');
		const runtime = createRuntime({ storage: opened.storage });
		stopAtEnd(await startRoom({ name, runtime, agents: [], seats: {} }));
		const stored = await storedOf(hostingOf(runtime).journals, name);
		expect(stored.find((entry) => entry.kind === 'run')?.body).toEqual({ at: expect.any(String) });
	});

	it('skips an unknown kind without inspecting its body, and skips it during replay', async () => {
		const kinds = ['future-kind', 'constructor', 'toString', '__proto__'];
		expect(validateRoomBody('future-kind', { malformed: true })).toBe(false);
		for (const kind of kinds) expect(validateRoomBody(kind, null)).toBe(false);
		const journal = await replay(kinds.map((kind) => ({ kind, body: null })));
		await journal.ready;
		expect(journal.entries).toEqual([]);
	});

	it('rejects a malformed known body during journal replay', async () => {
		const journal = await replay([{ kind: 'message', body: { kind: 'said', at, from: 'alpha' } }]);
		await expect(journal.ready).rejects.toThrow(/kind 'message'.*body\.text/);
	});

	it('replays a legacy message with optional roster fields omitted', async () => {
		const journal = await replay([
			{ kind: 'message', body: { kind: 'arrived', at, subject: 'andrei' } },
		]);
		await journal.ready;
		expect(journal.entries).toHaveLength(1);
	});
});
