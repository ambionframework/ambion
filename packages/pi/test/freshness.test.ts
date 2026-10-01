/**
 * The ranges of the record in the session. Each range is an `ambion.record`
 * entry with its positions as data. A reopened session reports the position
 * it read through, and an omitted range does not count.
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { EntryRecord } from '@earendil-works/pi-durable';
import { describe, expect, it } from 'vitest';
import {
	omitDraft,
	omittedIn,
	RECORD,
	rangeOf,
	recordDraft,
	steerDraft,
} from '../src/freshness.ts';
import { diskSessions } from '../src/sessions.ts';
import { entriesOf, resumeBase } from '../src/transcript.ts';
import { seed, withRoot } from './support/storage.ts';
import { tempDir } from './support/temp.ts';

/** An entry as the session returns it. */
const entry = (id: number, fields: Partial<EntryRecord>): EntryRecord =>
	({ id, conversationId: 0, kind: RECORD, ...fields }) as EntryRecord;

describe('the ranges of the record', () => {
	it.each([
		['a range', { data: { after: 0, through: 3 } }, { after: 0, through: 3 }],
		[
			'a steered line',
			{ data: { after: 3, through: 4, steer: true } },
			{ after: 3, through: 4, steer: true },
		],
		['a range with a position that is no count', { data: { after: -1, through: 2 } }, undefined],
		[
			'a range with positions that are no numbers',
			{ data: { after: 0, through: 'two' } },
			undefined,
		],
		['data that is no object', { data: 'two' }, undefined],
		['data that is a list', { data: [0, 1] }, undefined],
		['no data', {}, undefined],
		['an entry of another kind', { kind: 'pi.user', data: { after: 0, through: 3 } }, undefined],
	])('reads %s from its entry', (_name, fields, range) => {
		expect(rangeOf(entry(1, fields))).toEqual(range);
	});

	it('writes a range as data alone, and a steered line with its own text', () => {
		expect(recordDraft({ after: 0, through: 2 })).toEqual({
			kind: RECORD,
			data: { after: 0, through: 2 },
		});
		expect(steerDraft({ after: 2, through: 3, steer: true }, '[new] Late.', 7)).toEqual({
			kind: RECORD,
			data: { after: 2, through: 3, steer: true },
			model: [{ role: 'user', content: '[new] Late.', timestamp: 7 }],
		});
		const omit = omitDraft([4 as never, 5 as never]);
		expect(omit.edits).toEqual([
			{ target: 4, action: 'omit' },
			{ target: 5, action: 'omit' },
		]);
		expect(omittedIn([entry(6, { edits: omit.edits })])).toEqual(new Set([4, 5]));
	});

	it('reports the largest position of a session file after it closes, and leaves out an omitted range', async () => {
		const sessions = diskSessions(await tempDir('ambion-freshness-'));
		const scope = { room: 'room', seat: 'seat' };
		const id = 'message:1:seat:1';
		await seed(sessions, scope, id, [
			recordDraft({ after: 0, through: 2 }),
			recordDraft({ after: 2, through: 3 }),
		]);
		expect(await withRoot(sessions, scope, id, resumeBase)).toBe(3);
		// Omit the last range, the way a rewind does.
		const base = await withRoot(sessions, scope, id, async (root) => {
			const newest = (await entriesOf(root)).at(-1);
			if (newest === undefined) throw new Error('The session holds no entry.');
			const omit = await root.submit(
				{ type: 'write', entry: omitDraft([newest.id]) },
				BACKGROUND_CONTEXT,
			);
			await omit.wait(BACKGROUND_CONTEXT);
			return resumeBase(root);
		});
		expect(base).toBe(2);
	});
});
