import type { CanvasWidget, WidgetKind } from '@ambionframework/canvas';
import type { FileContent } from './files.ts';

/** The kinds the host draws. Each one takes a file of the workspace. */
export const PIN_KINDS = [
	{
		name: 'markdown',
		description: 'A Markdown file of the workspace, drawn with headings, lists, and code.',
		sources: ['file'],
	},
	{
		name: 'table',
		description: 'The tables of a SQLite database file of the workspace.',
		sources: ['file'],
	},
	{
		name: 'image',
		description: 'A picture file of the workspace: PNG, JPEG, GIF, or WebP.',
		sources: ['file'],
	},
] as const satisfies readonly WidgetKind[];

/** The kind of a pinned file. */
type PinKind = (typeof PIN_KINDS)[number]['name'];

/** The most pins that the side area draws for one room. */
const MAX_PINS = 4;

/** One shown widget of a room, with the file it names read as its author. */
export interface Pin {
	name: string;
	title: string | undefined;
	kind: PinKind;
	author: string;
	path: string;
	/** The file, once it reads. */
	file?: FileContent;
	/** Why the file did not read, or why it does not fit the kind. */
	problem?: string;
}

const isPinKind = (kind: string): kind is PinKind => PIN_KINDS.some((one) => one.name === kind);

/** The shown widgets of the catalog that name a file, in the order of the canvas, `MAX_PINS` at most. */
export function shownFiles(widgets: readonly CanvasWidget[]): CanvasWidget[] {
	return widgets
		.filter(
			(widget) =>
				widget.state === 'shown' && widget.source?.type === 'file' && isPinKind(widget.kind),
		)
		.slice(0, MAX_PINS);
}

/** The words the side area shows over a pin: the title, or the name. */
export const pinLabel = (pin: Pick<Pin, 'name' | 'title'>): string => pin.title ?? pin.name;

const ESC = 0x1b;
const BEL = 0x07;

/** The index of the first byte at or after `from` whose code is `stops`, or the length of the text. */
function find(text: string, from: number, stops: (code: number) => boolean): number {
	let at = from;
	while (at < text.length && !stops(text.charCodeAt(at))) at += 1;
	return at;
}

/** The index after the escape sequence that starts at `at`, where `text[at]` is ESC. */
function afterEscape(text: string, at: number): number {
	const next = text[at + 1];
	// A control sequence ends at one byte from 0x40 to 0x7e.
	if (next === '[') return find(text, at + 2, (code) => code >= 0x40 && code <= 0x7e) + 1;
	if (next !== ']') return at + 2;
	// A string sequence ends at BEL or at ESC and a backslash.
	const end = find(text, at + 2, (code) => code === BEL || code === ESC);
	return text.charCodeAt(end) === ESC ? end + 2 : end + 1;
}

/** Whether a code is a control character that text may keep: a newline or a tab. */
const keeps = (code: number): boolean =>
	code === 0x0a || code === 0x09 || code > 0x9f || (code >= 0x20 && code < 0x7f);

/** The text with every terminal escape sequence and every control character dropped, except newline and tab. */
export function plain(text: string): string {
	let kept = '';
	for (let at = 0; at < text.length;) {
		const code = text.charCodeAt(at);
		if (code === ESC) at = afterEscape(text, at);
		else {
			if (keeps(code)) kept += text[at];
			at += 1;
		}
	}
	return kept;
}
