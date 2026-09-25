/**
 * What an agent reads about its processes: the state line of a result, the
 * `ps` table, and the reminder of an activation. Every function is pure: it
 * takes statuses and a time, and returns text.
 *
 * `docs/processes.md` states each text.
 */

import { markdownTable } from './markdown-table.ts';
import type { ProcessStatus } from './process-files.ts';

/** The most finished processes one reminder names. It names the newest. */
export const FINISHED_IN_REMINDER = 10;

/** The columns of the `ps` table. */
const PS_COLUMNS = ['Handle', 'Name', 'Runs for', 'Command'];

/** The most characters of a command that `ps` and the reminder show. */
const COMMAND_CHARS = 80;

/** `2m 14s`, `12s`, or `1h 3m`, for a span of milliseconds. */
function duration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
	return `${seconds}s`;
}

/** The first line of a command, cut to `COMMAND_CHARS`. */
function shortCommand(command: string): string {
	const first = command.trim().split('\n')[0] ?? '';
	return first.length > COMMAND_CHARS ? `${first.slice(0, COMMAND_CHARS - 3)}...` : first;
}

/** The handle, and the name in brackets when the process has one. */
function labelled(process: ProcessStatus): string {
	return process.name === undefined ? process.handle : `${process.handle} (${process.name})`;
}

/** One sentence for the state of a process, with its handle, its name, and its output file. */
export function stateLine(process: ProcessStatus): string {
	const who = `Process ${labelled(process)}`;
	const where = `Output: ${process.output}.`;
	switch (process.state) {
		case 'running':
			return `${who} is running. ${where} Call status, wait or cancel with its handle, or ps to list your processes.`;
		case 'exited':
			return `${who} exited with code ${process.exitCode}. ${where}`;
		case 'timed_out':
			return `${who} timed out after ${process.timeout} seconds. ${where}`;
		case 'cancelled':
			return `${who} is cancelled. ${where}`;
		case 'failed':
			return `${who} failed: ${process.error}. ${where}`;
	}
}

/**
 * The note for a running process that can run longer than the activation
 * lets the agent wait, when the room takes a say with `after`.
 */
export const LATER_LINE =
	'It can run longer than your activation lets you wait. To look at it later, say to yourself with after, in seconds.';

/** The end of a finished process, for the reminder. */
function endedAs(process: ProcessStatus): string {
	const at = process.endedAt === undefined ? '' : ` at ${process.endedAt.slice(11, 19)} UTC`;
	switch (process.state) {
		case 'exited':
			return `exited with code ${process.exitCode}${at}`;
		case 'timed_out':
			return `timed out${at}`;
		case 'cancelled':
			return `is cancelled${at}`;
		default:
			return `failed${at}`;
	}
}

/** One line of the reminder: the name first when the process has one, then the handle. */
function reminderLine(process: ProcessStatus, room: string, now: number): string {
	const who = process.name === undefined ? process.handle : `${process.name}, ${process.handle},`;
	const elsewhere =
		process.room !== undefined && process.room !== room ? ` in the room ${process.room}` : '';
	const what =
		process.state === 'running'
			? `is running for ${duration(now - Date.parse(process.startedAt))}${elsewhere}`
			: `${endedAs(process)}${elsewhere}`;
	return `- ${who} ${what}: ${shortCommand(process.command)}`;
}

/**
 * The reminder of one activation: every running process, and the newest
 * finished processes that no result showed yet. Undefined when there is
 * nothing to name. `room` is the room of the activation.
 */
export function reminderText(
	running: readonly ProcessStatus[],
	unseen: readonly ProcessStatus[],
	room: string,
	now: number,
): string | undefined {
	if (running.length === 0 && unseen.length === 0) return undefined;
	const finished = unseen.slice(-FINISHED_IN_REMINDER);
	const more = unseen.length - finished.length;
	return [
		'Your background processes in the workspace:',
		...[...running, ...finished].map((process) => reminderLine(process, room, now)),
		...(more > 0 ? [`- and ${more} more finished processes`] : []),
		'Call status, wait or cancel with a handle. Call ps to list processes.',
	].join('\n');
}

/** The `ps` table of the caller's running processes. */
export function psTable(processes: readonly ProcessStatus[], now: number): string {
	const rows = processes.map((process) => ({
		Handle: process.handle,
		Name: process.name ?? '',
		'Runs for': duration(now - Date.parse(process.startedAt)),
		Command: shortCommand(process.command),
	}));
	const count =
		processes.length === 1 ? '1 running process.' : `${processes.length} running processes.`;
	return `${markdownTable(PS_COLUMNS, rows)}\n\n${count}`;
}
