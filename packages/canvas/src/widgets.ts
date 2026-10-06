/**
 * What `show` and `hide` do. A function here checks a call against the rows
 * and the widget revisions, and asks the port to write. The port belongs to the
 * canvas, so the checks and the lifecycle read one set of rows.
 */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isName } from '@ambionframework/ambion/names';
import { assertActions } from './actions.ts';
import type { Answer } from './acts.ts';
import type { Caller } from './breakout.ts';
import { refuse } from './cast.ts';
import { assertLine, type BasePort, NAME_LIMIT } from './port.ts';
import type { CanvasWidget, WidgetAction, WidgetKind, WidgetSource } from './store.ts';

/** The most characters of a widget title. */
export const WIDGET_TITLE_LIMIT = 80;
/** The most characters of one text of a source. */
const SOURCE_LIMIT = 200;

const SOURCE_TYPES: readonly WidgetSource['type'][] = ['process', 'file', 'snapshot'];

/** What the widget tools read and write on a canvas. */
export interface WidgetPort extends BasePort {
	readonly kinds: readonly WidgetKind[];
	/** The current revision of each widget of a room, hidden ones included. */
	widgets(room: string): readonly CanvasWidget[];
	/** The current revision of a widget, hidden ones included. */
	current(room: string, name: string): CanvasWidget | undefined;
	/** The act that answers a revision, or undefined. */
	answer(room: string, revision: string): Answer | undefined;
	/** Writes one revision, then makes it current and tells the listeners. */
	append(widget: CanvasWidget, operation: 'show' | 'hide'): Promise<void>;
}

export interface ShowParams {
	readonly name: string;
	readonly kind: string;
	readonly source?: WidgetSource;
	readonly title?: string;
	readonly actions?: readonly WidgetAction[];
	readonly for?: string;
}

export interface WidgetResult {
	readonly room: string;
	readonly name: string;
	readonly revision: string;
	readonly rev: number;
	readonly state: 'shown' | 'hidden';
	/** False when the call found the widget as it was and wrote nothing. */
	readonly changed: boolean;
}

/** Refuses a catalog that the host cannot draw from. It runs at `openCanvas`. */
export function assertCatalog(kinds: readonly WidgetKind[]): void {
	const seen = new Set<string>();
	for (const kind of kinds) {
		if (!isName(kind.name)) throw refuse(`"${kind.name}" is not a widget kind name.`);
		if (seen.has(kind.name)) throw refuse(`The widget kinds hold "${kind.name}" twice.`);
		seen.add(kind.name);
		assertLine(`The description of the kind "${kind.name}"`, kind.description, 200);
		for (const type of kind.sources)
			if (!SOURCE_TYPES.includes(type))
				throw refuse(`The kind "${kind.name}" names the unknown source type "${String(type)}".`);
	}
}

/** The text of a source for the guidance and the reminder. */
export function sourceText(source: WidgetSource): string {
	switch (source.type) {
		case 'process':
			return `process ${source.handle} ${source.path}`;
		case 'file':
			return `file ${source.path}`;
		case 'snapshot':
			return `snapshot ${source.ref}`;
	}
}

function assertSource(source: WidgetSource): void {
	switch (source.type) {
		case 'process':
			assertLine('The handle of the source', source.handle, SOURCE_LIMIT);
			assertLine('The path of the source', source.path, SOURCE_LIMIT);
			if (!source.path.startsWith('/'))
				throw refuse('The path of a process source starts with "/".');
			return;
		case 'file':
			assertLine('The path of the source', source.path, SOURCE_LIMIT);
			return;
		case 'snapshot':
			assertLine('The ref of the source', source.ref, SOURCE_LIMIT);
	}
}

function kindOf(kinds: readonly WidgetKind[], params: ShowParams): WidgetKind {
	const kind = kinds.find((one) => one.name === params.kind);
	if (kind === undefined)
		throw refuse(
			`"${params.kind}" is not a widget kind. The kinds are: ${kinds.map((one) => one.name).join(', ')}.`,
		);
	return kind;
}

function assertSourceOf(kind: WidgetKind, params: ShowParams): void {
	if (params.source === undefined) {
		if (kind.sources.length > 0)
			throw refuse(`The kind "${kind.name}" needs a source of type ${kind.sources.join(' or ')}.`);
		return;
	}
	if (kind.sources.length === 0) throw refuse(`The kind "${kind.name}" takes no source.`);
	if (!kind.sources.includes(params.source.type))
		throw refuse(`The kind "${kind.name}" takes a source of type ${kind.sources.join(' or ')}.`);
	assertSource(params.source);
}

function assertShow(kinds: readonly WidgetKind[], params: ShowParams): void {
	assertName(params.name);
	if (params.title !== undefined) assertLine('The title', params.title, WIDGET_TITLE_LIMIT);
	const kind = kindOf(kinds, params);
	assertSourceOf(kind, params);
	assertActions(kind, params.actions ?? [], params.for);
}

function assertName(name: string): void {
	if (!isName(name))
		throw refuse(
			`"${name}" is not a widget name. Use lowercase letters, digits, and hyphens, and start with a letter.`,
		);
	if (name.length > NAME_LIMIT)
		throw refuse(
			`"${name}" has ${name.length} characters. A widget name has at most ${NAME_LIMIT}.`,
		);
}

/** The refusal of a call from a room that the canvas does not hold, or that is archived. */
function assertRoom(port: WidgetPort, caller: Caller): void {
	const row = port.row(caller.room);
	if (row === undefined) throw refuse(`The room "${caller.room}" is not on the canvas.`);
	if (row.state === 'archived') throw refuse(`The room "${caller.room}" is archived.`);
}

const sameSource = (a: WidgetSource | undefined, b: WidgetSource | undefined): boolean =>
	JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The content of a revision is its kind, its source, its title, its actions, and its person. */
function sameContent(widget: CanvasWidget, params: ShowParams): boolean {
	return (
		widget.kind === params.kind &&
		widget.title === params.title &&
		widget.for === params.for &&
		sameSource(widget.source, params.source) &&
		isDeepStrictEqual(widget.actions, params.actions ?? [])
	);
}

const resultOf = (widget: CanvasWidget, changed: boolean): WidgetResult => ({
	room: widget.room,
	name: widget.name,
	revision: widget.revision,
	rev: widget.rev,
	state: widget.state,
	changed,
});

/** The next revision of a widget, as the caller shows it. */
function revisionOf(
	caller: Caller,
	params: ShowParams,
	current: CanvasWidget | undefined,
): CanvasWidget {
	return {
		room: caller.room,
		name: params.name,
		revision: randomUUID(),
		rev: (current?.rev ?? 0) + 1,
		state: 'shown',
		kind: params.kind,
		...(params.source === undefined ? {} : { source: params.source }),
		...(params.title === undefined ? {} : { title: params.title }),
		author: caller.agent,
		actions: params.actions ?? [],
		...(params.for === undefined ? {} : { for: params.for }),
	};
}

/** Shows a widget, or changes its content. Equal content of a shown widget writes nothing. */
export async function showWidget(
	port: WidgetPort,
	caller: Caller,
	params: ShowParams,
): Promise<WidgetResult> {
	assertShow(port.kinds, params);
	return port.serial(caller.room, async () => {
		port.assertReady();
		assertRoom(port, caller);
		const current = port.current(caller.room, params.name);
		if (current?.state === 'shown' && sameContent(current, params)) return resultOf(current, false);
		const widget = revisionOf(caller, params, current);
		await port.append(widget, 'show');
		return resultOf(widget, true);
	});
}

/** Hides a widget. A hidden widget changes nothing, and an unknown name is a refusal. */
export async function hideWidget(
	port: WidgetPort,
	caller: Caller,
	params: { readonly name: string },
): Promise<WidgetResult> {
	return port.serial(caller.room, async () => {
		port.assertReady();
		assertRoom(port, caller);
		const current = port.current(caller.room, params.name);
		if (current === undefined)
			throw refuse(`The room "${caller.room}" has no widget "${params.name}".`);
		if (current.state === 'hidden') return resultOf(current, false);
		const widget: CanvasWidget = {
			...current,
			revision: randomUUID(),
			rev: current.rev + 1,
			state: 'hidden',
			author: caller.agent,
		};
		await port.append(widget, 'hide');
		return resultOf(widget, true);
	});
}
