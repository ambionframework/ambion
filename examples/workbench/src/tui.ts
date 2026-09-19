import type { ParticipantInfo } from '@ambionframework/ambion';
import {
	BoxRenderable,
	type CliRenderer,
	createCliRenderer,
	fg,
	type KeyEvent,
	StyledText,
	TextRenderable,
} from '@opentui/core';
import { brand, tui as palette } from './brand.ts';
import { parse, type Suggestion } from './commands.ts';
import { Composer } from './composer.ts';
import { FilesPanel } from './files-panel.ts';
import { emptyText, type Intent, Session } from './session.ts';
import { discussionKeys } from './timeline.ts';
import { Transcript } from './transcript.ts';
import {
	type OpenOptions,
	openWorkbench,
	type Person,
	type RoomView,
	type Workbench,
} from './workbench.ts';

const POLL_MS = 700;
const ROOMS_MS = 4_000;

const HINTS = {
	compose: 'Enter sends   Ctrl+J newline   / commands   Ctrl+R rooms   Tab discussions',
	browse: 'Up/Down choose   Enter open or close   e open all   c close all   Esc back',
} as const;

/** How far each browse key moves the selection. */
const BROWSE_STEP: Record<string, number> = { up: -1, k: -1, down: 1, j: 1 };

/** Below this width, the files panel replaces the conversation. */
const NARROW = 100;

const errorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/** A participant's color: coral at work, green present, dim otherwise. */
function participantColor(participant: ParticipantInfo): string {
	if (participant.kind === 'agent')
		return participant.status === 'active' ? palette.coral : palette.dim;
	return participant.presence === 'present' ? palette.green : palette.dim;
}

/** The header lines for one room: who is in it, and what it is for. */
function roomLines(view: RoomView) {
	return [
		fg(palette.muted)('\n'),
		...view.participants.map((participant) =>
			fg(participantColor(participant))(`${participant.name}  `),
		),
		fg(palette.dim)(`\n${view.name}  ${view.goal ?? ''}`),
	];
}

type Mode = 'compose' | 'browse' | 'files';

/** The terminal. It draws a session, sends it what the person types, and holds no rules of its own. */
class WorkbenchTui {
	private readonly renderer: CliRenderer;
	private readonly session: Session;
	private readonly transcript: Transcript;
	private readonly composer: Composer;
	private readonly panel: FilesPanel;
	private readonly body: BoxRenderable;
	private readonly header: TextRenderable;
	private mode: Mode = 'compose';
	private browsing: string | undefined;
	private suggestions: Suggestion[] = [];
	private pick = 0;
	private dismissed = false;
	private drawn = '';
	private reveal: string | undefined;
	private stopped = false;

	constructor(renderer: CliRenderer, host: Workbench, identity: Person | undefined) {
		this.renderer = renderer;
		this.session = new Session(host, identity, () => this.render());
		this.header = new TextRenderable(renderer, { content: '', flexShrink: 0, wrapMode: 'none' });
		this.transcript = new Transcript(renderer);
		this.panel = new FilesPanel(renderer);
		this.body = new BoxRenderable(renderer, {
			flexDirection: 'row',
			flexGrow: 1,
			gap: 1,
			minHeight: 0,
		});
		this.composer = new Composer(renderer, {
			submit: () => void this.onSubmit(),
			change: () => this.updatePalette(),
		});
		const root = new BoxRenderable(renderer, {
			flexDirection: 'column',
			width: '100%',
			height: '100%',
			padding: 1,
			gap: 1,
			backgroundColor: palette.bg,
		});
		root.add(this.header);
		this.body.add(this.transcript.root);
		this.body.add(this.panel.root);
		root.add(this.body);
		root.add(this.composer.root);
		renderer.root.add(root);
		renderer.keyInput.on('keypress', (key: KeyEvent) => this.onKey(key));
		this.composer.focus();
		this.render();
	}

	/** Run until the renderer is destroyed. */
	async run(): Promise<void> {
		const timers = [
			setInterval(() => void this.session.refresh(), POLL_MS),
			setInterval(() => void this.session.refreshRooms(), ROOMS_MS),
		];
		await new Promise<void>((resolve) => {
			this.renderer.once('destroy', () => {
				this.stopped = true;
				for (const timer of timers) clearInterval(timer);
				resolve();
			});
			void this.begin();
		});
	}

	private async begin(): Promise<void> {
		await this.session.start();
		// Nobody is chosen yet: open the list of people, as the identity gate did on the web.
		if (!this.session.identity) this.composer.setText('/user ');
	}

	async leave(): Promise<void> {
		await this.session.leave();
	}

	// Drawing

	private render(): void {
		if (this.stopped) return;
		this.drawTranscript();
		this.drawChrome();
		if (this.mode === 'files') this.panel.draw(this.session.browser);
	}

	private drawTranscript(): void {
		const session = this.session;
		const reveal = this.reveal;
		this.reveal = undefined;
		const bottom = session.takeBottom();
		const keys = discussionKeys(session.blocks);
		if (this.browsing && !keys.includes(this.browsing)) this.browsing = keys.at(-1);
		const selected = this.mode === 'browse' ? this.browsing : undefined;
		const empty = session.blocks.length === 0 && !session.notice && session.view !== undefined;
		const shown = empty && session.view ? emptyText(session.view) : session.notice;
		const signature = JSON.stringify([session.blocks, selected, shown, session.noticeSeq]);
		if (signature === this.drawn) return;
		this.drawn = signature;
		this.transcript.render(session.blocks, selected, shown, reveal, bottom);
	}

	private drawChrome(): void {
		const session = this.session;
		this.drawHeader();
		this.composer.setChip(
			session.waiting?.toLowerCase() ?? (session.identity ? session.room || 'room' : 'who'),
			Boolean(session.view?.exchange),
		);
		this.composer.setPlaceholder(this.placeholder());
		this.composer.setStatus(new StyledText(this.statusChunks()));
		const roomy = this.transcript.root.width >= 96;
		const quiet = session.error || session.offline || !roomy || this.mode === 'files';
		this.composer.setHints(quiet ? '' : HINTS[this.mode === 'browse' ? 'browse' : 'compose']);
		this.updatePalette();
	}

	private placeholder(): string {
		const session = this.session;
		if (session.awaitingGoal) return `What is ${session.awaitingGoal} for?`;
		if (!session.identity) return 'Pick a person: type /user <name>';
		return 'Message the room, or type / for commands';
	}

	private drawHeader(): void {
		const identity = this.session.identity;
		const who = identity
			? `   as ${identity.name}, ${identity.role.toLowerCase()}`
			: '   choose a person with /user';
		const view = this.session.view;
		this.header.content = new StyledText([
			fg(palette.accent)(`${brand.name} ${brand.product}`),
			fg(palette.muted)(who),
			...(view ? roomLines(view) : []),
		]);
	}

	private statusChunks() {
		const session = this.session;
		if (session.error) return [fg(palette.red)(`Error: ${session.error}`)];
		if (session.offline) return [fg(palette.red)(`Cannot read the rooms: ${session.offline}`)];
		if (this.mode === 'files')
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
		if (view.exchange)
			return [fg(palette.coral)('● '), fg(palette.muted)('A new message steers the open exchange')];
		return [fg(palette.green)('● '), fg(palette.muted)('Ready')];
	}

	// The composer

	private updatePalette(): void {
		const open = !this.dismissed && this.mode === 'compose';
		this.suggestions = open ? this.session.suggestions(this.composer.text) : [];
		this.pick = Math.min(this.pick, Math.max(0, this.suggestions.length - 1));
		this.composer.setPalette(this.suggestions, this.pick);
	}

	private async onSubmit(): Promise<void> {
		const row = this.suggestions[this.pick];
		if (row && !row.run) {
			this.composer.setText(row.insert);
			return;
		}
		const text = row ? row.insert : this.composer.text;
		const isMessage = !this.session.awaitingGoal && parse(text).kind === 'message';
		const intent = await this.session.submit(text);
		// A message that failed to send stays in the box, so the person can send it again.
		if (!(isMessage && this.session.error)) this.composer.setText('');
		if (intent) this.apply(intent);
	}

	private apply(intent: Intent): void {
		if (intent.type === 'quit') this.renderer.destroy();
		else if (intent.type === 'compose') this.composer.setText(intent.text);
		else this.openFiles();
	}

	// The files panel

	private openFiles(): void {
		this.mode = 'files';
		this.composer.blur();
		// A narrow terminal has no room for both, so the panel takes the whole width.
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
		this.drawn = '';
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

	private filesKey(key: KeyEvent): void {
		key.preventDefault();
		const action = key.ctrl ? this.controlKeys[key.name] : this.fileKeys[key.name];
		if (action) action();
		else if (!key.ctrl && !key.meta && key.sequence.length === 1 && key.sequence >= ' ')
			this.session.browser.type(key.sequence);
	}

	private readonly controlKeys: Record<string, () => void> = {
		y: () => this.copyFile(),
		u: () => this.session.browser.clear(),
	};

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
		this.reveal = this.browsing;
		this.drawn = '';
		this.render();
	}

	private exitBrowse(): void {
		if (this.mode !== 'browse') return;
		this.mode = 'compose';
		this.composer.focus();
		this.drawn = '';
		this.render();
	}

	private move(step: number): void {
		const keys = discussionKeys(this.session.blocks);
		const at = this.browsing ? keys.indexOf(this.browsing) : -1;
		this.browsing = keys[Math.max(0, Math.min(keys.length - 1, at + step))];
		this.reveal = this.browsing;
		this.render();
	}

	private toggle(key: string): void {
		this.reveal = key;
		this.session.toggle(key);
	}

	private setAllOpen(open: boolean): void {
		// Opening everything grows the content above the selection, so keep it in view.
		this.reveal = this.browsing;
		this.session.setAllOpen(open);
	}

	// Keys

	private onKey(key: KeyEvent): void {
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

	private browseKey(key: KeyEvent): void {
		key.preventDefault();
		const name = key.name;
		const step = BROWSE_STEP[name];
		if (step) this.move(step);
		else if ((name === 'return' || name === 'space') && this.browsing) this.toggle(this.browsing);
		else if (name === 'e' || name === 'c') this.setAllOpen(name === 'e');
		else if (name === 'tab' || name === 'escape' || name === 'i') this.exitBrowse();
	}

	private composeKey(key: KeyEvent): void {
		if (key.ctrl && key.name === 'r') {
			key.preventDefault();
			this.dismissed = false;
			this.composer.setText('/room ');
		} else if (key.name === 'tab') {
			key.preventDefault();
			if (this.suggestions.length > 0) this.complete();
			else this.enterBrowse();
		} else if (key.name === 'escape' && this.session.awaitingGoal) {
			key.preventDefault();
			this.session.cancelWaiting();
			this.composer.setText('');
		} else if (this.suggestions.length > 0) this.paletteKey(key);
	}

	private paletteKey(key: KeyEvent): void {
		const last = this.suggestions.length - 1;
		if (key.name === 'up' || key.name === 'down') {
			key.preventDefault();
			this.pick = key.name === 'up' ? Math.max(0, this.pick - 1) : Math.min(last, this.pick + 1);
			this.composer.setPalette(this.suggestions, this.pick);
		} else if (key.name === 'escape') {
			key.preventDefault();
			this.dismissed = true;
			this.updatePalette();
		}
	}

	private complete(): void {
		const row = this.suggestions[this.pick];
		if (row) this.composer.setText(row.insert);
	}
}

/** OpenTUI draws through Node's FFI, which Node enables only with a flag. */
async function openRenderer(): Promise<CliRenderer> {
	try {
		return await createCliRenderer({ exitOnCtrlC: true, targetFps: 30 });
	} catch (error) {
		const detail = errorText(error);
		if (!/FFI/i.test(detail)) throw error;
		throw new Error(
			`${detail}\nStart the Workbench with \`pnpm start\`. It passes --experimental-ffi to Node.`,
		);
	}
}

export interface RunOptions {
	/** Where the journals and the workspace live. */
	directory: string;
	/** The person to act as. Without one, the terminal asks. */
	person?: string;
	/** A model stream, for tests. */
	stream?: OpenOptions['stream'];
}

/**
 * Run the Workbench: host the rooms and show the terminal, in this process. The rooms
 * are active while the terminal runs. When it ends, the person leaves and the rooms stop.
 */
export async function runWorkbench(options: RunOptions): Promise<void> {
	const host = await openWorkbench({ directory: options.directory, stream: options.stream });
	try {
		const identity = options.person
			? host.people.find((person) => person.name === options.person)
			: undefined;
		if (options.person && !identity) {
			const names = host.people.map((person) => person.name).join(', ');
			throw new Error(`Unknown person '${options.person}'. Pick one of ${names}.`);
		}
		const renderer = await openRenderer();
		renderer.setBackgroundColor(palette.bg);
		const app = new WorkbenchTui(renderer, host, identity);
		const stop = () => renderer.destroy();
		process.once('SIGTERM', stop);
		process.once('SIGHUP', stop);
		try {
			await app.run();
		} finally {
			process.off('SIGTERM', stop);
			process.off('SIGHUP', stop);
			await app.leave();
		}
	} finally {
		await host.close();
	}
}
