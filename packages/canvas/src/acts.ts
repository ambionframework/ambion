/**
 * What an act does. A function here checks a press against the rows and the widget revisions,
 * then sends it as a message of the person through the room of the widget. The answers of a
 * room come from the keys of its journal, so no store holds them.
 */
import { AmbionError, type PersonDefinition, type Room } from '@ambionframework/ambion';
import { type ActValues, assertValues, valueLines } from './actions.ts';
import { recipientOf } from './bridge.ts';
import { refuse } from './cast.ts';
import { assertLine, type BasePort } from './port.ts';
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
export interface ActPort extends BasePort {
	/** The name of the canvas. */
	readonly canvas: string;
	/** The current revision of a widget, hidden ones included. */
	current(room: string, name: string): CanvasWidget | undefined;
	/** The live handle of a room of this run. */
	room(name: string): Room | undefined;
	/** Holds the answer, and tells the listeners when it is new. */
	answer(room: string, revision: string, answer: Answer): void;
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

/** The answers that the journal of a room holds: one for each message under a once key. */
async function readAnswers(room: Room): Promise<ReadonlyMap<string, Answer>> {
	const found = new Map<string, Answer>();
	for (const message of (await room.read()).messages) {
		const revision = message.key === undefined ? undefined : ONCE_KEY.exec(message.key)?.[1];
		if (revision !== undefined && message.kind === 'said' && !found.has(revision))
			found.set(revision, { seq: message.seq, by: message.from });
	}
	return found;
}

/** The message under a key, read from after a seq. */
async function landedUnder(room: Room, key: string, after: number): Promise<Answer | undefined> {
	const found = (await room.read({ messages: { after } })).messages.find(
		(message) => message.key === key,
	);
	return found?.kind === 'said' ? { seq: found.seq, by: found.from } : undefined;
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

function shownWidget(port: ActPort, act: WidgetAct): CanvasWidget {
	const widget = port.current(act.room, act.widget);
	if (widget === undefined) throw refuse(`The room "${act.room}" has no widget "${act.widget}".`);
	if (widget.state !== 'shown') throw refuse(`The widget "${act.widget}" is hidden.`);
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
const keyOf = (widget: CanvasWidget, action: WidgetAction, act: WidgetAct): string =>
	action.once === true ? `act:${widget.revision}` : `act:${widget.revision}:${act.press}`;

/**
 * Sends the act under its key. A once key that the room holds with other content means that
 * another act answered the revision, and the answer is the seq under the key.
 */
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
		const landed = await landedUnder(room, key, handle.from - 1);
		const answer = landed ?? { seq: handle.from, by: person.name };
		if (action.once === true) port.answer(widget.room, widget.revision, answer);
		return { kind: 'sent', seq: answer.seq };
	} catch (error) {
		return settle(port, room, widget, action, key, error);
	}
}

/** A refusal of a once key is `answered`. Any other failure reaches the caller. */
async function settle(
	port: ActPort,
	room: Room,
	widget: CanvasWidget,
	action: WidgetAction,
	key: string,
	error: unknown,
): Promise<WidgetActResult> {
	if (!(error instanceof AmbionError)) port.fail(widget.room, error);
	if (!(error instanceof AmbionError) || error.code !== 'refused' || action.once !== true)
		throw error;
	const answer = await landedUnder(room, key, 0);
	if (answer === undefined) throw error;
	port.answer(widget.room, widget.revision, answer);
	return { kind: 'answered', seq: answer.seq };
}

/** Checks an act in the widget queue of its room, and sends it as a message of the person. */
export async function actOn(
	port: ActPort,
	person: PersonDefinition,
	act: WidgetAct,
): Promise<WidgetActResult> {
	port.assertReady();
	return port.serial(act.room, async () => {
		port.assertReady();
		const room = runningRoom(port, act.room);
		const widget = shownWidget(port, act);
		if (widget.revision !== act.revision) return { kind: 'stale', widget: structuredClone(widget) };
		const action = checkedAction(widget, person, act);
		return send(port, room, person, widget, action, act);
	});
}
