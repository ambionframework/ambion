import {
	BoxRenderable,
	bg,
	type CliRenderer,
	fg,
	ScrollBoxRenderable,
	StyledText,
	TextRenderable,
} from '@opentui/core';
import { tui as palette } from './brand.ts';
import type { FileBrowser } from './browser.ts';

const LIST_ROWS = 8;
const HINT = 'Type to search   Up/Down choose   PgUp/PgDn scroll   Ctrl+Y copy   Esc close';

const bytes = (size: number): string =>
	size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`;

/** The rows to show: a window of the matches that keeps the chosen row in view. */
function windowStart(index: number, count: number): number {
	return Math.max(0, Math.min(index - Math.floor(LIST_ROWS / 2), count - LIST_ROWS));
}

/** The files panel: a search box, the matching files, and the chosen file beside the conversation. */
export class FilesPanel {
	readonly root: BoxRenderable;
	private readonly renderer: CliRenderer;
	private readonly search: TextRenderable;
	private readonly list: TextRenderable;
	private readonly title: TextRenderable;
	private readonly body: TextRenderable;
	private readonly scroll: ScrollBoxRenderable;
	private readonly hint: TextRenderable;
	private shown: string | undefined;
	private flashing: ReturnType<typeof setTimeout> | undefined;

	constructor(renderer: CliRenderer) {
		this.renderer = renderer;
		this.root = new BoxRenderable(renderer, {
			flexDirection: 'column',
			width: '55%',
			flexShrink: 0,
			minWidth: 40,
			border: true,
			borderColor: palette.line,
			backgroundColor: palette.panel,
			paddingLeft: 1,
			paddingRight: 1,
			visible: false,
		});
		this.search = new TextRenderable(renderer, { content: '', flexShrink: 0, wrapMode: 'none' });
		this.list = new TextRenderable(renderer, {
			content: '',
			flexShrink: 0,
			height: LIST_ROWS,
			wrapMode: 'none',
		});
		this.title = new TextRenderable(renderer, { content: '', flexShrink: 0, wrapMode: 'none' });
		this.body = new TextRenderable(renderer, { content: '', wrapMode: 'word', width: '100%' });
		this.scroll = new ScrollBoxRenderable(renderer, {
			flexGrow: 1,
			scrollY: true,
			backgroundColor: palette.panel,
			scrollbarOptions: {
				trackOptions: { backgroundColor: palette.bg, foregroundColor: palette.line },
			},
		});
		// The padding keeps the text clear of the scrollbar.
		const padded = new BoxRenderable(renderer, { paddingRight: 2, width: '100%' });
		padded.add(this.body);
		this.scroll.add(padded);
		this.hint = new TextRenderable(renderer, { content: '', flexShrink: 0, wrapMode: 'word' });
		for (const part of [this.search, this.list, this.title, this.scroll, this.hint])
			this.root.add(part);
	}

	/** Give the panel the whole width, or a share of it beside the conversation. */
	fill(whole: boolean): void {
		this.root.width = whole ? '100%' : '55%';
	}

	/** Draw the browser's state. The preview scrolls back to the top when the file changes. */
	draw(browser: FileBrowser): void {
		this.root.visible = browser.open;
		if (!browser.open) return;
		const matches = browser.matches;
		const count = `${matches.length} of ${browser.total}`;
		this.search.content = new StyledText([
			fg(palette.accent)('Files › '),
			fg(palette.text)(browser.query),
			fg(palette.accent)('▌'),
			fg(palette.dim)(`   ${count}`),
		]);
		this.list.content = this.rows(browser);
		this.drawPreview(browser);
		if (!this.flashing) this.hint.content = new StyledText([fg(palette.dim)(HINT)]);
	}

	private rows(browser: FileBrowser): StyledText {
		const matches = browser.matches;
		if (matches.length === 0) return new StyledText([fg(palette.muted)('No file matches.')]);
		const start = windowStart(browser.index, matches.length);
		const width = Math.max(...matches.map((file) => file.path.length));
		const chunks = matches.slice(start, start + LIST_ROWS).flatMap((file, offset) => {
			const chosen = start + offset === browser.index;
			const line = `${chosen ? '▸ ' : '  '}${file.path.padEnd(width)}  ${bytes(file.size)}`;
			const tail = offset === LIST_ROWS - 1 ? '' : '\n';
			return [
				chosen ? bg(palette.selected)(fg(palette.accent)(line)) : fg(palette.muted)(line),
				fg(palette.muted)(tail),
			];
		});
		return new StyledText(chunks);
	}

	private drawPreview(browser: FileBrowser): void {
		const file = browser.file;
		if (browser.problem) {
			this.title.content = new StyledText([fg(palette.red)(browser.problem)]);
			this.body.content = new StyledText([fg(palette.text)('')]);
			this.shown = undefined;
			return;
		}
		if (!file) {
			this.title.content = new StyledText([fg(palette.dim)('Choose a file to read it.')]);
			this.body.content = new StyledText([fg(palette.text)('')]);
			this.shown = undefined;
			return;
		}
		const lines = file.text.split('\n').length;
		const size = bytes(new TextEncoder().encode(file.text).length);
		const meta = `${size}, ${lines} ${lines === 1 ? 'line' : 'lines'}${file.truncated ? ', truncated' : ''}`;
		this.title.content = new StyledText([
			fg(palette.accent)(file.path),
			fg(palette.dim)(`   ${meta}`),
		]);
		this.body.content = new StyledText([fg(palette.text)(file.text)]);
		if (this.shown !== file.path) this.scroll.scrollTop = 0;
		this.shown = file.path;
	}

	/** Replace the key hints with a short message, then bring the hints back. */
	flash(message: string): void {
		this.hint.content = new StyledText([fg(palette.summary)(message)]);
		clearTimeout(this.flashing);
		this.flashing = setTimeout(() => {
			this.flashing = undefined;
			this.hint.content = new StyledText([fg(palette.dim)(HINT)]);
		}, 1_800);
	}

	scrollBy(lines: number): void {
		this.scroll.scrollBy(lines);
	}

	get page(): number {
		return Math.max(4, this.scroll.height - 1);
	}

	/** Copy text to the clipboard through the terminal. Return false when it cannot. */
	copy(text: string): boolean {
		return this.renderer.isOsc52Supported() && this.renderer.copyToClipboardOSC52(text);
	}
}
