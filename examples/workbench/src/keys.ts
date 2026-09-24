import type { CliRenderer, KeyEvent } from '@opentui/core';
import type { Composer } from './composer.ts';
import type { Painter } from './draw.ts';
import type { FilesPanel } from './files-panel.ts';
import type { Palette } from './palette.ts';
import type { ProcessBrowser } from './process-browser.ts';
import type { ProcessesPanel } from './process-panel.ts';
import type { Session } from './session.ts';
import { discussionKeys } from './timeline.ts';
import type { Transcript } from './transcript.ts';

/** Which surface takes the keys: the composer, the discussions, the refs, or a side panel. */
export type Mode = 'compose' | 'browse' | 'refs' | 'files' | 'processes';

/** How far each browse key moves the selection. */
/** How far each browse key, and each refs key, moves the selection. */
const BROWSE_STEP: Record<string, number> = { up: -1, k: -1, down: 1, j: 1 };

/** Below this width, a side panel replaces the conversation. */
const NARROW = 100;

/** What the keys reach into. `render` redraws after a change the keys make. */
export interface KeyParts {
	renderer: CliRenderer;
	session: Session;
	composer: Composer;
	palette: Palette;
	painter: Painter;
	panel: FilesPanel;
	processPanel: ProcessesPanel;
	processes: ProcessBrowser;
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
	/** The id of the chosen ref, in refs mode. */
	picking: string | undefined;
	/** The mode a side panel returns to when it closes. */
	private origin: Mode = 'compose';
	private readonly renderer: CliRenderer;
	private readonly session: Session;
	private readonly composer: Composer;
	private readonly palette: Palette;
	private readonly painter: Painter;
	private readonly panel: FilesPanel;
	private readonly processPanel: ProcessesPanel;
	private readonly processes: ProcessBrowser;
	private readonly transcript: Transcript;
	private readonly render: () => void;

	constructor(parts: KeyParts) {
		this.renderer = parts.renderer;
		this.session = parts.session;
		this.composer = parts.composer;
		this.palette = parts.palette;
		this.painter = parts.painter;
		this.panel = parts.panel;
		this.processPanel = parts.processPanel;
		this.processes = parts.processes;
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
		const ids = this.session.refItems.map((item) => item.id);
		if (this.picking && !ids.includes(this.picking)) this.picking = ids.at(-1);
		if (this.mode === 'refs' && !this.picking) this.mode = 'browse';
	}

	// Routing

	onKey(key: KeyEvent): void {
		if (this.mode === 'files') {
			this.filesKey(key);
			return;
		}
		if (this.mode === 'processes') {
			this.processKey(key);
			return;
		}
		if (key.name === 'pageup' || key.name === 'pagedown') {
			const page = Math.max(4, this.transcript.root.height - 2);
			this.transcript.scrollBy(key.name === 'pageup' ? -page : page);
			return;
		}
		if (this.mode === 'browse') this.browseKey(key);
		else if (this.mode === 'refs') this.refsKey(key);
		else this.composeKey(key);
	}

	// The files panel

	/** Open the files panel. A narrow terminal gives it the whole width. */
	openFiles(): void {
		this.openPanel('files');
	}

	/** Open the processes panel, and read the processes. A narrow terminal gives it the whole width. */
	openProcesses(): void {
		// The first part of `show` opens the browser, so the first draw shows the panel.
		void this.processes.show();
		this.openPanel('processes');
	}

	private openPanel(mode: 'files' | 'processes'): void {
		if (this.mode !== 'files' && this.mode !== 'processes') this.origin = this.mode;
		else if (this.mode !== mode) this.hidePanel();
		this.mode = mode;
		this.composer.blur();
		const roomy = this.renderer.width >= NARROW;
		this.transcript.root.visible = roomy;
		(mode === 'files' ? this.panel : this.processPanel).fill(!roomy);
		this.render();
	}

	/** Hide the open side panel. */
	private hidePanel(): void {
		if (this.mode === 'files') {
			this.session.browser.hide();
			this.panel.draw(this.session.browser);
		} else {
			this.processes.hide();
			this.processPanel.draw(this.processes);
		}
	}

	private closePanel(): void {
		this.hidePanel();
		this.transcript.root.visible = true;
		this.mode = this.origin;
		if (this.mode === 'compose') this.composer.focus();
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
		else this.closePanel();
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

	// The processes panel

	/** What each key does in the processes panel. */
	private readonly processKeys: Record<string, () => void> = {
		up: () => this.processes.move(-1),
		k: () => this.processes.move(-1),
		down: () => this.processes.move(1),
		j: () => this.processes.move(1),
		pageup: () => this.processPanel.scrollBy(-this.processPanel.page),
		pagedown: () => this.processPanel.scrollBy(this.processPanel.page),
		x: () => void this.processes.cancel(),
		escape: () => this.closePanel(),
		q: () => this.closePanel(),
	};

	private processKey(key: KeyEvent): void {
		key.preventDefault();
		if (key.ctrl && key.name === 'y') this.copyOutput();
		else if (!key.ctrl && !key.meta) this.processKeys[key.name]?.();
	}

	private copyOutput(): void {
		const text = this.processes.output?.text;
		if (!text) return;
		this.processes.message = this.processPanel.copy(text)
			? 'Copied the output to the clipboard.'
			: 'This terminal does not accept a clipboard copy.';
		this.render();
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
		else this.browseOther(name);
	}

	private browseOther(name: string): void {
		if (name === 's' && this.browsing) void this.session.showSteps(this.browsing);
		else if (name === 'r') this.enterRefs();
		else if (name === 'tab' || name === 'escape' || name === 'i') this.exitBrowse();
	}

	// Refs

	private enterRefs(): void {
		const items = this.session.refItems;
		if (items.length === 0) {
			this.session.say('No shown message has a ref. Press e to open every discussion.');
			return;
		}
		this.mode = 'refs';
		this.picking =
			this.picking && items.some((item) => item.id === this.picking)
				? this.picking
				: items.at(-1)?.id;
		this.painter.invalidate();
		this.render();
	}

	private exitRefs(): void {
		this.mode = 'browse';
		this.session.clearFocus();
		this.painter.invalidate();
		this.render();
	}

	private moveRef(step: number): void {
		const ids = this.session.refItems.map((item) => item.id);
		const at = this.picking ? ids.indexOf(this.picking) : -1;
		this.picking = ids[Math.max(0, Math.min(ids.length - 1, at + step))];
		this.session.clearFocus();
		this.render();
	}

	/** Open the chosen ref. A message ref jumps, and a file or a table opens the panel. */
	private async openPicked(): Promise<void> {
		const picked = this.session.refItems.find((item) => item.id === this.picking);
		if (picked?.resolved.target?.kind === 'message')
			this.painter.revealMessage(picked.resolved.target.seq);
		const intent = this.picking ? await this.session.openRef(this.picking) : undefined;
		if (intent) this.openFiles();
	}

	private refsKey(key: KeyEvent): void {
		key.preventDefault();
		const name = key.name;
		const step = BROWSE_STEP[name];
		if (step) this.moveRef(step);
		else if (name === 'return' || name === 'space') void this.openPicked();
		else if (name === 'escape' || name === 'r' || name === 'tab') this.exitRefs();
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
