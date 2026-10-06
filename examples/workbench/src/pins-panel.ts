import {
	BoxRenderable,
	type CliRenderer,
	fg,
	ScrollBoxRenderable,
	StyledText,
	TextRenderable,
} from '@opentui/core';
import { tui as palette } from './brand.ts';
import { describe, FileView } from './file-view.ts';
import { type Pin, pinLabel } from './pins.ts';

/** The side area of the files that agents pinned: a stack, each with its title and kind. */
export class PinsPanel {
	readonly root: BoxRenderable;
	private readonly scroll: ScrollBoxRenderable;
	private readonly renderer: CliRenderer;
	/** The pins last drawn. The session keeps one array until the pins change. */
	private drawn: readonly Pin[] | undefined;
	private readonly sections: BoxRenderable[] = [];

	constructor(renderer: CliRenderer) {
		this.renderer = renderer;
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
		this.root.add(this.scroll);
	}

	/** Draw the pins, or hide the area when there are none or another side panel is open. */
	draw(pins: readonly Pin[], open: boolean): void {
		this.root.visible = open && pins.length > 0;
		if (!this.root.visible || pins === this.drawn) return;
		this.drawn = pins;
		for (const old of this.sections.splice(0)) {
			this.scroll.remove(old);
			old.destroyRecursively();
		}
		for (const pin of pins) {
			const section = this.section(pin);
			this.sections.push(section);
			this.scroll.add(section);
		}
		this.scroll.scrollTop = 0;
	}

	/** One pin: a title line, then the file as its kind draws it, or the problem. */
	private section(pin: Pin): BoxRenderable {
		const box = new BoxRenderable(this.renderer, {
			flexDirection: 'column',
			width: '100%',
			marginBottom: 1,
		});
		const detail = pin.file ? describe(pin.file) : pin.kind;
		const title = new TextRenderable(this.renderer, {
			content: new StyledText([
				fg(palette.accent)(pinLabel(pin)),
				fg(palette.dim)(`   ${pin.kind}, ${detail}`),
			]),
			flexShrink: 0,
			wrapMode: 'none',
		});
		box.add(title);
		if (pin.file) {
			const view = new FileView(this.renderer, () => view.showText('Cannot decode this picture.'));
			view.show(pin.file, firstWithRows(pin), pin.kind === 'markdown');
			box.add(view.root);
		} else {
			const problem = pin.problem ?? 'The file did not read.';
			box.add(
				new TextRenderable(this.renderer, {
					content: new StyledText([fg(palette.red)(`${pin.path}: ${problem}`)]),
					wrapMode: 'word',
					width: '100%',
				}),
			);
		}
		return box;
	}
}

/** The first table of a database pin that holds rows, or the first table. */
function firstWithRows(pin: Pin): number {
	return Math.max(0, pin.file?.tables?.findIndex((table) => table.count > 0) ?? 0);
}
