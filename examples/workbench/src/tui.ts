import { pathToFileURL } from 'node:url';
import type { Message, ParticipantInfo } from '@ambionframework/ambion';
import {
	BoxRenderable,
	type CliRenderer,
	createCliRenderer,
	InputRenderable,
	InputRenderableEvents,
	ScrollBoxRenderable,
	SelectRenderable,
	SelectRenderableEvents,
	TextRenderable,
} from '@opentui/core';
import { brand, tui as palette } from './brand.ts';
import { type Person, type RoomView, WorkbenchClient } from './client.ts';

const POLL_INTERVAL_MS = 700;

/** Format one message as a single conversation line, or drop it. */
function messageLine(message: Message): string | undefined {
	if (message.kind === 'said' || message.kind === 'summary') {
		const target = message.to === undefined ? '' : ` → ${message.to}`;
		const label = message.kind === 'summary' ? ' (summary)' : '';
		return `${message.from}${target}${label}\n${message.text}`;
	}
	return undefined;
}

/** True when an agent is working in the room. */
function working(participants: readonly ParticipantInfo[]): boolean {
	return participants.some(
		(participant) => participant.kind === 'agent' && participant.status === 'active',
	);
}

function participantNames(participants: readonly ParticipantInfo[]): string {
	return participants.map((participant) => participant.name).join(', ') || 'no one yet';
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The terminal endpoint. It reads and writes the same rooms as the web page. */
class WorkbenchTui {
	private readonly conversation: TextRenderable;
	private readonly scroll: ScrollBoxRenderable;
	private readonly roomBox: BoxRenderable;
	private readonly roomSelect: SelectRenderable;
	private readonly header: TextRenderable;
	private readonly status: TextRenderable;
	private readonly input: InputRenderable;
	private rooms: RoomView[] = [];
	private selected = '';
	private messages: Message[] = [];
	private cursor = 0;
	private statusLine = 'Connecting…';
	private error: string | undefined;
	private sending = false;
	private stopped = false;
	private readonly renderer: CliRenderer;
	private readonly client: WorkbenchClient;
	private readonly identity: Person;

	constructor(renderer: CliRenderer, client: WorkbenchClient, identity: Person) {
		this.renderer = renderer;
		this.client = client;
		this.identity = identity;
		this.header = new TextRenderable(renderer, { content: this.brandLine(), fg: palette.accent });
		this.roomSelect = new SelectRenderable(renderer, {
			options: [],
			flexGrow: 1,
			textColor: palette.muted,
			focusedTextColor: palette.text,
			selectedTextColor: palette.accent,
			showDescription: false,
		});
		this.roomBox = new BoxRenderable(renderer, {
			width: 24,
			border: true,
			borderColor: palette.line,
			title: 'Rooms',
			flexShrink: 0,
		});
		this.scroll = new ScrollBoxRenderable(renderer, {
			flexGrow: 1,
			stickyScroll: true,
			stickyStart: 'bottom',
			scrollY: true,
		});
		this.conversation = new TextRenderable(renderer, { content: 'Loading…', fg: palette.text });
		this.status = new TextRenderable(renderer, { content: this.statusLine, fg: palette.muted });
		this.input = new InputRenderable(renderer, {
			placeholder: 'Message the room…',
			maxLength: 2_000,
		});
		this.build();
	}

	private brandLine(): string {
		return `${brand.name} ${brand.product} — ${brand.tagline}`;
	}

	private build(): void {
		const root = new BoxRenderable(this.renderer, {
			flexDirection: 'column',
			width: '100%',
			height: '100%',
			padding: 1,
			gap: 1,
		});
		const body = new BoxRenderable(this.renderer, { flexDirection: 'row', flexGrow: 1, gap: 1 });
		const main = new BoxRenderable(this.renderer, {
			flexDirection: 'column',
			flexGrow: 1,
			gap: 1,
		});
		this.roomBox.add(this.roomSelect);
		this.scroll.add(this.conversation);
		main.add(this.scroll);
		main.add(this.status);
		main.add(this.input);
		body.add(this.roomBox);
		body.add(main);
		root.add(this.header);
		root.add(body);
		this.renderer.root.add(root);
		this.wire();
	}

	private wire(): void {
		this.input.on(InputRenderableEvents.ENTER, () => void this.sendCurrent());
		this.roomSelect.on(SelectRenderableEvents.ITEM_SELECTED, () => {
			const option = this.roomSelect.getSelectedOption();
			if (option && typeof option.value === 'string') void this.switchRoom(option.value);
		});
		this.renderer.keyInput.on('keypress', (key) => {
			if (key.name === 'tab') this.toggleFocus();
		});
		this.input.focus();
	}

	private toggleFocus(): void {
		if (this.input.focused) {
			this.input.blur();
			this.roomSelect.focus();
		} else {
			this.roomSelect.blur();
			this.input.focus();
		}
	}

	/** Load the rooms, enter one, and start polling. */
	async start(): Promise<void> {
		this.rooms = await this.client.rooms();
		this.roomSelect.options = this.rooms.map((room) => ({
			name: room.name,
			description: room.status,
			value: room.name,
		}));
		const first = this.rooms.find((room) => room.status === 'running') ?? this.rooms[0];
		if (first) await this.switchRoom(first.name);
		this.renderStatus();
	}

	private async switchRoom(name: string): Promise<void> {
		if (name === this.selected) return;
		const previous = this.selected;
		this.selected = name;
		this.messages = [];
		this.cursor = 0;
		this.error = undefined;
		if (previous) await this.client.leave(previous, this.identity.name).catch(() => {});
		await this.enter(name);
		await this.refresh();
	}

	private async enter(name: string): Promise<void> {
		try {
			await this.client.join(name, this.identity.name);
		} catch (error) {
			this.error = errorText(error);
		}
	}

	private async sendCurrent(): Promise<void> {
		const text = this.input.value.trim();
		if (text === '' || this.sending || this.stopped) return;
		this.sending = true;
		this.error = undefined;
		try {
			await this.client.send(this.selected, this.identity.name, crypto.randomUUID(), text);
			this.input.value = '';
			this.statusLine = 'Working…';
			this.renderStatus();
			await this.refresh();
		} catch (error) {
			this.error = errorText(error);
			this.renderStatus();
		} finally {
			this.sending = false;
		}
	}

	private async refresh(): Promise<void> {
		if (this.stopped || !this.selected) return;
		try {
			const view = await this.client.read(this.selected, this.cursor);
			this.apply(view);
		} catch (error) {
			this.error = errorText(error);
			this.renderStatus();
		}
	}

	private apply(view: RoomView): void {
		const incoming = view.messages ?? [];
		if (incoming.length > 0) {
			this.messages = [...this.messages, ...incoming];
			this.cursor = this.messages.at(-1)?.seq ?? this.cursor;
		}
		this.statusLine = working(view.participants) ? 'Working…' : 'Ready';
		this.roomBox.title = view.name;
		this.renderConversation();
		this.renderHeader(view);
		this.renderStatus();
	}

	private renderConversation(): void {
		const lines = this.messages.flatMap((message) => {
			const line = messageLine(message);
			return line === undefined ? [] : [line];
		});
		this.conversation.content = lines.join('\n\n') || 'Ask the room a question.';
		this.renderer.requestRender();
	}

	private renderHeader(view: RoomView): void {
		this.header.content = `${this.brandLine()}  ·  as ${this.identity.name}  ·  ${participantNames(view.participants)}`;
	}

	private renderStatus(): void {
		this.status.content =
			this.error === undefined
				? `${this.statusLine}  ·  Tab switches focus  ·  Enter sends  ·  Ctrl-C exits`
				: `Error: ${this.error}`;
		this.status.fg = this.error === undefined ? palette.muted : palette.red;
		this.renderer.requestRender();
	}

	/** Run until the renderer is destroyed. */
	async run(): Promise<void> {
		const timer = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
		await new Promise<void>((resolve) => {
			this.renderer.once('destroy', () => {
				this.stopped = true;
				clearInterval(timer);
				resolve();
			});
			void this.start().catch((error) => {
				this.error = errorText(error);
				this.renderStatus();
			});
		});
	}
}

function pickIdentity(people: readonly Person[], requested: string | undefined): Person {
	const match = requested ? people.find((person) => person.name === requested) : undefined;
	const person = match ?? people[0];
	if (!person) throw new Error('The Workbench offered no people.');
	return person;
}

/** Connect to a running Workbench and open the terminal endpoint. */
export async function runWorkbenchTui(baseUrl: string, requestedPerson?: string): Promise<void> {
	const client = new WorkbenchClient(baseUrl);
	const people = await client.people();
	const identity = pickIdentity(people, requestedPerson);
	const renderer = await createCliRenderer({ exitOnCtrlC: true, targetFps: 30 });
	renderer.setBackgroundColor(palette.bg);
	const app = new WorkbenchTui(renderer, client, identity);
	await app.run();
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
