import { fg, StyledText } from '@opentui/core';
import { tui as palette } from './brand.ts';
import type { Composer } from './composer.ts';
import type { FilesPanel } from './files-panel.ts';
import type { Header } from './header.ts';
import type { Mode } from './keys.ts';
import type { ProcessBrowser } from './process-browser.ts';
import type { ProcessesPanel } from './process-panel.ts';
import type { RefItem } from './refs.ts';
import type { Session } from './session.ts';
import { emptyText } from './session-text.ts';
import type { Marks, Transcript } from './transcript.ts';

const HINTS: Partial<Record<Mode, string>> = {
	compose: 'Enter sends   Ctrl+J newline   / commands   Ctrl+R rooms   Tab discussions',
	browse: 'Up/Down choose   Enter open or close   e open all   c close all   r refs   Esc back',
	refs: 'Up/Down choose a ref   Enter opens it   Esc back',
};

/** What the status line says while a side panel is open. */
const PANEL_STATUS: Partial<Record<Mode, string>> = {
	files: 'Browsing the workspace files. Esc closes the panel.',
	processes: 'Watching the background processes. Esc closes the panel.',
};

/** At this width or wider, the composer shows its hint line. */
const ROOMY = 96;

/** The parts the painter draws into. */
export interface DrawParts {
	session: Session;
	transcript: Transcript;
	composer: Composer;
	panel: FilesPanel;
	processPanel: ProcessesPanel;
	processes: ProcessBrowser;
	header: Header;
	/**
	 * The width the conversation has when the files panel is closed. A widget gets
	 * its new width in the next layout pass, so a read right after the panel closes
	 * returns the old width.
	 */
	width: () => number;
}

/**
 * The drawing. It reads the session and paints the header, the conversation, and
 * the composer chrome. It holds the last drawn signature, so an unchanged
 * conversation does not redraw, and it holds the next discussion to reveal.
 */
export class Painter {
	private readonly session: Session;
	private readonly transcript: Transcript;
	private readonly composer: Composer;
	private readonly panel: FilesPanel;
	private readonly processPanel: ProcessesPanel;
	private readonly processes: ProcessBrowser;
	private readonly header: Header;
	private readonly width: () => number;
	private drawn = '';
	private reveal: string | undefined;

	constructor(parts: DrawParts) {
		this.session = parts.session;
		this.transcript = parts.transcript;
		this.composer = parts.composer;
		this.panel = parts.panel;
		this.processPanel = parts.processPanel;
		this.processes = parts.processes;
		this.header = parts.header;
		this.width = parts.width;
	}

	/** Reveal one discussion at the next draw, so opening it keeps it in view. */
	revealNext(key: string | undefined): void {
		this.reveal = key === undefined ? undefined : `discussion-${key}`;
	}

	/** Reveal one message at the next draw, so a jump to it shows it. */
	revealMessage(seq: number): void {
		this.reveal = `message-${seq}`;
	}

	/** Force the next draw, after a change the signature does not show. */
	invalidate(): void {
		this.drawn = '';
	}

	/** Paint everything for the current mode and browse selection. */
	render(mode: Mode, browsing: string | undefined, picking?: string): void {
		this.drawTranscript(mode, browsing, picking);
		this.drawChrome(mode, picking);
		if (mode === 'files') this.panel.draw(this.session.browser);
		if (mode === 'processes') this.processPanel.draw(this.processes);
	}

	private marks(picking: string | undefined): Marks {
		const refs = new Map<number, RefItem[]>();
		for (const item of this.session.refItems)
			refs.set(item.seq, [...(refs.get(item.seq) ?? []), item]);
		return { refs, picked: picking, focus: this.session.focus };
	}

	private drawTranscript(
		mode: Mode,
		browsing: string | undefined,
		picking: string | undefined,
	): void {
		const session = this.session;
		const reveal = this.reveal;
		this.reveal = undefined;
		const bottom = session.takeBottom();
		const selected = mode === 'browse' ? browsing : undefined;
		const empty = session.blocks.length === 0 && !session.notice && session.view !== undefined;
		const shown = empty && session.view ? emptyText(session.view) : session.notice;
		const marks = this.marks(mode === 'refs' ? picking : undefined);
		const signature = JSON.stringify([
			session.blocks,
			selected,
			shown,
			session.noticeSeq,
			[...marks.refs.values()],
			marks.picked,
			marks.focus,
		]);
		if (signature === this.drawn) return;
		this.drawn = signature;
		this.transcript.render(session.blocks, selected, shown, reveal, bottom, marks);
	}

	private drawChrome(mode: Mode, picking: string | undefined): void {
		const session = this.session;
		this.drawHeader();
		this.composer.setChip(
			session.waiting?.toLowerCase() ?? (session.identity ? session.room || 'room' : 'who'),
			Boolean(session.view?.exchange),
		);
		this.composer.setPlaceholder(this.placeholder());
		this.composer.setStatus(new StyledText(this.statusChunks(mode, picking)));
		const roomy = this.width() >= ROOMY;
		// A side panel draws its own hints, so its mode has none here.
		const quiet = session.error || session.offline || !roomy;
		this.composer.setHints(quiet ? '' : (HINTS[mode] ?? ''));
	}

	/** What the status line says about the chosen ref: why it does not open, or what Enter does. */
	private refStatus(picking: string | undefined): string {
		const resolved = this.session.refItems.find((item) => item.id === picking)?.resolved;
		if (!resolved) return 'No ref is chosen.';
		if (!resolved.target)
			return `This ref does not open: ${resolved.problem ?? 'it does not resolve'}.`;
		return resolved.target.kind === 'message'
			? 'Enter jumps to this message.'
			: 'Enter opens this ref in the files panel.';
	}

	private placeholder(): string {
		const session = this.session;
		if (session.awaitingGoal) return `What is ${session.awaitingGoal} for?`;
		if (!session.identity) return 'Pick a person: type /user <name>';
		return 'Message the room, or type / for commands';
	}

	private drawHeader(): void {
		this.header.draw({ identity: this.session.identity, view: this.session.view }, this.width());
	}

	private statusChunks(mode: Mode, picking: string | undefined) {
		const session = this.session;
		if (session.error) return [fg(palette.red)(`Error: ${session.error}`)];
		if (session.offline) return [fg(palette.red)(`Cannot read the rooms: ${session.offline}`)];
		const panel = PANEL_STATUS[mode];
		if (panel) return [fg(palette.muted)(panel)];
		if (mode === 'refs') return [fg(palette.muted)(this.refStatus(picking))];
		if (session.awaitingGoal)
			return [
				fg(palette.muted)(
					`Type the goal for ${session.awaitingGoal}. Enter creates it. Esc cancels.`,
				),
			];
		if (!session.identity) return [fg(palette.muted)('Pick a person to begin.')];
		const view = session.view;
		if (!view) return [fg(palette.muted)('Opening…')];
		if (view.status !== 'running')
			return [fg(palette.muted)(`${view.name} is ${view.status}. Use /resume.`)];
		const waiting = session.attention[0];
		if (waiting) return [fg(palette.coral)('● '), fg(palette.muted)(waiting)];
		if (view.exchange)
			return [fg(palette.coral)('● '), fg(palette.muted)('A new message steers the open exchange')];
		return [fg(palette.green)('● '), fg(palette.muted)('Active')];
	}
}
