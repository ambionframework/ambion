/**
 * What an act does. A function here finds a press that landed already, or checks it against the
 * rows and the widget revisions and sends it as a message of the person through the room of the
 * widget. The answers of a room come from the keys of its journal, so no store holds them.
 */
import {
	AmbionError,
	type Message,
	type PersonDefinition,
	type Room,
	type SaidMessage,
} from '@ambionframework/ambion';
import { type ActValues, assertValues, valueLines } from './actions.ts';
import { recipientOf } from './bridge.ts';
import { refuse } from './cast.ts';
import { assertLine, type CurrentPort } from './port.ts';
import type { CanvasWidget, WidgetAction } from './store.ts';
import type { WidgetAct, WidgetActResult } from './types.ts';

/** The most characters of a press token. */
const PRESS_LIMIT = 100;

/** The act that answers a revision: its seq, and the person who made it. */
export interface Answer {
	readonly seq: number;
	readonly by: string;
}

/** What `act` reads and writes on a canvas. */
export interface ActPort extends CurrentPort {
	/** The name of the canvas. */
	readonly canvas: string;
	/** One revision by id. */
	revision(id: string): CanvasWidget | undefined;
	/** The live handle of a room of this run. */
	room(name: string): Room | undefined;
	/** Holds the answer, and tells the listeners when it is new. */
	hold(room: string, revision: string, answer: Answer): void;
	/** Reports a failure that is no refusal to `onError`. */
	fail(room: string, error: unknown): void;
}

/** The answers that this run knows, by room and revision. */
export class Answers {
	private readonly rooms = new Map<string, Map<string, Answer>>();

	/** Holds an answer. It returns false when the revision has an answer already. */
	hold(room: string, revision: string, answer: Answer): boolean {
		const held = this.rooms.get(room) ?? new Map<string, Answer>();
		this.rooms.set(room, held);
		if (held.has(revision)) return false;
		held.set(revision, answer);
		return true;
	}

	of(room: string): ReadonlyMap<string, Answer> {
		return this.rooms.get(room) ?? new Map<string, Answer>();
	}

	/** Reads the answers that the journal of a room holds. */
	async learn(name: string, room: Room): Promise<void> {
		for (const [revision, answer] of await readAnswers(room)) this.hold(name, revision, answer);
	}
}

/** The key of a once action. A key with a press token after the revision answers nothing. */
const ONCE_KEY = /^act:([^:]+)$/;

/** Whether a message is a person's speech under a key. A message of an agent or the host is no act. */
function isActUnder(message: Message, key: string): message is SaidMessage {
	return message.key === key && message.kind === 'said' && message.activation === undefined;
}

/** The answers that the journal of a room holds: one for each message of a person under a once key. */
async function readAnswers(room: Room): Promise<ReadonlyMap<string, Answer>> {
	const found = new Map<string, Answer>();
	for (const message of (await room.read()).messages) {
		const revision = message.key === undefined ? undefined : ONCE_KEY.exec(message.key)?.[1];
		if (revision !== undefined && message.kind === 'said' && message.activation === undefined)
			found.set(revision, { seq: message.seq, by: message.from });
	}
	return found;
}

/** The message of a person under a key, read from after a seq. */
async function messageUnder(
	room: Room,
	key: string,
	after: number,
): Promise<SaidMessage | undefined> {
	return (await room.read({ messages: { after } })).messages.find((message) =>
		isActUnder(message, key),
	) as SaidMessage | undefined;
}

/** The running room of an act: the canvas holds its row, and it has a live handle. */
function runningRoom(port: ActPort, name: string): Room {
	const row = port.row(name);
	if (row === undefined) throw refuse(`The room "${name}" is not on the canvas.`);
	if (row.state !== 'running') throw refuse(`The room "${name}" is ${row.state}.`);
	const room = port.room(name);
	if (room === undefined) throw refuse(`The room "${name}" has no live handle.`);
	return room;
}

function currentWidget(port: ActPort, act: WidgetAct): CanvasWidget {
	const widget = port.current(act.room, act.widget);
	if (widget === undefined) throw refuse(`The room "${act.room}" has no widget "${act.widget}".`);
	return widget;
}

/** The action of an act, when the person may press it with these values. */
function checkedAction(
	widget: CanvasWidget,
	person: PersonDefinition,
	act: WidgetAct,
): WidgetAction {
	const action = widget.actions.find((one) => one.id === act.action);
	if (action === undefined)
		throw refuse(
			`The widget "${widget.name}" has no action "${act.action}". Its actions are: ${widget.actions.map((one) => one.id).join(', ')}.`,
		);
	if (widget.for !== undefined && widget.for !== person.name)
		throw refuse(`The widget "${widget.name}" is for ${widget.for}.`);
	assertValues(action, act.values);
	assertLine('The press', act.press, PRESS_LIMIT);
	return action;
}

/** The ref of the revision that a person saw. */
const refOf = (canvas: string, widget: CanvasWidget): string =>
	`ambion-canvas://${canvas}/room/${widget.room}/widget/${widget.name}/revision/${widget.revision}`;

/** The text that an agent reads with no lookup: the widget, its rev, the label, the id, and the values. */
function textOf(widget: CanvasWidget, action: WidgetAction, values: ActValues | undefined): string {
	const title = widget.title === undefined ? '' : ` "${widget.title}"`;
	const head = `${widget.name}, rev ${widget.rev}${title}: ${action.label} [${action.id}]`;
	return [head, ...valueLines(action, values)].join('\n');
}

/** A once action lands under the key of its revision, and any other action under its press. */
const keyOf = (revision: CanvasWidget, action: WidgetAction, act: WidgetAct): string =>
	action.once === true ? `act:${revision.revision}` : `act:${revision.revision}:${act.press}`;

/** The revision that the act names, and its action, when the canvas holds both. */
function seenBy(port: ActPort, act: WidgetAct): [CanvasWidget, WidgetAction] | undefined {
	const seen = port.revision(act.revision);
	const action = seen?.actions.find((one) => one.id === act.action);
	const same = seen?.room === act.room && seen.name === act.widget;
	return seen === undefined || action === undefined || !same ? undefined : [seen, action];
}

/**
 * The result of a press that landed already. The revision of the act fixes the key, so the
 * lookup needs no current widget. The same person, text, and ref make the press the landed one,
 * whatever its `to`. A once key with other content is `answered`. A press key with other content
 * is a refusal. A press that did not land gives undefined.
 */
async function landedResult(
	port: ActPort,
	room: Room,
	person: PersonDefinition,
	act: WidgetAct,
): Promise<WidgetActResult | undefined> {
	const seen = seenBy(port, act);
	if (seen === undefined) return undefined;
	const [revision, action] = seen;
	const found = await messageUnder(room, keyOf(revision, action, act), 0);
	if (found === undefined) return undefined;
	const same =
		found.from === person.name &&
		found.text === textOf(revision, action, act.values) &&
		JSON.stringify(found.refs ?? []) === JSON.stringify([refOf(port.canvas, revision)]);
	if (action.once === true) port.hold(act.room, act.revision, { seq: found.seq, by: found.from });
	if (same) return { kind: 'sent', seq: found.seq };
	if (action.once === true) return { kind: 'answered', seq: found.seq };
	throw refuse(`The press "${act.press}" landed with other content at #${found.seq}.`);
}

/** Sends the act under its key, and reads the seq under the key. */
async function send(
	port: ActPort,
	room: Room,
	person: PersonDefinition,
	widget: CanvasWidget,
	action: WidgetAction,
	act: WidgetAct,
): Promise<WidgetActResult> {
	const key = keyOf(widget, action, act);
	const to = await recipientOf(room, widget.author);
	const visit = await room.visit(person);
	try {
		const handle = await visit.send({
			...(to === undefined ? {} : { to }),
			text: textOf(widget, action, act.values),
			refs: [refOf(port.canvas, widget)],
			key,
		});
		const landed = await messageUnder(room, key, handle.from - 1);
		if (landed === undefined) throw new Error(`The room holds no message under the key "${key}".`);
		if (action.once === true)
			port.hold(widget.room, widget.revision, { seq: landed.seq, by: person.name });
		return { kind: 'sent', seq: landed.seq };
	} catch (error) {
		return afterFailure(port, room, person, act, error);
	}
}

/**
 * A send that failed. A stopped room is a refusal. A refused key may hold this press with other
 * `to`, or hold another act, so the lookup runs again.
 */
async function afterFailure(
	port: ActPort,
	room: Room,
	person: PersonDefinition,
	act: WidgetAct,
	error: unknown,
): Promise<WidgetActResult> {
	if (!(error instanceof AmbionError)) throw error;
	if (error.code === 'room_stopped') throw refuse(`The room "${act.room}" stopped.`);
	const result = error.code === 'refused' ? await landedResult(port, room, person, act) : undefined;
	if (result === undefined) throw error;
	return result;
}

/** The steps after the room check: a landed press, then the widget checks, then the send. */
async function actInRoom(
	port: ActPort,
	room: Room,
	person: PersonDefinition,
	act: WidgetAct,
): Promise<WidgetActResult> {
	const landed = await landedResult(port, room, person, act);
	if (landed !== undefined) return landed;
	const widget = currentWidget(port, act);
	if (widget.state !== 'shown' || widget.revision !== act.revision)
		return { kind: 'stale', widget: structuredClone(widget) };
	return send(port, room, person, widget, checkedAction(widget, person, act), act);
}

/**
 * Finds a press that landed already, or checks the act in the widget queue of its room and
 * sends it as a message of the person. A stop or an archive that wins the race with a send is
 * a refusal, and an act that passed its checks before the stop may still land.
 */
export async function actOn(
	port: ActPort,
	person: PersonDefinition,
	act: WidgetAct,
): Promise<WidgetActResult> {
	port.assertReady();
	return port.serial(act.room, async () => {
		port.assertReady();
		const room = runningRoom(port, act.room);
		try {
			return await actInRoom(port, room, person, act);
		} catch (error) {
			if (!(error instanceof AmbionError)) port.fail(act.room, error);
			throw error;
		}
	});
}
