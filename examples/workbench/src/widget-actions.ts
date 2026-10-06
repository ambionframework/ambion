import {
	BoxRenderable,
	bg,
	type CliRenderer,
	fg,
	StyledText,
	type TextChunk,
	TextRenderable,
} from '@opentui/core';
import type { Row, Tone } from './action-state.ts';
import { tui as palette } from './brand.ts';

/** The id of the line that holds the focus. A scroll box reads it to keep the line in view. */
export const FOCUS_ID = 'widget-action-focus';

const TONES: Record<Tone, string> = {
	dim: palette.dim,
	info: palette.summary,
	error: palette.red,
};

/** One row as a styled line. A button is a label in brackets, and the focused one is marked. */
function chunksOf(row: Row): TextChunk[] {
	if (row.type === 'note') return [fg(TONES[row.tone])(row.text)];
	if (row.type === 'field')
		return [
			fg(row.active ? palette.accent : palette.muted)(`   ${row.label}: `),
			fg(palette.text)(row.value),
		];
	if (row.done) return [fg(palette.dim)(`  ✓ ${row.label}  done`)];
	if (row.blocked !== undefined)
		return [fg(palette.dim)(`${row.focused ? '▸' : ' '} [ ${row.label} ]  ${row.blocked}`)];
	if (row.focused) return [bg(palette.selected)(fg(palette.accent)(`▸ [ ${row.label} ]`))];
	return [fg(palette.text)(`  [ ${row.label} ]`)];
}

/**
 * The actions of one widget, drawn as lines under it: each action as a button, the open form,
 * and the last result. It holds no state. `draw` takes the rows that an `ActionPad` gives.
 */
export class ActionsView {
	readonly root: BoxRenderable;
	private readonly renderer: CliRenderer;
	private drawn = '';

	constructor(renderer: CliRenderer) {
		this.renderer = renderer;
		this.root = new BoxRenderable(renderer, {
			flexDirection: 'column',
			width: '100%',
			flexShrink: 0,
			visible: false,
		});
	}

	/** Draw the rows. An unchanged list draws nothing. */
	draw(rows: readonly Row[]): void {
		this.root.visible = rows.length > 0;
		const signature = JSON.stringify(rows);
		if (signature === this.drawn) return;
		this.drawn = signature;
		for (const old of this.root.getChildren()) {
			this.root.remove(old);
			old.destroyRecursively();
		}
		// An open form holds the focus, not its button.
		const form = rows.some((row) => row.type === 'field');
		for (const row of rows) {
			const focus =
				row.type === 'field' ? row.active : row.type === 'button' && row.focused && !form;
			this.root.add(
				new TextRenderable(this.renderer, {
					...(focus ? { id: FOCUS_ID } : {}),
					content: new StyledText(chunksOf(row)),
					flexShrink: 0,
					wrapMode: row.type === 'button' ? 'none' : 'word',
					width: '100%',
				}),
			);
		}
	}
}
