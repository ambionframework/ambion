import { fg, StyledText } from '@opentui/core';
import { tui as palette } from './brand.ts';
import type { Composer } from './composer.ts';
import type { FilesPanel } from './files-panel.ts';
import type { Header } from './header.ts';
import type { Mode } from './keys.ts';
import { emptyText, type Session } from './session.ts';
import type { Transcript } from './transcript.ts';

const HINTS = {
	compose: 'Enter sends   Ctrl+J newline   / commands   Ctrl+R rooms   Tab discussions',
	browse: 'Up/Down choose   Enter open or close   e open all   c close all   Esc back',
} as const;

/** At this width or wider, the composer shows its hint line. */
const ROOMY = 96;

/** The parts the painter draws into. */
export interface DrawParts {
	session: Session;
	transcript: Transcript;
	composer: Composer;
	panel: FilesPanel;
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
	private readonly header: Header;
	private readonly width: () => number;
	private drawn = '';
	private reveal: string | undefined;

	constructor(parts: DrawParts) {
		this.session = parts.session;
		this.transcript = parts.transcript;
		this.composer = parts.composer;
		this.panel = parts.panel;
		this.header = parts.header;
		this.width = parts.width;
	}

	/** Reveal one discussion at the next draw, so opening it keeps it in view. */
	revealNext(key: string | undefined): void {
		this.reveal = key;
	}

	/** Force the next draw, after a change the signature does not show. */
	invalidate(): void {
		this.drawn = '';
	}

	/** Paint everything for the current mode and browse selection. */
	render(mode: Mode, browsing: string | undefined): void {
		this.drawTranscript(mode, browsing);
		this.drawChrome(mode);
		if (mode === 'files') this.panel.draw(this.session.browser);
	}

	private drawTranscript(mode: Mode, browsing: string | undefined): void {
		const session = this.session;
		const reveal = this.reveal;
		this.reveal = undefined;
		const bottom = session.takeBottom();
		const selected = mode === 'browse' ? browsing : undefined;
		const empty = session.blocks.length === 0 && !session.notice && session.view !== undefined;
		const shown = empty && session.view ? emptyText(session.view) : session.notice;
		const signature = JSON.stringify([session.blocks, selected, shown, session.noticeSeq]);
		if (signature === this.drawn) return;
		this.drawn = signature;
		this.transcript.render(session.blocks, selected, shown, reveal, bottom);
	}

	private drawChrome(mode: Mode): void {
		const session = this.session;
		this.drawHeader();
		this.composer.setChip(
			session.waiting?.toLowerCase() ?? (session.identity ? session.room || 'room' : 'who'),
			Boolean(session.view?.exchange),
		);
		this.composer.setPlaceholder(this.placeholder());
		this.composer.setStatus(new StyledText(this.statusChunks(mode)));
		const roomy = this.width() >= ROOMY;
		const quiet = session.error || session.offline || !roomy || mode === 'files';
		this.composer.setHints(quiet ? '' : HINTS[mode === 'browse' ? 'browse' : 'compose']);
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

	private statusChunks(mode: Mode) {
		const session = this.session;
		if (session.error) return [fg(palette.red)(`Error: ${session.error}`)];
		if (session.offline) return [fg(palette.red)(`Cannot read the rooms: ${session.offline}`)];
		if (mode === 'files')
			return [fg(palette.muted)('Browsing the workspace files. Esc closes the panel.')];
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
