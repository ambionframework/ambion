/** The reminder of the canvas bundle. It reads the row of the room of the seat. */
import type { Reminder, ReminderSeat, Room } from '@ambionframework/ambion';
import { type BreakoutPort, startOf } from './breakout.ts';
import { reminderLines } from './port.ts';
import type { BreakoutStart, CanvasRoom } from './store.ts';

/** The last message of the exchange that holds the seq, or that seq. */
async function lastMessage(room: Room, anchor: number): Promise<number> {
	const read = await room.read({ messages: { after: anchor - 1 } });
	return read.messages.at(-1)?.seq ?? anchor;
}

/** What a running room shows: its open exchange, or its last closed exchange, and its last message. */
async function runningFacts(room: Room): Promise<string> {
	const read = await room.read({ messages: false });
	if (read.exchange !== undefined)
		return `exchange #${read.exchange.from} open, last message #${await lastMessage(room, read.exchange.from)}`;
	const closed = read.exchanges.filter((exchange) => exchange.status === 'closed').at(-1);
	if (closed?.status !== 'closed') return 'no exchange open';
	return `no exchange open, last message #${await lastMessage(room, closed.through)}`;
}

async function lineOf(row: CanvasRoom, room: Room | undefined): Promise<string> {
	if (row.state === 'stopped') return `- ${row.name}: stopped`;
	if (room === undefined) return `- ${row.name}: running, not started`;
	const facts = await runningFacts(room).catch(() => undefined);
	return `- ${row.name}: running${facts === undefined ? '' : `, ${facts}`}`;
}

/** The reminder of a breakout room: its opener, its parent, its goal, and what `report` carries. */
function openerText(row: CanvasRoom, start: BreakoutStart): string {
	return `${start.opener} opened this room from ${start.parent} for: ${row.goal}\n\`report\` carries your result, or a question that needs a person, to ${start.opener}.`;
}

/** The reminder of a root room: the rows that the seat opened in it, archived rows left out. */
async function heldText(port: BreakoutPort, seat: ReminderSeat): Promise<string | undefined> {
	const rows = port.rows().filter((row) => {
		const start = startOf(row);
		return row.state !== 'archived' && start?.opener === seat.agent && start.parent === seat.room;
	});
	if (rows.length === 0) return undefined;
	const lines = await reminderLines(rows, (row) => lineOf(row, port.room(row.name)));
	return ['Your breakout rooms:', ...lines].join('\n');
}

/** The reminder text: the opener of a breakout room, or the breakout rooms that the seat holds. */
export function breakoutReminder(port: BreakoutPort): Reminder {
	return async (seat) => {
		const row = port.row(seat.room);
		const start = startOf(row);
		if (row !== undefined && start !== undefined) return openerText(row, start);
		return heldText(port, seat);
	};
}
