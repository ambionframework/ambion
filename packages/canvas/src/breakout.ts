/**
 * What each breakout tool does. A function here checks a call against the rows,
 * and asks the port to write. The port belongs to the canvas, so the checks
 * and the lifecycle read one set of rows.
 */
import { AmbionError, type Room, roomUri, type ToolContext } from '@ambionframework/ambion';
import { isName } from '@ambionframework/ambion/names';
import { refuse } from './cast.ts';
import type { BreakoutStart, CanvasClose, CanvasRoom } from './store.ts';

/** The most characters of a breakout room name, the parent included. */
const NAME_LIMIT = 48;
/** The default for `perOpener`. */
export const DEFAULT_PER_OPENER = 3;

/** What the breakout tools read and write on a canvas. */
export interface BreakoutPort {
	readonly perOpener: number;
	readonly team: ReadonlySet<string>;
	/** Refuses before `resume` and after `close`. */
	assertReady(): void;
	/** Runs the operation after the calls in flight on that room name. */
	serial<T>(name: string, operation: () => Promise<T>): Promise<T>;
	row(name: string): CanvasRoom | undefined;
	rows(): readonly CanvasRoom[];
	room(name: string): Room | undefined;
	mirror(name: string): string | undefined;
	/** Writes the row, starts the room, and posts the first message. */
	create(row: CanvasRoom): Promise<void>;
	/** Starts the room of a running row that has no live handle. */
	complete(name: string): Promise<void>;
	archive(name: string, close: CanvasClose): Promise<CanvasClose>;
}

/** The facts of a call that every tool reads from its context. */
export interface Caller {
	readonly room: string;
	readonly agent: string;
	readonly activation: string | undefined;
	readonly callId: string;
	readonly exchange: ToolContext['exchange'];
}

export interface BreakoutParams {
	readonly name: string;
	readonly goal: string;
	readonly message: string;
	readonly agents: readonly string[];
	readonly to?: string;
}

export interface BreakoutResult {
	readonly room: string;
	readonly uri: string;
	readonly mirror?: string;
	readonly state: 'running' | 'stopped' | 'archived';
	readonly created: boolean;
	readonly close?: CanvasClose;
}

/** The caller of a tool, or a refusal when the call has no room. */
export function callerOf(port: BreakoutPort, ctx: ToolContext): Caller {
	port.assertReady();
	if (ctx.room === undefined) throw refuse('The call has no room. A tool call needs a room.');
	return {
		room: ctx.room,
		agent: ctx.agent.name,
		activation: ctx.activation,
		callId: ctx.callId,
		exchange: ctx.exchange,
	};
}

/** The breakout start of a row, or undefined for a root row. */
export function startOf(row: CanvasRoom | undefined): BreakoutStart | undefined {
	return row?.start.kind === 'breakout' ? row.start : undefined;
}

/** The row of a room that this opener opened in this parent, or a refusal. */
function ownRow(port: BreakoutPort, caller: Caller, name: string): CanvasRoom {
	const row = port.row(name);
	if (row === undefined) throw refuse(`The canvas has no room "${name}".`);
	const start = startOf(row);
	if (start === undefined)
		throw refuse(`"${name}" is a root room. Only a breakout room opens here.`);
	if (start.opener !== caller.agent || start.parent !== caller.room)
		throw refuse(`You did not open the breakout room "${name}" in "${caller.room}".`);
	return row;
}

/** The refusal of a call from a breakout room, or from a room that the canvas does not hold. */
function assertOpenerRoom(port: BreakoutPort, caller: Caller): void {
	const row = port.row(caller.room);
	if (row === undefined) throw refuse(`The room "${caller.room}" is not on the canvas.`);
	if (row.depth !== 0) throw refuse('A breakout room opens no breakout room. Its depth is one.');
}

function assertName(parent: string, name: string): string {
	const full = `${parent}-${name}`;
	if (name === '' || !isName(full))
		throw refuse(
			`"${full}" is not a room name. Use lowercase letters, digits, and hyphens, and start with a letter.`,
		);
	if (full.length > NAME_LIMIT)
		throw refuse(
			`"${full}" has ${full.length} characters. A breakout room name has at most ${NAME_LIMIT}.`,
		);
	return full;
}

function assertAgents(port: BreakoutPort, agents: readonly string[]): void {
	if (agents.length === 0) throw refuse('agents names no worker. Name one or more.');
	const team = [...port.team].join(', ');
	for (const [index, name] of agents.entries()) {
		if (!port.team.has(name))
			throw refuse(`"${name}" is not in the worker team. The team is: ${team}.`);
		if (agents.indexOf(name) !== index) throw refuse(`agents names "${name}" twice.`);
	}
}

function assertPerOpener(port: BreakoutPort, caller: Caller): void {
	const held = port.rows().filter((row) => {
		const start = startOf(row);
		return (
			row.state === 'running' && start?.parent === caller.room && start.opener === caller.agent
		);
	}).length;
	if (held >= port.perOpener)
		throw refuse(
			`You hold ${held} running breakout rooms in "${caller.room}", and the bound perOpener is ${port.perOpener}. Archive one first.`,
		);
}

function resultOf(port: BreakoutPort, row: CanvasRoom, created: boolean): BreakoutResult {
	const mirror = port.mirror(row.name);
	return {
		room: row.name,
		uri: roomUri(row.name),
		...(mirror === undefined ? {} : { mirror }),
		state: row.state,
		created,
		...(row.close === undefined ? {} : { close: row.close }),
	};
}

/** The repeat of a call: the row, after the start completes. It checks no bound. */
async function repeated(
	port: BreakoutPort,
	caller: Caller,
	found: CanvasRoom,
): Promise<BreakoutResult> {
	const start = startOf(found);
	if (start?.opener !== caller.agent || start.parent !== caller.room)
		throw refuse(`The room name "${found.name}" belongs to another opener or to a root room.`);
	if (found.state === 'running') await port.complete(found.name);
	return resultOf(port, found, false);
}

/** Opens `<parent>-<name>`, or returns the room that this opener opened under that name. */
export async function openBreakout(
	port: BreakoutPort,
	caller: Caller,
	params: BreakoutParams,
): Promise<BreakoutResult> {
	assertOpenerRoom(port, caller);
	const full = `${caller.room}-${params.name}`;
	return port.serial(full, async () => {
		const found = port.row(full);
		if (found !== undefined) return repeated(port, caller, found);
		assertName(caller.room, params.name);
		assertAgents(port, params.agents);
		assertPerOpener(port, caller);
		if (port.room(caller.room) === undefined)
			throw refuse(`The room "${caller.room}" is not running.`);
		const row: CanvasRoom = {
			name: full,
			goal: params.goal,
			depth: 1,
			state: 'running',
			start: {
				kind: 'breakout',
				parent: caller.room,
				opener: caller.agent,
				agents: [...params.agents],
				message: params.message,
				...(params.to === undefined ? {} : { to: params.to }),
			},
		};
		await port.create(row);
		return resultOf(port, row, true);
	});
}

/** A room that stopped is a refusal, as the canvas states every refusal. */
function refusedStop(error: unknown, room: string): unknown {
	return error instanceof AmbionError && error.code === 'room_stopped'
		? refuse(`The room "${room}" is stopped.`)
		: error;
}

/** The seq of the message that landed under `key`, read from `after`. */
export async function seqUnder(
	room: Room,
	key: string,
	after: number,
): Promise<number | undefined> {
	const read = await room.read({ messages: { after } });
	return read.messages.find((message) => message.key === key)?.seq;
}

/** Posts into a room, and gives the seq of the post. */
export async function postInto(
	room: Room,
	post: { to?: string; text: string; refs?: string[]; key: string },
): Promise<number> {
	const handle = await room.post(post).catch((error: unknown) => {
		throw refusedStop(error, room.name);
	});
	return (await seqUnder(room, post.key, handle.from - 1)) ?? handle.from;
}

export interface TellParams {
	readonly room: string;
	readonly text: string;
	readonly to?: string;
	readonly refs?: readonly string[];
}

/** Posts into a running breakout room that the caller opened. */
export async function tellRoom(
	port: BreakoutPort,
	caller: Caller,
	params: TellParams,
): Promise<{ room: string; from: number }> {
	assertOpenerRoom(port, caller);
	ownRow(port, caller, params.room);
	if (caller.activation === undefined) throw refuse('The call has no activation.');
	const key = `tell:${caller.activation}:${caller.callId}`;
	return port.serial(params.room, async () => {
		const row = ownRow(port, caller, params.room);
		if (row.state !== 'running') throw refuse(`The room "${row.name}" is ${row.state}.`);
		const room = port.room(row.name);
		if (room === undefined) throw refuse(`The room "${row.name}" has no live handle.`);
		const from = await postInto(room, {
			...(params.to === undefined ? {} : { to: params.to }),
			text: params.text,
			...(params.refs === undefined ? {} : { refs: [...params.refs] }),
			key,
		});
		return { room: row.name, from };
	});
}

export interface ArchiveParams {
	readonly room: string;
	readonly result: 'done' | 'failed';
	readonly note?: string;
}

/** Archives a breakout room that the caller opened. A repeat returns the recorded result. */
export async function archiveRoom(
	port: BreakoutPort,
	caller: Caller,
	params: ArchiveParams,
): Promise<CanvasClose & { room: string }> {
	assertOpenerRoom(port, caller);
	const row = ownRow(port, caller, params.room);
	const close = await port.archive(row.name, {
		result: params.result,
		...(params.note === undefined ? {} : { note: params.note }),
	});
	return { room: row.name, ...close };
}
