import {
	BoxRenderable,
	type CliRenderer,
	fg,
	ScrollBoxRenderable,
	StyledText,
	type TextChunk,
	TextRenderable,
} from '@opentui/core';
import type { ActionPad } from './action-state.ts';
import { tui as palette } from './brand.ts';
import { describe, FileView } from './file-view.ts';
import { type Pin, type Pins, plain } from './pins.ts';
import { ActionsView, FOCUS_ID } from './widget-actions.ts';
import type { FileContent } from './workbench.ts';

/** The side area of the files that agents pinned: a stack, each with its title and kind. */
export class PinsPanel {
	readonly root: BoxRenderable;
	private readonly scroll: ScrollBoxRenderable;
	private readonly renderer: CliRenderer;
	/** The pins last drawn. The session keeps one array until the pins change. */
	private drawn: Pins | undefined;
	private readonly sections: (BoxRenderable | TextRenderable)[] = [];
	private readonly note: TextRenderable;
	private readonly hint: TextRenderable;
	private readonly pad: ActionPad;
	/** The actions drawn under each pin, by widget name. */
	private readonly actions = new Map<string, ActionsView>();

	constructor(renderer: CliRenderer, pad: ActionPad) {
		this.renderer = renderer;
		this.pad = pad;
		this.root = new BoxRenderable(renderer, {
			flexDirection: 'column',
			width: '40%',
			flexShrink: 0,
			minWidth: 30,
			border: true,
			borderColor: palette.line,
			backgroundColor: palette.panel,
			paddingLeft: 1,
			paddingRight: 1,
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
		this.note = this.text(
			fg(palette.summary)('The room is stopped. The files are as last read.'),
			'word',
		);
		this.note.visible = false;
		this.hint = new TextRenderable(renderer, {
			content: '',
			flexShrink: 0,
			wrapMode: 'none',
			visible: false,
		});
		this.root.add(this.note);
		this.root.add(this.scroll);
		this.root.add(this.hint);
	}

	/**
	 * Draw the pins, or hide the area when there are none or another side panel is open.
	 * A stopped room keeps its pins as the host last read them, and the area says so.
	 */
	draw(list: Pins, open: boolean, stopped: boolean): void {
		this.root.visible = open && list.pins.length > 0;
		if (!this.root.visible) return;
		this.note.visible = stopped;
		if (list !== this.drawn) this.rebuild(list);
		for (const [name, view] of this.actions) view.draw(this.pad.rows(name));
		this.hint.visible = this.pad.active;
		const hint = this.pad.hint();
		this.hint.height = hint.length;
		this.hint.content = new StyledText([fg(palette.dim)(hint.join('\n'))]);
		if (this.pad.active) this.scroll.scrollChildIntoView(FOCUS_ID);
	}

	private rebuild(list: Pins): void {
		this.drawn = list;
		this.actions.clear();
		for (const old of this.sections.splice(0)) {
			this.scroll.remove(old);
			old.destroyRecursively();
		}
		for (const pin of list.pins) this.add(this.section(pin));
		if (list.more > 0) this.add(this.text(fg(palette.dim)(`and ${list.more} more`)));
		this.scroll.scrollTop = 0;
	}

	private add(section: BoxRenderable | TextRenderable): void {
		this.sections.push(section);
		this.scroll.add(section);
	}

	private text(chunk: TextChunk, wrap: 'none' | 'word' = 'none'): TextRenderable {
		return new TextRenderable(this.renderer, {
			content: new StyledText([chunk]),
			flexShrink: 0,
			wrapMode: wrap,
			width: '100%',
		});
	}

	/** One pin: a title line, then the file as its kind draws it, or the problem, then its actions. */
	private section(pin: Pin): BoxRenderable {
		const box = new BoxRenderable(this.renderer, {
			flexDirection: 'column',
			width: '100%',
			marginBottom: 1,
		});
		box.add(
			new TextRenderable(this.renderer, {
				content: new StyledText([
					fg(palette.accent)(pin.title ?? pin.name),
					fg(palette.dim)(`   ${headline(pin)}`),
				]),
				flexShrink: 0,
				wrapMode: 'none',
			}),
		);
		if (pin.file) {
			const view = new FileView(this.renderer, () => view.showText('Cannot decode this picture.'));
			view.show(pin.file, firstWithRows(pin.file), pin.kind === 'markdown');
			box.add(view.root);
		} else {
			const problem = plain(`${pin.path}: ${pin.problem ?? 'The file did not read.'}`);
			box.add(this.text(fg(palette.red)(problem), 'word'));
		}
		const actions = new ActionsView(this.renderer);
		this.actions.set(pin.name, actions);
		box.add(actions.root);
		return box;
	}
}

/** The kind of a pin, and what its file holds. A table pin names the table that it shows. */
function headline(pin: Pin): string {
	const tables = pin.file?.tables;
	if (tables) {
		const shown = tables[firstWithRows(pin.file)]?.name ?? '';
		return `table ${shown}, ${tables.length} ${tables.length === 1 ? 'table' : 'tables'}`;
	}
	return pin.file ? `${pin.kind}, ${describe(pin.file)}` : pin.kind;
}

/** The first table of a database file that holds rows, or the first table. */
function firstWithRows(file: FileContent | undefined): number {
	return Math.max(0, file?.tables?.findIndex((table) => table.count > 0) ?? 0);
}
