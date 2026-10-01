/**
 * The cases of the composition helpers that no bundle reaches: a note that
 * is empty, a reminder that gives blank text, and reminders that are absent.
 */
import type { ReminderSeat } from '@ambionframework/ambion';
import { expect, it } from 'vitest';
import { joinNotes, mergeReminders } from '../src/capability.ts';

const seat: ReminderSeat = { agent: 'analyst', room: 'lab', activation: 'a1' };

it('drops an empty note from the joined notes', () => {
	expect(joinNotes(['one', '', 'two'])).toBe('one\n\ntwo');
});

it('has no reminder when none is set, and no text when a reminder gives blank text', async () => {
	expect(mergeReminders([])).toBeUndefined();
	expect(mergeReminders([undefined])).toBeUndefined();
	const blank = mergeReminders([async () => ' \n', async () => 'text']);
	expect(await blank?.(seat, new AbortController().signal)).toBe('text');
	const none = mergeReminders([async () => ' \n']);
	expect(await none?.(seat, new AbortController().signal)).toBeUndefined();
});
