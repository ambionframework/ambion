/**
 * The event log. `ACTUATOR_EVENTS` names the file, and the default is
 * `events.jsonl` in the working directory.
 */

import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** The path of the event log. */
export function eventsPath() {
	return process.env.ACTUATOR_EVENTS ?? resolve('events.jsonl');
}

/**
 * Append one line. The append is synchronous, so the line is in the file
 * before a later exit.
 */
export function emit(kind, fields) {
	const line = JSON.stringify({ v: 1, at: new Date().toISOString(), kind, ...fields });
	appendFileSync(eventsPath(), `${line}\n`);
}
