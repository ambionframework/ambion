import {
	BoxRenderable,
	bg,
	bold,
	type CliRenderer,
	fg,
	type PasteEvent,
	StyledText,
	type TextareaOptions,
	TextareaRenderable,
	TextRenderable,
} from '@opentui/core';
import { pastedImagePath } from './attachments.ts';
import { tui as palette } from './brand.ts';
import type { Suggestion } from './commands.ts';

/**
 * A textarea that offers a pasted picture path to `onPastedLine` before
 * inserting it as text. Returning `true` consumes the paste: the path never
 * lands in the message body, because the composer offered `/attach` instead.
 */
class PasteAwareTextarea extends TextareaRenderable {
	private readonly onPastedLine?: (line: string) => boolean;

	constructor(
		ctx: CliRenderer,
		options: TextareaOptions & { onPastedLine?: (line: string) => boolean },
	) {
		super(ctx, options);
		this.onPastedLine = options.onPastedLine;
	}

	override handlePaste(event: PasteEvent): void {
		const line = new TextDecoder().decode(event.bytes);
		if (this.onPastedLine?.(line)) return;
		super.handlePaste(event);
	}
}

/** The palette's title, by what its rows complete to. */
const TITLES = {
	command: 'Commands',
	room: 'Rooms',
	person: 'People',
	file: 'Files',
	say: 'Says that wait',
} as const;

const MAX_INPUT_LINES = 6;
const MAX_PALETTE_ROWS = 6;

export interface ComposerEvents {
	/** The person pressed Enter. */
	submit: () => void;
	/** The text changed. */
	change: () => void;
}

/**
 * The composer. It holds the room chip and a multi-line input, a palette of
 * commands or rooms above them, and a status line below.
 */
export class Composer {
	readonly root: BoxRenderable;
	readonly input: PasteAwareTextarea;
	private readonly chip: TextRenderable;
	private readonly frame: BoxRenderable;
	private readonly paletteBox: BoxRenderable;
	private readonly paletteText: TextRenderable;
	private readonly status: TextRenderable;
	private readonly hints: TextRenderable;
	private readonly events: ComposerEvents;

	constructor(renderer: CliRenderer, events: ComposerEvents) {
		this.events = events;
		this.root = new BoxRenderable(renderer, { flexDirection: 'column', flexShrink: 0 });
		this.paletteText = new TextRenderable(renderer, { content: '' });
		this.paletteBox = new BoxRenderable(renderer, {
			border: true,
			borderColor: palette.line,
			backgroundColor: palette.panel,
			paddingLeft: 1,
			visible: false,
		});
		this.paletteBox.add(this.paletteText);
		this.chip = new TextRenderable(renderer, { content: '', flexShrink: 0 });
		this.input = new PasteAwareTextarea(renderer, {
			flexGrow: 1,
			height: 1,
			placeholder: 'Message the room, or type / for commands',
			placeholderColor: palette.dim,
			textColor: palette.text,
			focusedTextColor: palette.text,
			backgroundColor: palette.panel,
			focusedBackgroundColor: palette.panel,
			// Enter sends. Ctrl+J, Alt+Enter, and Shift+Enter add a line.
			keyBindings: [
				{ name: 'return', action: 'submit' },
				{ name: 'linefeed', action: 'newline' },
				{ name: 'return', shift: true, action: 'newline' },
				{ name: 'return', meta: true, action: 'newline' },
			],
			onSubmit: () => events.submit(),
			onContentChange: () => {
				this.resize();
				events.change();
			},
			onPastedLine: (line) => this.suggestAttach(line),
		});
		this.frame = new BoxRenderable(renderer, {
			flexDirection: 'row',
			gap: 1,
			border: true,
			borderColor: palette.line,
			focusedBorderColor: palette.accent,
			backgroundColor: palette.panel,
			paddingLeft: 1,
		});
		this.frame.add(this.chip);
		this.frame.add(this.input);
		this.status = new TextRenderable(renderer, { content: '', flexGrow: 1 });
		this.hints = new TextRenderable(renderer, { content: '', flexShrink: 0 });
		const row = new BoxRenderable(renderer, { flexDirection: 'row', gap: 2, paddingLeft: 1 });
		row.add(this.status);
		row.add(this.hints);
		this.root.add(this.paletteBox);
		this.root.add(this.frame);
		this.root.add(row);
	}

	get text(): string {
		return this.input.plainText;
	}

	/** Replace the text. The input reports typed edits only, so this reports its own change. */
	setText(text: string): void {
		this.input.setText(text);
		this.input.gotoBufferEnd();
		this.resize();
		this.events.change();
	}

	/**
	 * A paste into an empty composer that names one picture, absolute or under
	 * `~/`, fills `/attach` instead of the raw path. True consumes the paste;
	 * false lets a paste into an already-started message land as typed.
	 */
	private suggestAttach(line: string): boolean {
		if (this.text.trim() !== '') return false;
		const path = pastedImagePath(line);
		if (path === undefined) return false;
		this.setText(`/attach ${path}`);
		return true;
	}

	focus(): void {
		this.input.focus();
		this.frame.borderColor = palette.accent;
	}

	blur(): void {
		this.input.blur();
		this.frame.borderColor = palette.line;
	}

	/** Show what the composer sends to, such as a room. A dot means the room is working. */
	setChip(label: string, working: boolean): void {
		const dot = working ? fg(palette.coral)('● ') : fg(palette.dim)('');
		this.chip.content = new StyledText([dot, bold(fg(palette.accent)(`${label} ›`))]);
	}

	setPlaceholder(text: string): void {
		this.input.placeholder = text;
	}

	setStatus(content: StyledText): void {
		this.status.content = content;
	}

	setHints(text: string): void {
		this.hints.content = new StyledText([fg(palette.dim)(text)]);
	}

	/** Show the palette rows, with one picked. An empty list hides the palette. */
	setPalette(rows: readonly Suggestion[], pick: number): void {
		this.paletteBox.visible = rows.length > 0;
		if (rows.length === 0) return;
		const first = Math.max(
			0,
			Math.min(pick - (MAX_PALETTE_ROWS - 1), rows.length - MAX_PALETTE_ROWS),
		);
		const shown = rows.slice(first, first + MAX_PALETTE_ROWS);
		const width = Math.max(...rows.map((row) => row.label.length)) + 2;
		this.paletteBox.title = TITLES[rows[0]?.kind ?? 'command'];
		this.paletteBox.titleColor = palette.muted;
		this.paletteBox.height = shown.length + 2;
		const chunks = shown.flatMap((row, index) => {
			const chosen = first + index === pick;
			const fill = chosen ? palette.selected : palette.panel;
			const label = row.label.padEnd(width);
			const line = [
				bg(fill)(fg(chosen ? palette.text : palette.accent)(label)),
				bg(fill)(fg(palette.muted)(row.detail)),
			];
			return index < shown.length - 1
				? [...line, bg(palette.panel)(fg(palette.muted)('\n'))]
				: line;
		});
		this.paletteText.content = new StyledText(chunks);
	}

	/** Grow the input with its text, up to a few lines. */
	private resize(): void {
		// virtualLineCount lags the edit until the next layout, so also count the lines typed.
		const lines = Math.max(this.input.lineCount, this.input.virtualLineCount);
		this.input.height = Math.max(1, Math.min(MAX_INPUT_LINES, lines));
	}
}
