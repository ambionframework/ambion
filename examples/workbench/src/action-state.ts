import { AmbionError } from '@ambionframework/ambion';
import type {
	CanvasWidget,
	WidgetAct,
	WidgetAction,
	WidgetActResult,
	WidgetField,
} from '@ambionframework/canvas';
import { plain } from './pins.ts';

/** The act that answers a revision: its seq and the person. */
export interface Answered {
	seq: number;
	by: string;
}

/** One widget as the actions need it: what the person can press, and whether it is answered. */
export interface ActionWidget {
	room: string;
	name: string;
	revision: string;
	/** Counts the revisions of this name. A stale result carries a newer one. */
	rev: number;
	actions: readonly WidgetAction[];
	/** The one person who may act. */
	for?: string;
	answered?: Answered;
}

/** The actions of a widget. A hidden widget has none. */
export function actionWidget(widget: CanvasWidget, answered?: Answered): ActionWidget {
	return {
		room: widget.room,
		name: widget.name,
		revision: widget.revision,
		rev: widget.rev,
		actions: widget.state === 'shown' ? widget.actions : [],
		...(widget.for === undefined ? {} : { for: widget.for }),
		...(answered === undefined ? {} : { answered }),
	};
}

/** Sends one act through the host as a person, and gives the canvas result. */
type SendAct = (person: string, act: WidgetAct) => Promise<WidgetActResult>;

/** What the pad reads from the host, and how it asks for a redraw. */
export interface PadOptions {
	send: SendAct;
	/** The person who presses, or undefined while nobody is chosen. */
	person: () => string | undefined;
	/** True while the room of the widgets is stopped. */
	stopped: () => boolean;
	changed: () => void;
}

type Values = Record<string, string | number | boolean>;

/** How a note reads: dim for a state, info for an outcome, error for a refusal. */
export type Tone = 'dim' | 'info' | 'error';

/** One line of the actions of a widget. The drawing maps each row to one styled line. */
export type Row =
	| { type: 'note'; text: string; tone: Tone }
	| { type: 'button'; label: string; focused: boolean; done: boolean; blocked?: string }
	| { type: 'field'; label: string; value: string; active: boolean };

/** The key as the pad reads it: a subset of the key event of the terminal. */
export interface KeyInput {
	name: string;
	sequence: string;
	ctrl?: boolean;
	meta?: boolean;
}

/** The most characters of a text value. The canvas takes 200. */
const TEXT_MAX = 200;

/** What the person typed into one field of a form. */
interface Draft {
	field: WidgetField;
	/** The characters of a text or number field. */
	text: string;
	/** The value of a boolean field. */
	on: boolean;
	/** The chosen option of a choice field. */
	pick: number;
}

const draftOf = (field: WidgetField): Draft => ({ field, text: '', on: false, pick: 0 });

/** The printable characters of typed text: no escape, no control character, and no newline. */
const printable = (text: string): string => plain(text).replace(/[\n\t]/g, '');

const NUMBER_CHARS = /^[0-9.eE+-]*$/;

function range(field: WidgetField): string {
	if (field.type !== 'number') return '';
	const bounds = [
		...(field.min === undefined ? [] : [`min ${field.min}`]),
		...(field.max === undefined ? [] : [`max ${field.max}`]),
	];
	return bounds.length === 0 ? '' : ` (${bounds.join(', ')})`;
}

/** The text a field shows: the typed text with a cursor, a box, or the chosen option. */
function display(draft: Draft, active: boolean): string {
	const { field } = draft;
	if (field.type === 'boolean') return draft.on ? '[x]' : '[ ]';
	if (field.type === 'choice') return `‹ ${plain(field.options[draft.pick] ?? '')} ›`;
	return `${draft.text}${active ? '▌' : ''}`;
}

/** The value of a number field, or the reason that it has none. */
function numberValue(field: Extract<WidgetField, { type: 'number' }>, typed: string) {
	const label = plain(field.label);
	const text = typed.trim();
	const number = Number(text);
	if (text === '' || !Number.isFinite(number)) return { problem: `${label} needs a number.` };
	if (field.min !== undefined && number < field.min)
		return { problem: `${label} must be at least ${field.min}.` };
	if (field.max !== undefined && number > field.max)
		return { problem: `${label} must be at most ${field.max}.` };
	return { value: number };
}

/** The value of one field, or the reason that it has none. */
function draftValue(draft: Draft): { value: string | number | boolean } | { problem: string } {
	const { field } = draft;
	if (field.type === 'boolean') return { value: draft.on };
	if (field.type === 'choice') return { value: field.options[draft.pick] ?? '' };
	if (field.type === 'number') return numberValue(field, draft.text);
	return draft.text.trim() === ''
		? { problem: `${plain(field.label)} needs 1 to ${TEXT_MAX} characters.` }
		: { value: draft.text };
}

/** The values of a form, or the first problem and the field that has it. */
export function checkForm(
	drafts: readonly Draft[],
): { values: Values } | { problem: string; at: number } {
	const values: Values = {};
	for (const [at, draft] of drafts.entries()) {
		const one = draftValue(draft);
		if ('problem' in one) return { problem: one.problem, at };
		values[draft.field.name] = one.value;
	}
	return { values };
}

const SHIFTS: Record<string, number> = { left: -1, right: 1, space: 1 };

/** Type into a text or number field. A number field takes digits and the signs of a number. */
function type(draft: Draft, key: KeyInput): void {
	if (key.name === 'backspace') {
		draft.text = draft.text.slice(0, -1);
		return;
	}
	const added = printable(key.sequence);
	const fits = draft.field.type === 'text' || NUMBER_CHARS.test(added);
	if (fits && draft.text.length + added.length <= TEXT_MAX) draft.text += added;
}

/** Change one draft by one key: typing, a toggle, or a move to another option. */
function edit(draft: Draft, key: KeyInput): void {
	const { field } = draft;
	const shift = SHIFTS[key.name] ?? 0;
	if (field.type === 'boolean') draft.on = shift === 0 ? draft.on : !draft.on;
	else if (field.type === 'choice')
		draft.pick = (draft.pick + shift + field.options.length) % field.options.length;
	else type(draft, key);
}

/** What the open form holds. */
interface Form {
	name: string;
	revision: string;
	action: WidgetAction;
	drafts: Draft[];
	at: number;
}

/** What the person focuses: one action of one widget. */
interface Focus {
	name: string;
	action: string;
}

const answeredText = ({ seq, by }: Answered): string => `answered by ${plain(by)} in #${seq}`;

const MOVES: Record<string, number> = { up: -1, k: -1, down: 1, j: 1 };
/** Each hint is a few short lines, so it fits the narrowest side area. */
const LIST_HINT = ['Up/Down choose', 'Enter press   Esc leave'];
const FORM_HINT = ['Up/Down field  Enter send', 'Left/Right/Space change', 'Esc cancel'];

/** The act of a call that threw, with the person who sent it. A retry sends it again as it was. */
interface Failed {
	person: string;
	act: WidgetAct;
}

const sameValues = (left: Values | undefined, right: Values | undefined): boolean =>
	JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

/**
 * The state of the actions of the widgets that a side area draws: the focus, the open form,
 * the act of a failed call, and the last result of each widget. It draws nothing and reads
 * no terminal. `send` calls `canvas.act` as the person, and `changed` asks for a redraw.
 */
export class ActionPad {
	/** True while the keys of the person reach the pad. */
	active = false;
	private readonly options: PadOptions;
	private source: readonly ActionWidget[] = [];
	/** The newer revision that a stale result gave, by widget name. */
	private readonly newer = new Map<string, ActionWidget>();
	private focus: Focus | undefined;
	private form: Form | undefined;
	/** The note of each revision, by revision id. */
	private readonly notes = new Map<string, Row & { type: 'note' }>();
	/** The call that threw. A result or a refusal drops it, and so does a change of person. */
	private failed: Failed | undefined;
	private sending = false;

	constructor(options: PadOptions) {
		this.options = options;
	}

	private changed(): void {
		this.options.changed();
	}

	/** The widgets with actions, as the pad draws them. */
	private get widgets(): ActionWidget[] {
		return this.source
			.map((widget) => {
				const newer = this.newer.get(widget.name);
				return newer && newer.rev > widget.rev ? newer : widget;
			})
			.filter((widget) => widget.actions.length > 0);
	}

	private slots(): { widget: ActionWidget; action: WidgetAction }[] {
		return this.widgets.flatMap((widget) => widget.actions.map((action) => ({ widget, action })));
	}

	private chosen() {
		return this.slots().find(
			({ widget, action }) => widget.name === this.focus?.name && action.id === this.focus.action,
		);
	}

	/** Read the widgets that the host drew last. The focus, the form, and the notes follow the revisions. */
	sync(widgets: readonly ActionWidget[]): void {
		this.source = widgets;
		if (this.failed && this.failed.person !== this.options.person()) this.failed = undefined;
		for (const [name, newer] of this.newer)
			if (!widgets.some((widget) => widget.name === name && widget.rev < newer.rev))
				this.newer.delete(name);
		const revisions = new Set(this.widgets.map((widget) => widget.revision));
		if (this.form && !revisions.has(this.form.revision)) this.form = undefined;
		for (const revision of this.notes.keys())
			if (!revisions.has(revision)) this.notes.delete(revision);
		this.keepFocus();
	}

	/** Keep the focus on an action that exists, or move it to the first one. Without one, leave. */
	private keepFocus(): void {
		if (this.chosen()) return;
		const first = this.slots()[0];
		this.focus = first && { name: first.widget.name, action: first.action.id };
		if (!this.focus) this.leave();
	}

	/** Start taking keys. It returns false when no widget has an action. */
	enter(): boolean {
		if (this.slots().length === 0) return false;
		this.active = true;
		return true;
	}

	leave(): void {
		this.active = false;
		this.form = undefined;
	}

	/** The key hints for the state of the pad, one short line each. */
	hint(): readonly string[] {
		return this.form ? FORM_HINT : LIST_HINT;
	}

	private note(widget: ActionWidget, text: string, tone: Tone): void {
		this.notes.set(widget.revision, { type: 'note', text, tone });
	}

	/** The rows of one widget: its `for`, its answer, each action with its form, and the last result. */
	rows(name: string): Row[] {
		const widget = this.widgets.find((one) => one.name === name);
		if (!widget) return [];
		const rows: Row[] = [];
		if (widget.for !== undefined)
			rows.push({ type: 'note', text: `for ${plain(widget.for)}`, tone: 'dim' });
		if (widget.answered)
			rows.push({ type: 'note', text: answeredText(widget.answered), tone: 'info' });
		for (const action of widget.actions) rows.push(...this.actionRows(widget, action));
		const note = this.notes.get(widget.revision);
		return note ? [...rows, note] : rows;
	}

	/** The button of one action, and its form when it is open. */
	private actionRows(widget: ActionWidget, action: WidgetAction): Row[] {
		const focused =
			this.active && this.focus?.name === widget.name && this.focus.action === action.id;
		const done = action.once === true && widget.answered !== undefined;
		const blocked = done ? undefined : this.blocked(widget);
		const button: Row = {
			type: 'button',
			label: plain(action.label),
			focused,
			done,
			...(blocked === undefined ? {} : { blocked }),
		};
		const open = this.form?.revision === widget.revision && this.form.action.id === action.id;
		return open && this.form ? [button, ...this.fieldRows(this.form)] : [button];
	}

	/** Why the person cannot press the actions of a widget now, or undefined. */
	private blocked(widget: ActionWidget): string | undefined {
		if (this.options.stopped()) return 'room stopped';
		const person = this.options.person();
		return widget.for !== undefined && person !== undefined && widget.for !== person
			? `for ${plain(widget.for)} only`
			: undefined;
	}

	private fieldRows(form: Form): Row[] {
		return form.drafts.map((draft, at) => ({
			type: 'field',
			label: `${plain(draft.field.label)}${range(draft.field)}`,
			value: display(draft, at === form.at),
			active: at === form.at,
		}));
	}

	/** Route one key. It returns `leave` when the person leaves the pad. */
	key(key: KeyInput): 'leave' | undefined {
		if (key.ctrl || key.meta) return undefined;
		const result = this.form ? this.formKey(key) : this.listKey(key);
		this.changed();
		return result;
	}

	private listKey(key: KeyInput): 'leave' | undefined {
		const step = MOVES[key.name];
		if (step) this.move(step);
		else if (key.name === 'return' || key.name === 'space') void this.press();
		else if (key.name === 'escape' || key.name === 'q') return 'leave';
		return undefined;
	}

	private move(step: number): void {
		const slots = this.slots();
		const at = slots.findIndex(
			({ widget, action }) => widget.name === this.focus?.name && action.id === this.focus.action,
		);
		const next = slots[Math.max(0, Math.min(slots.length - 1, at + step))];
		if (next) this.focus = { name: next.widget.name, action: next.action.id };
	}

	private formKey(key: KeyInput): undefined {
		const form = this.form;
		const draft = form?.drafts[form.at];
		if (!form || !draft) return undefined;
		const step = key.name === 'up' ? -1 : key.name === 'down' || key.name === 'tab' ? 1 : 0;
		if (key.name === 'escape') this.form = undefined;
		else if (key.name === 'return') void this.submit();
		else if (step !== 0) form.at = Math.max(0, Math.min(form.drafts.length - 1, form.at + step));
		else edit(draft, key);
		return undefined;
	}

	/** Press the chosen action: open its form, or send it. */
	async press(): Promise<void> {
		const slot = this.chosen();
		if (!slot || this.sending) return;
		const { widget, action } = slot;
		const blocked = this.blocked(widget);
		if (blocked !== undefined && !(action.once === true && widget.answered)) {
			this.note(widget, `Not available: ${blocked}.`, 'info');
		} else if (action.once === true && widget.answered) {
			this.note(widget, `This was ${answeredText(widget.answered)}.`, 'info');
		} else if (action.fields && action.fields.length > 0) {
			const drafts = action.fields.map(draftOf);
			this.form = { name: widget.name, revision: widget.revision, action, drafts, at: 0 };
		} else await this.call(widget, action, undefined);
	}

	/** Send the open form, or show the first field that has a problem. */
	async submit(): Promise<void> {
		const form = this.form;
		const widget = this.widgets.find((one) => one.revision === form?.revision);
		if (!form || !widget) return;
		const checked = checkForm(form.drafts);
		if ('problem' in checked) {
			form.at = checked.at;
			this.note(widget, checked.problem, 'error');
			this.changed();
			return;
		}
		await this.call(widget, form.action, checked.values);
	}

	/**
	 * The act of a call. The act of a failed call comes again as it was, for the same person,
	 * room, widget, action, and values. Any other call makes a new act with a new press token.
	 */
	private actOf(person: string, widget: ActionWidget, action: WidgetAction, values?: Values) {
		const before = this.failed;
		if (
			before?.person === person &&
			before.act.room === widget.room &&
			before.act.widget === widget.name &&
			before.act.action === action.id &&
			sameValues(before.act.values, values)
		)
			return before.act;
		return {
			room: widget.room,
			widget: widget.name,
			revision: widget.revision,
			action: action.id,
			...(values ? { values } : {}),
			press: crypto.randomUUID(),
		};
	}

	/**
	 * Send one press. The act is saved before the call and stays until the call gives a result,
	 * so a retry after a failure sends that act again, as the same person. A refusal never
	 * lands, so it drops the act and shows its reason alone.
	 */
	private async call(widget: ActionWidget, action: WidgetAction, values?: Values): Promise<void> {
		const person = this.options.person();
		if (this.sending) return;
		if (person === undefined) {
			this.note(widget, 'Pick a person first: /user <name>.', 'error');
			return;
		}
		this.sending = true;
		const act = this.actOf(person, widget, action, values);
		this.failed = { person, act };
		this.note(widget, 'Sending.', 'dim');
		this.changed();
		try {
			const result = await this.options.send(person, act);
			this.failed = undefined;
			this.settle(widget, result);
		} catch (error) {
			this.fail(widget, error);
		} finally {
			this.sending = false;
			this.changed();
		}
	}

	private fail(widget: ActionWidget, error: unknown): void {
		const reason = plain(error instanceof Error ? error.message : String(error));
		const refused = error instanceof AmbionError && error.code === 'refused';
		if (refused) this.failed = undefined;
		this.note(widget, refused ? reason : `${reason} Press again to retry.`, 'error');
	}

	private settle(widget: ActionWidget, result: WidgetActResult): void {
		this.form = undefined;
		if (result.kind === 'sent') this.note(widget, `Sent as #${result.seq}.`, 'info');
		else if (result.kind === 'answered')
			this.note(widget, `Already answered in #${result.seq}.`, 'info');
		else {
			const newer = actionWidget(result.widget);
			this.newer.set(widget.name, newer);
			this.note(newer, 'This widget changed. Press again.', 'info');
		}
	}
}
