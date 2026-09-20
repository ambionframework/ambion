import type { CliRenderer, KeyEvent } from '@opentui/core';
import type { Composer } from './composer.ts';
import type { Painter } from './draw.ts';
import type { FilesPanel } from './files-panel.ts';
import type { Palette } from './palette.ts';
import type { Session } from './session.ts';
import { discussionKeys } from './timeline.ts';
import type { Transcript } from './transcript.ts';

/** Which surface takes the keys: the composer, the discussions, or the files panel. */
export type Mode = 'compose' | 'browse' | 'files';

/** How far each browse key moves the selection. */
const BROWSE_STEP: Record<string, number> = { up: -1, k: -1, down: 1, j: 1 };

/** Below this width, the files panel replaces the conversation. */
const NARROW = 100;

/** What the keys reach into. `render` redraws after a change the keys make. */
export interface KeyParts {
	renderer: CliRenderer;
	session: Session;
	composer: Composer;
	palette: Palette;
	painter: Painter;
	panel: FilesPanel;
	transcript: Transcript;
	render: () => void;
}

/**
 * The input. It routes each key to the composer, the discussions, or the files
 * panel, and it holds the current mode and the browse selection. It changes the
 * session and the widgets; it holds no drawing state of its own.
 */
export class Keys {
	mode: Mode = 'compose';
	browsing: string | undefined;
	private readonly renderer: CliRenderer;
	private readonly session: Session;
	private readonly composer: Composer;
	private readonly palette: Palette;
	private readonly painter: Painter;
	private readonly panel: FilesPanel;
	private readonly transcript: Transcript;
	private readonly render: () => void;

	constructor(parts: KeyParts) {
		this.renderer = parts.renderer;
		this.session = parts.session;
		this.composer = parts.composer;
		this.palette = parts.palette;
		this.painter = parts.painter;
		this.panel = parts.panel;
		this.transcript = parts.transcript;
		this.render = parts.render;
	}

	/** Recompute the palette rows. The palette closes outside compose mode. */
	refreshPalette(): void {
		this.palette.refresh(this.mode === 'compose', (text) => this.session.suggestions(text));
	}

	/** Keep the browse selection on a discussion that still exists. */
	reconcile(): void {
		const keys = discussionKeys(this.session.blocks);
		if (this.browsing && !keys.includes(this.browsing)) this.browsing = keys.at(-1);
	}

	// Routing

	onKey(key: KeyEvent): void {
		if (this.mode === 'files') {
			this.filesKey(key);
			return;
		}
		if (key.name === 'pageup' || key.name === 'pagedown') {
			const page = Math.max(4, this.transcript.root.height - 2);
			this.transcript.scrollBy(key.name === 'pageup' ? -page : page);
			return;
		}
		if (this.mode === 'browse') this.browseKey(key);
		else this.composeKey(key);
	}

	// The files panel

	/** Open the files panel. A narrow terminal gives it the whole width. */
	openFiles(): void {
		this.mode = 'files';
		this.composer.blur();
		const roomy = this.renderer.width >= NARROW;
		this.transcript.root.visible = roomy;
		this.panel.fill(!roomy);
		this.render();
	}

	private closeFiles(): void {
		this.session.browser.hide();
		this.panel.draw(this.session.browser);
		this.transcript.root.visible = true;
		this.mode = 'compose';
		this.composer.focus();
		this.painter.invalidate();
		this.render();
	}

	/** What each key does in the files panel. Any other printable key adds to the search. */
	private readonly fileKeys: Record<string, () => void> = {
		up: () => this.session.browser.move(-1),
		down: () => this.session.browser.move(1),
		left: () => this.session.browser.moveTable(-1),
		right: () => this.session.browser.moveTable(1),
		pageup: () => this.panel.scrollBy(-this.panel.page),
		pagedown: () => this.panel.scrollBy(this.panel.page),
		escape: () => this.escapeFiles(),
		backspace: () => this.session.browser.backspace(),
	};

	private readonly controlKeys: Record<string, () => void> = {
		y: () => this.copyFile(),
		u: () => this.session.browser.clear(),
	};

	private filesKey(key: KeyEvent): void {
		key.preventDefault();
		const action = key.ctrl ? this.controlKeys[key.name] : this.fileKeys[key.name];
		if (action) action();
		else if (!key.ctrl && !key.meta && key.sequence.length === 1 && key.sequence >= ' ')
			this.session.browser.type(key.sequence);
	}

	/** Esc clears the search first, then closes the panel. */
	private escapeFiles(): void {
		if (this.session.browser.query) this.session.browser.clear();
		else this.closeFiles();
	}

	private copyFile(): void {
		const text = this.session.browser.file?.text;
		if (text === undefined) return;
		this.panel.flash(
			this.panel.copy(text)
				? 'Copied to the clipboard.'
				: 'This terminal does not accept a clipboard copy.',
		);
	}

	// Discussions

	private enterBrowse(): void {
		const keys = discussionKeys(this.session.blocks);
		if (keys.length === 0) {
			this.session.say('No discussions to browse yet.');
			return;
		}
		this.mode = 'browse';
		this.browsing = this.browsing && keys.includes(this.browsing) ? this.browsing : keys.at(-1);
		this.composer.blur();
		this.painter.revealNext(this.browsing);
		this.painter.invalidate();
		this.render();
	}

	private exitBrowse(): void {
		if (this.mode !== 'browse') return;
		this.mode = 'compose';
		this.composer.focus();
		this.painter.invalidate();
		this.render();
	}

	private move(step: number): void {
		const keys = discussionKeys(this.session.blocks);
		const at = this.browsing ? keys.indexOf(this.browsing) : -1;
		this.browsing = keys[Math.max(0, Math.min(keys.length - 1, at + step))];
		this.painter.revealNext(this.browsing);
		this.render();
	}

	private toggle(key: string): void {
		this.painter.revealNext(key);
		this.session.toggle(key);
	}

	private setAllOpen(open: boolean): void {
		// Opening everything grows the content above the selection, so keep it in view.
		this.painter.revealNext(this.browsing);
		this.session.setAllOpen(open);
	}

	private browseKey(key: KeyEvent): void {
		key.preventDefault();
		const name = key.name;
		const step = BROWSE_STEP[name];
		if (step) this.move(step);
		else if ((name === 'return' || name === 'space') && this.browsing) this.toggle(this.browsing);
		else if (name === 'e' || name === 'c') this.setAllOpen(name === 'e');
		else if (name === 'tab' || name === 'escape' || name === 'i') this.exitBrowse();
	}

	// The composer

	private composeKey(key: KeyEvent): void {
		if (key.ctrl && key.name === 'r') {
			key.preventDefault();
			this.palette.revive();
			this.composer.setText('/room ');
		} else if (key.name === 'tab') {
			key.preventDefault();
			if (this.palette.open) this.palette.complete();
			else this.enterBrowse();
		} else if (key.name === 'escape' && this.session.awaitingGoal) {
			key.preventDefault();
			this.session.cancelWaiting();
			this.composer.setText('');
		} else if (this.palette.open) this.paletteKey(key);
	}

	private paletteKey(key: KeyEvent): void {
		if (key.name === 'up' || key.name === 'down') {
			key.preventDefault();
			this.palette.move(key.name === 'up' ? -1 : 1);
		} else if (key.name === 'escape') {
			key.preventDefault();
			this.palette.dismiss();
			this.refreshPalette();
		}
	}
}
