import {
	BoxRenderable,
	type CliRenderer,
	fg,
	ImageRenderable,
	MarkdownRenderable,
	StyledText,
	SyntaxStyle,
	TextRenderable,
} from '@opentui/core';
import { tui as palette } from './brand.ts';
import type { FileContent, ImageContent, TableView } from './workbench.ts';

const MAX_COLUMN = 40;
/** Terminal rows the picture preview takes. A cell is roughly twice as tall as wide. */
const IMAGE_ROWS = 24;

export const bytes = (size: number): string =>
	size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`;

/** How markdown looks on the panel: headings in the accent, code in the summary color. */
function markdownStyle(): SyntaxStyle {
	return SyntaxStyle.fromStyles({
		default: { fg: palette.text },
		'markup.heading': { fg: palette.accent, bold: true },
		'markup.heading.1': { fg: palette.accent, bold: true, underline: true },
		'markup.strong': { fg: palette.text, bold: true },
		'markup.italic': { fg: palette.text, italic: true },
		'markup.strikethrough': { fg: palette.dim },
		'markup.raw': { fg: palette.summary },
		'markup.raw.block': { fg: palette.summary },
		'markup.link': { fg: palette.accent, underline: true },
		'markup.link.label': { fg: palette.accent, underline: true },
		'markup.link.url': { fg: palette.dim },
		'markup.list': { fg: palette.accent },
		'markup.quote': { fg: palette.muted, italic: true },
		conceal: { fg: palette.dim },
	});
}

/** The size and shape of one file, for the title. */
export function describe(file: FileContent): string {
	if (file.tables) return `${file.tables.length} ${file.tables.length === 1 ? 'table' : 'tables'}`;
	if (file.image) return `${bytes(file.image.data.length)}, ${file.image.mimeType}`;
	const lines = file.text.split('\n').length;
	const size = bytes(new TextEncoder().encode(file.text).length);
	return `${size}, ${lines} ${lines === 1 ? 'line' : 'lines'}${file.truncated ? ', truncated' : ''}`;
}

/** One table as aligned columns: a header, a rule, and the rows. */
function tableText(table: TableView): StyledText {
	const widths = table.columns.map((name, at) =>
		Math.min(MAX_COLUMN, Math.max(name.length, ...table.rows.map((row) => (row[at] ?? '').length))),
	);
	const line = (cells: readonly string[]) =>
		cells.map((text, at) => text.slice(0, MAX_COLUMN).padEnd(widths[at] ?? 0)).join('  ');
	const rule = widths.map((width) => '─'.repeat(width)).join('  ');
	const shown = table.rows.length;
	const more =
		table.count > shown ? [fg(palette.dim)(`\nFirst ${shown} of ${table.count} rows.`)] : [];
	return new StyledText([
		fg(palette.accent)(line(table.columns)),
		fg(palette.line)(`\n${rule}\n`),
		fg(palette.text)(table.rows.map(line).join('\n') || '(no rows)'),
		...more,
	]);
}

/**
 * The three views of one file: text, markdown, and a picture. The files panel and the
 * side area of pins draw a file through one view each.
 */
export class FileView {
	/** Holds the views. The caller places it. */
	readonly root: BoxRenderable;
	private readonly body: TextRenderable;
	private readonly markdown: MarkdownRenderable;
	private readonly image: ImageRenderable;

	constructor(renderer: CliRenderer, onImageError: () => void) {
		this.root = new BoxRenderable(renderer, { paddingRight: 2, width: '100%' });
		this.body = new TextRenderable(renderer, { content: '', wrapMode: 'word', width: '100%' });
		this.markdown = new MarkdownRenderable(renderer, {
			content: '',
			syntaxStyle: markdownStyle(),
			fg: palette.text,
			conceal: true,
			width: '100%',
			visible: false,
		});
		this.image = new ImageRenderable(renderer, {
			fit: 'fit',
			width: '100%',
			height: IMAGE_ROWS,
			visible: false,
			onError: onImageError,
		});
		this.root.add(this.body);
		this.root.add(this.markdown);
		this.root.add(this.image);
	}

	/**
	 * Draw a file as the one view it takes: a picture, a table of `at`, markdown, or plain
	 * text. Markdown is the default for a path that ends in `.md`.
	 */
	show(file: FileContent, at: number, markdown = /\.md$/i.test(file.path)): void {
		const table = file.tables?.[at];
		if (file.image) this.showImage(file.image);
		else if (table) this.showTable(table);
		else if (markdown) this.showMarkdown(file.text);
		else this.showText(file.text);
	}

	showText(text: string): void {
		this.body.content = new StyledText([fg(palette.text)(text)]);
		this.body.wrapMode = 'word';
		this.markdown.visible = false;
		this.image.visible = false;
		this.body.visible = true;
	}

	private showTable(table: TableView): void {
		this.body.content = tableText(table);
		this.body.wrapMode = 'none';
		this.markdown.visible = false;
		this.image.visible = false;
		this.body.visible = true;
	}

	private showMarkdown(text: string): void {
		if (this.markdown.content !== text) this.markdown.content = text;
		this.body.visible = false;
		this.image.visible = false;
		this.markdown.visible = true;
	}

	private showImage(image: ImageContent): void {
		this.body.visible = false;
		this.markdown.visible = false;
		this.image.source = image.data;
		this.image.visible = true;
	}
}
