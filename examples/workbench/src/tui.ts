import { pathToFileURL } from 'node:url';
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
import { type Person, type RoomAction, type RoomView, WorkbenchClient } from './client.ts';
import { type Parsed, parse, type RoomChoice, type Suggestion, suggest } from './commands.ts';
import { Composer } from './composer.ts';
import { RoomFeed } from './feed.ts';
import { type Block, buildTimeline, discussionKeys } from './timeline.ts';
import { Transcript } from './transcript.ts';

const POLL_MS = 700;
const ROOMS_MS = 4_000;

const HELP = [
	'Commands',
	'  /room <name>   switch to another room. Ctrl+R lists the rooms.',
	'  /abort         cancel the open exchange in this room',
	'  /stop          stop the room. /resume starts it again.',
	'  /expand        open every discussion. /collapse closes them.',
	'  /quit          leave the terminal',
	'Keys',
	'  Enter sends. Ctrl+J, Alt+Enter, and Shift+Enter add a line.',
	'  Tab browses the discussions. Up and Down choose, Enter opens or closes,',
	'  e opens all, c closes all, and Esc goes back to the composer.',
	'  PageUp and PageDown scroll. Start a message with // to send a leading slash.',
].join('\n');

const HINTS = {
	compose: 'Enter sends   Ctrl+J newline   / commands   Ctrl+R rooms   Tab discussions',
	browse: 'Up/Down choose   Enter open or close   e open all   c close all   Esc back',
} as const;

/** How far each browse key moves the selection. */
const BROWSE_STEP: Record<string, number> = { up: -1, k: -1, down: 1, j: 1 };

const DONE: Record<RoomAction, (room: string) => string> = {
	abort: (room) => `Aborted the open exchange in ${room}.`,
	stop: (room) => `Stopped ${room}. Use /resume to start it again.`,
	resume: (room) => `Resumed ${room}.`,
};

const workingAgents = (view: RoomView | undefined): string[] =>
	(view?.participants ?? []).flatMap((participant: ParticipantInfo) =>
		participant.kind === 'agent' && participant.status === 'active' ? [participant.name] : [],
	);

const errorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/** What an empty room shows, with the room's suggested first question. */
function emptyText(view: RoomView): string {
	const start = 'Nothing here yet. Ask a question below, or type / for commands.';
	return view.prompt ? `${start}\nTry: ${view.prompt}` : start;
}

/** The reason an action does not apply to the room, or undefined when it does. */
function refusal(action: RoomAction, view: RoomView | undefined): string | undefined {
	if (!view) return 'No room is open.';
	if (action === 'abort') {
		if (view.status !== 'running') return `${view.name} is not running. Use /resume first.`;
		return view.exchange ? undefined : `Nothing to abort. ${view.name} has no open exchange.`;
	}
	if (action === 'stop')
		return view.status === 'stopped' ? `${view.name} is already stopped.` : undefined;
	return view.status === 'running' ? `${view.name} is already running.` : undefined;
}

/** The terminal endpoint. It reads and writes the same rooms as the web page. */
class WorkbenchTui {
	private readonly renderer: CliRenderer;
	private readonly client: WorkbenchClient;
	private readonly identity: Person;
	private readonly feed: RoomFeed;
	private readonly transcript: Transcript;
	private readonly composer: Composer;
	private readonly header: TextRenderable;
	private rooms: RoomView[] = [];
	private room = '';
	private view: RoomView | undefined;
	private blocks: Block[] = [];
	private expanded = new Set<string>();
	private mode: 'compose' | 'browse' = 'compose';
	private browsing: string | undefined;
	private notice: string | undefined;
	private error: string | undefined;
	private offline: string | undefined;
	private suggestions: Suggestion[] = [];
	private pick = 0;
	private dismissed = false;
	private entered = false;
	private sending = false;
	private stopped = false;
	private drawn = '';
	private reveal: string | undefined;
	private toBottom = false;

	constructor(renderer: CliRenderer, client: WorkbenchClient, identity: Person) {
		this.renderer = renderer;
		this.client = client;
		this.identity = identity;
		this.feed = new RoomFeed(client);
		this.header = new TextRenderable(renderer, { content: '', flexShrink: 0 });
		this.transcript = new Transcript(renderer);
		this.composer = new Composer(renderer, {
			submit: () => void this.onSubmit(),
			change: () => this.onChange(),
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
		root.add(this.transcript.root);
		root.add(this.composer.root);
		renderer.root.add(root);
		renderer.keyInput.on('keypress', (key: KeyEvent) => this.onKey(key));
		this.composer.focus();
		this.renderHeader();
		this.renderStatus();
	}

	/** Run until the renderer is destroyed. */
	async run(): Promise<void> {
		const timers = [
			setInterval(() => void this.refresh(), POLL_MS),
			setInterval(() => void this.refreshRooms(), ROOMS_MS),
		];
		await new Promise<void>((resolve) => {
			this.renderer.once('destroy', () => {
				this.stopped = true;
				for (const timer of timers) clearInterval(timer);
				resolve();
			});
			void this.start().catch((error) => this.fail(error));
		});
	}

	/** End the person's visit, so the room shows them as gone after the terminal exits. */
	async leave(): Promise<void> {
		if (this.room && this.entered)
			await this.client.leave(this.room, this.identity.name).catch(() => {});
	}

	private async start(): Promise<void> {
		await this.refreshRooms();
		const first = this.rooms.find((room) => room.status === 'running') ?? this.rooms[0];
		if (first) await this.switchRoom(first.name);
	}

	// Rooms and reads

	private async refreshRooms(): Promise<void> {
		if (this.stopped) return;
		try {
			this.rooms = await this.client.rooms();
			this.offline = undefined;
			this.onChange();
		} catch (error) {
			this.offline = errorText(error);
			this.renderStatus();
		}
	}

	private async refresh(): Promise<void> {
		if (this.stopped) return;
		try {
			const view = await this.feed.refresh();
			if (!view) return;
			this.view = view;
			this.offline = undefined;
			this.rebuild();
		} catch (error) {
			this.offline = errorText(error);
			this.renderStatus();
		}
	}

	private async switchRoom(name: string): Promise<void> {
		if (name === this.room) return;
		const previous = this.entered ? this.room : '';
		this.room = name;
		this.view = undefined;
		this.blocks = [];
		this.expanded.clear();
		this.exitBrowse();
		this.notice = undefined;
		this.entered = false;
		this.feed.select(name);
		this.toBottom = true;
		if (previous) await this.client.leave(previous, this.identity.name).catch(() => {});
		await this.join();
		await this.refresh();
	}

	private async join(): Promise<void> {
		try {
			await this.client.join(this.room, this.identity.name);
			this.entered = true;
		} catch (error) {
			this.fail(error);
		}
	}

	// Drawing

	private rebuild(): void {
		const view = this.view;
		if (!view) return;
		this.blocks = buildTimeline({
			messages: this.feed.messages,
			exchanges: view.exchanges ?? [],
			open: view.exchange,
			humans: new Set(
				view.participants
					.filter((participant) => participant.kind === 'human')
					.map((participant) => participant.name),
			),
			working: workingAgents(view),
			expanded: this.expanded,
		});
		const keys = discussionKeys(this.blocks);
		if (this.browsing && !keys.includes(this.browsing)) this.browsing = keys.at(-1);
		const selected = this.mode === 'browse' ? this.browsing : undefined;
		const empty = this.blocks.length === 0 && !this.notice;
		const shown = empty ? emptyText(view) : this.notice;
		const signature = JSON.stringify([this.blocks, selected, shown]);
		if (signature !== this.drawn) {
			this.drawn = signature;
			this.transcript.render(this.blocks, selected, shown, this.reveal, this.toBottom);
		}
		this.reveal = undefined;
		this.toBottom = false;
		this.composer.setRoom(view.name, Boolean(view.exchange));
		this.renderHeader();
		this.renderStatus();
	}

	private renderHeader(): void {
		const role = (this.identity.role ?? 'guest').toLowerCase();
		const chunks = [
			fg(palette.accent)(`${brand.name} ${brand.product}`),
			fg(palette.muted)(`   as ${this.identity.name}, ${role}\n`),
		];
		for (const participant of this.view?.participants ?? []) {
			const active = participant.kind === 'agent' && participant.status === 'active';
			const here = participant.kind === 'human' && participant.presence === 'present';
			const color = active ? palette.coral : here ? palette.green : palette.dim;
			chunks.push(fg(color)(`${participant.name}  `));
		}
		this.header.content = new StyledText(chunks);
	}

	private renderStatus(): void {
		this.composer.setStatus(new StyledText(this.statusChunks()));
		// An error needs the whole row, and a narrow terminal has no room for the hints.
		const roomy = this.transcript.root.width >= 96;
		this.composer.setHints(this.error || this.offline || !roomy ? '' : HINTS[this.mode]);
	}

	private statusChunks() {
		if (this.error) return [fg(palette.red)(`Error: ${this.error}`)];
		if (this.offline) return [fg(palette.red)(`Cannot reach the Workbench: ${this.offline}`)];
		const view = this.view;
		if (!view) return [fg(palette.muted)('Connecting…')];
		if (view.status !== 'running')
			return [fg(palette.muted)(`${view.name} is ${view.status}. Use /resume.`)];
		if (view.exchange)
			return [fg(palette.coral)('● '), fg(palette.muted)('A new message steers the open exchange')];
		return [fg(palette.green)('● '), fg(palette.muted)('Ready')];
	}

	// The composer

	private roomChoices(): RoomChoice[] {
		return this.rooms.map((room) => ({
			name: room.name,
			status: room.status,
			working: Boolean(room.exchange),
		}));
	}

	private onChange(): void {
		this.suggestions = this.dismissed ? [] : suggest(this.composer.text, this.roomChoices());
		this.pick = Math.min(this.pick, Math.max(0, this.suggestions.length - 1));
		this.composer.setPalette(this.suggestions, this.pick);
	}

	private async onSubmit(): Promise<void> {
		const row = this.suggestions[this.pick];
		if (row && !row.run) {
			this.composer.setText(row.insert);
			return;
		}
		await this.execute(parse(row ? row.insert : this.composer.text));
	}

	private async execute(parsed: Parsed): Promise<void> {
		this.error = undefined;
		this.notice = undefined;
		if (parsed.kind === 'message') return this.send(parsed.text);
		this.composer.setText('');
		if (parsed.kind === 'unknown') {
			this.say(
				`Unknown command /${parsed.name}. Type / to see the commands, or // to send a slash.`,
			);
			return;
		}
		await this.command(parsed.name, parsed.argument);
	}

	private async command(name: string, argument: string): Promise<void> {
		switch (name) {
			case 'room':
				return this.goTo(argument);
			case 'abort':
			case 'stop':
			case 'resume':
				return this.control(name);
			case 'expand':
			case 'collapse':
				return this.setAllOpen(name === 'expand');
			case 'help':
				return this.say(HELP);
			default:
				return this.renderer.destroy();
		}
	}

	private say(text: string): void {
		this.notice = text;
		this.toBottom = true;
		this.drawn = '';
		this.rebuild();
	}

	private async goTo(name: string): Promise<void> {
		const found = this.rooms.find((room) => room.name.toLowerCase() === name.toLowerCase());
		if (found) return this.switchRoom(found.name);
		this.say(
			name
				? `No room named ${name}. Press Ctrl+R to see the rooms.`
				: 'Name a room, or press Ctrl+R.',
		);
	}

	private async send(text: string): Promise<void> {
		if (!text || this.sending || !this.room) return;
		if (this.view && this.view.status !== 'running')
			return this.fail(new Error(`${this.view.name} is ${this.view.status}. Use /resume first.`));
		this.sending = true;
		try {
			if (!this.entered) await this.join();
			await this.client.send(this.room, this.identity.name, crypto.randomUUID(), text);
			this.composer.setText('');
			this.toBottom = true;
			await this.refresh();
		} catch (error) {
			this.fail(error);
		} finally {
			this.sending = false;
		}
	}

	private async control(action: RoomAction): Promise<void> {
		const reason = refusal(action, this.view);
		if (reason) return this.say(reason);
		try {
			await this.client.control(this.room, action);
			if (action === 'stop') this.entered = false;
			if (action === 'resume') await this.join();
			this.notice = DONE[action](this.room);
			await this.refresh();
			this.rebuild();
		} catch (error) {
			this.fail(error);
		}
	}

	private fail(error: unknown): void {
		this.error = errorText(error);
		this.renderStatus();
	}

	// Discussions

	private setAllOpen(open: boolean): void {
		this.expanded = new Set(open ? discussionKeys(this.blocks) : []);
		// Opening everything grows the content above the selection, so keep it in view.
		if (this.mode === 'browse') this.reveal = this.browsing;
		this.rebuild();
	}

	private toggle(key: string): void {
		if (!this.expanded.delete(key)) this.expanded.add(key);
		this.reveal = key;
		this.rebuild();
	}

	private enterBrowse(): void {
		const keys = discussionKeys(this.blocks);
		if (keys.length === 0) {
			this.say('No discussions to browse yet.');
			return;
		}
		this.mode = 'browse';
		this.browsing = this.browsing && keys.includes(this.browsing) ? this.browsing : keys.at(-1);
		this.composer.blur();
		this.reveal = this.browsing;
		this.rebuild();
	}

	private exitBrowse(): void {
		if (this.mode === 'compose') return;
		this.mode = 'compose';
		this.composer.focus();
		this.rebuild();
	}

	private move(step: number): void {
		const keys = discussionKeys(this.blocks);
		const at = this.browsing ? keys.indexOf(this.browsing) : -1;
		this.browsing = keys[Math.max(0, Math.min(keys.length - 1, at + step))];
		this.reveal = this.browsing;
		this.rebuild();
	}

	// Keys

	private onKey(key: KeyEvent): void {
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
			return;
		}
		if (key.name === 'tab') {
			key.preventDefault();
			if (this.suggestions.length > 0) this.complete();
			else this.enterBrowse();
			return;
		}
		if (this.suggestions.length > 0) this.paletteKey(key);
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
			this.onChange();
		}
	}

	private complete(): void {
		const row = this.suggestions[this.pick];
		if (row) this.composer.setText(row.insert);
	}
}

function pickIdentity(people: readonly Person[], requested: string | undefined): Person {
	const match = requested ? people.find((person) => person.name === requested) : undefined;
	const person = match ?? people[0];
	if (!person) throw new Error('The Workbench offered no people.');
	return person;
}

/** OpenTUI draws through Node's FFI, which Node enables only with a flag. */
async function openRenderer(): Promise<CliRenderer> {
	try {
		return await createCliRenderer({ exitOnCtrlC: true, targetFps: 30 });
	} catch (error) {
		const detail = errorText(error);
		if (!/FFI/i.test(detail)) throw error;
		throw new Error(
			`${detail}\nStart the terminal with \`pnpm tui\`. It passes --experimental-ffi to Node.`,
		);
	}
}

/** Connect to a running Workbench and open the terminal endpoint. */
export async function runWorkbenchTui(baseUrl: string, requestedPerson?: string): Promise<void> {
	const client = new WorkbenchClient(baseUrl);
	const people = await client.people();
	const identity = pickIdentity(people, requestedPerson);
	const renderer = await openRenderer();
	renderer.setBackgroundColor(palette.bg);
	const app = new WorkbenchTui(renderer, client, identity);
	await app.run();
	await app.leave();
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
	const baseUrl = process.argv[2] ?? process.env.WORKBENCH_URL ?? 'http://127.0.0.1:3000';
	const person = process.argv[3] ?? process.env.WORKBENCH_USER;
	await runWorkbenchTui(baseUrl, person).catch((error: unknown) => {
		console.error(errorText(error));
		process.exitCode = 1;
	});
}
