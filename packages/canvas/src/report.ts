/** The `report` tool: a worker posts into the parent room, to the opener. */
import { AmbionError, type Room } from '@ambionframework/ambion';
import { type BreakoutPort, type Caller, postInto, seqUnder, startOf } from './breakout.ts';
import { refuse } from './cast.ts';

export interface ReportParams {
	readonly text: string;
	readonly refs?: readonly string[];
}

export interface ReportResult {
	readonly room: string;
	readonly from: number;
	readonly to?: string;
}

/** The opener when it sits on the roster of the parent at an attention other than `none`. */
async function recipientOf(parent: Room, opener: string): Promise<string | undefined> {
	const read = await parent.read({ messages: false });
	const seat = read.participants.find((one) => one.kind === 'agent' && one.name === opener);
	return seat?.kind === 'agent' && seat.attention !== 'none' ? opener : undefined;
}

type Post = { to?: string; text: string; refs?: string[]; key: string };

/** Posts the report. A key that the parent holds already counts as landed. */
async function land(parent: Room, post: Post): Promise<number> {
	try {
		return await postInto(parent, post);
	} catch (error) {
		// A refusal may mean that the key landed with other content. The record has no cheaper anchor than its start.
		const seq =
			error instanceof AmbionError && error.code === 'refused'
				? await seqUnder(parent, post.key, 0)
				: undefined;
		if (seq === undefined) throw error;
		return seq;
	}
}

/** Posts the text into the parent room, as a report of the exchange that activated the caller. */
export async function reportToParent(
	port: BreakoutPort,
	caller: Caller,
	params: ReportParams,
): Promise<ReportResult> {
	// A call from a root room is refused at once: it never waits in the queue of a root.
	if (startOf(port.row(caller.room)) === undefined)
		throw refuse(`"${caller.room}" is not a breakout room. Only a worker in one reports.`);
	return port.serial(caller.room, () => reportQueued(port, caller, params));
}

async function reportQueued(
	port: BreakoutPort,
	caller: Caller,
	params: ReportParams,
): Promise<ReportResult> {
	const row = port.row(caller.room);
	const start = startOf(row);
	if (row === undefined || start === undefined)
		throw refuse(`"${caller.room}" is not a breakout room. Only a worker in one reports.`);
	const parent = port.room(start.parent);
	if (parent === undefined) throw refuse(`The parent "${start.parent}" is not running.`);
	if (caller.exchange === undefined)
		throw refuse('report inside the exchange that activated you. This call has no exchange.');
	if (row.state !== 'running') throw refuse(`The room "${row.name}" is ${row.state}.`);
	const to = await recipientOf(parent, start.opener);
	const from = await land(parent, {
		...(to === undefined ? {} : { to }),
		text: `breakout ${row.name}: ${params.text}`,
		...(params.refs === undefined ? {} : { refs: [...params.refs] }),
		key: `breakout:${row.name}:${caller.exchange.from}:report:${caller.callId}`,
	});
	return { room: start.parent, from, ...(to === undefined ? {} : { to }) };
}
