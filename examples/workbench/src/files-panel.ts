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
import { bytes, describe, FileView } from './file-view.ts';
import type { FileContent, FileEntry, TableView } from './workbench.ts';

export const LIST_ROWS = 8;
const HINT = 'Type to search   Up/Down choose   PgUp/PgDn scroll   Ctrl+Y copy   Esc close';
const TABLE_HINT = 'Left/Right table   ';

/** The tab line above a table: every table, with the shown one marked. */
function tabsText(tables: readonly TableView[], shown: number): StyledText {
	return new StyledText(
		tables.flatMap((table, at) => [
			at === shown
				? bg(palette.selected)(fg(palette.accent)(` ${table.name} ${table.count} `))
				: fg(palette.muted)(` ${table.name} ${table.count} `),
			fg(palette.muted)(' '),
		]),
	);
}

/** The box of a side panel: beside the conversation, and hidden until it opens. */
export function sidePanel(renderer: CliRenderer): BoxRenderable {
	return new BoxRenderable(renderer, {
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
}

/** The rows to show: a window of the matches that keeps the chosen row in view. */
export function windowStart(index: number, count: number): number {
	return Math.max(0, Math.min(index - Math.floor(LIST_ROWS / 2), count - LIST_ROWS));
}

/** The files panel: a search box, the matching files, and the chosen file beside the conversation. */
export class FilesPanel {
	readonly root: BoxRenderable;
	private readonly renderer: CliRenderer;
	private readonly search: TextRenderable;
	private readonly list: TextRenderable;
	private readonly title: TextRenderable;
	private readonly view: FileView;
	private readonly tabs: TextRenderable;
	private readonly scroll: ScrollBoxRenderable;
	private readonly hint: TextRenderable;
	private shown: string | undefined;
	private tables = false;
	private flashing: ReturnType<typeof setTimeout> | undefined;

	constructor(renderer: CliRenderer) {
		this.renderer = renderer;
		this.root = sidePanel(renderer);
		this.search = new TextRenderable(renderer, { content: '', flexShrink: 0, wrapMode: 'none' });
		this.list = new TextRenderable(renderer, {
			content: '',
			flexShrink: 0,
			height: LIST_ROWS,
			wrapMode: 'none',
		});
		this.title = new TextRenderable(renderer, { content: '', flexShrink: 0, wrapMode: 'none' });
		this.view = new FileView(renderer, () => this.flash('Cannot decode this picture.'));
		this.tabs = new TextRenderable(renderer, {
			content: '',
			flexShrink: 0,
			wrapMode: 'none',
			visible: false,
		});
		this.scroll = new ScrollBoxRenderable(renderer, {
			flexGrow: 1,
			scrollY: true,
			backgroundColor: palette.panel,
			scrollbarOptions: {
				trackOptions: { backgroundColor: palette.bg, foregroundColor: palette.line },
			},
		});
		// The padding of the view keeps the text clear of the scrollbar.
		this.scroll.add(this.view.root);
		this.hint = new TextRenderable(renderer, { content: '', flexShrink: 0, wrapMode: 'word' });
		for (const part of [this.search, this.list, this.title, this.tabs, this.scroll, this.hint])
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
		this.tables = (browser.file?.tables?.length ?? 0) > 1;
		if (!this.flashing) this.hint.content = new StyledText([fg(palette.dim)(this.hintText())]);
	}

	private rows(browser: FileBrowser): StyledText {
		const matches = browser.matches;
		if (matches.length === 0) return new StyledText([fg(palette.muted)('No file matches.')]);
		const start = windowStart(browser.index, matches.length);
		const nameOf = (file: FileEntry) => file.label ?? file.path;
		const width = Math.max(...matches.map((file) => nameOf(file).length));
		const chunks = matches.slice(start, start + LIST_ROWS).flatMap((file, offset) => {
			const chosen = start + offset === browser.index;
			const line = `${chosen ? '▸ ' : '  '}${nameOf(file).padEnd(width)}  ${file.kind ?? bytes(file.size)}`;
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
		this.tabs.visible = false;
		if (browser.problem || !file) {
			const text = browser.problem ?? 'Choose a file to read it.';
			this.title.content = new StyledText([fg(browser.problem ? palette.red : palette.dim)(text)]);
			this.view.showText('');
			this.shown = undefined;
			return;
		}
		this.title.content = new StyledText([
			fg(palette.accent)(file.path),
			fg(palette.dim)(`   ${describe(file)}`),
		]);
		this.showFile(file, browser.table);
		const key = `${file.path}:${browser.table}`;
		if (this.shown !== key) this.scroll.scrollTop = 0;
		this.shown = key;
	}

	/** The one view a file takes: a picture, a table, markdown, or plain text. */
	private showFile(file: FileContent, at: number): void {
		const table = file.tables?.[at];
		if (table && file.tables && !file.image) {
			this.tabs.visible = true;
			this.tabs.content = tabsText(file.tables, at);
		}
		this.view.show(file, at);
	}

	private hintText(): string {
		return this.tables ? `${TABLE_HINT}${HINT}` : HINT;
	}

	/** Replace the key hints with a short message, then bring the hints back. */
	flash(message: string): void {
		this.hint.content = new StyledText([fg(palette.summary)(message)]);
		clearTimeout(this.flashing);
		this.flashing = setTimeout(() => {
			this.flashing = undefined;
			this.hint.content = new StyledText([fg(palette.dim)(this.hintText())]);
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
