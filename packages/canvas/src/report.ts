/** The `report` tool: a worker posts into the parent room, to the opener. */
import { type BreakoutPort, type Caller, refusedStop, startOf } from './breakout.ts';
import { land, recipientOf } from './bridge.ts';
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
	const exchange = caller.exchange.from;
	// The bridge picks the recipient inside the order of its posts for the parent.
	return port.ordered(start.parent, async () => {
		const to = await recipientOf(parent, start.opener);
		const from = await land(parent, {
			...(to === undefined ? {} : { to }),
			text: `breakout ${row.name}: ${params.text}`,
			...(params.refs === undefined ? {} : { refs: [...params.refs] }),
			key: `breakout:${row.name}:${exchange}:report:${caller.callId}`,
		}).catch((error: unknown) => {
			throw refusedStop(error, start.parent);
		});
		return { room: start.parent, from, ...(to === undefined ? {} : { to }) };
	});
}
