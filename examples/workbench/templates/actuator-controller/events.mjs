/**
 * The event log. The workspace sets `AMBION_EVENTS` to a file that it folds
 * into the status of the process. Without it, the log is `events.jsonl` in
 * the working directory.
 */

import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** The path of the event log. */
export function eventsPath() {
	return process.env.AMBION_EVENTS ?? resolve('events.jsonl');
}

/**
 * Append one line. The append is synchronous, so the line is in the file
 * before a later exit.
 */
export function emit(kind, fields) {
	const line = JSON.stringify({ v: 1, at: new Date().toISOString(), kind, ...fields });
	appendFileSync(eventsPath(), `${line}\n`);
}
