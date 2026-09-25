import type { ExchangeView } from '@ambionframework/ambion';
import { attachCommand, type StagedAttachment } from './attachments.ts';
import { attentionOf, newest, pick } from './attention.ts';
import { FileBrowser } from './browser.ts';
import { type Choices, type Parsed, parse, type Suggestion, suggest } from './commands.ts';
import { dismissCommand } from './dismiss.ts';
import { RoomFeed } from './feed.ts';
import { MAX_GOAL, ROOM_NAME } from './names.ts';
import { holderOf, type Known, labUri, type RefItem, refItems, shows, tableOfUri } from './refs.ts';
import { DONE, errorText, HELP, notesOf, refusal, workingAgents } from './session-text.ts';
import { type ActivationSteps, activationLine, ended, stepsView } from './steps.ts';
import { type Block, buildTimeline } from './timeline.ts';
import type { Approval, FileEntry, Person, RoomAction, RoomView, Workbench } from './workbench.ts';

/** What the terminal does after a command, beyond what the session already changed. */
export type Intent = { type: 'quit' | 'files' | 'processes' } | { type: 'compose'; text: string };

/**
 * Everything the terminal does that is not drawing. It holds who the person is,
 * which room is open, and what that room has said. It talks to the host directly.
 * The terminal draws its state and calls its methods, and calls `changed` back.
 */
export class Session {
	readonly host: Workbench;
	identity: Person | undefined;
	rooms: RoomView[] = [];
	files: FileEntry[] = [];
	/** The tables of the lab database, for the refs that name one. */
	tables: string[] = [];
	/** The seq of the message that a ref jumped to. The terminal highlights it. */
	focus: number | undefined;
	/** The files panel. It searches `files` and loads the chosen one. */
	readonly browser: FileBrowser;
	room = '';
	view: RoomView | undefined;
	blocks: Block[] = [];
	expanded = new Set<string>();
	notice: string | undefined;
	error: string | undefined;
	offline: string | undefined;
	entered = false;
	/** Counts the notices, so the terminal redraws one that repeats. */
	noticeSeq = 0;
	/** The name of a room that waits for its goal. The next submission is the goal. */
	awaitingGoal: string | undefined;
	/** The operations of the open room that wait for an answer. */
	approvals: Approval[] = [];
	/** The activation whose steps the terminal shows. It re-reads on each room change. */
	steps: { id: string; read: ActivationSteps | undefined } | undefined;
	pendingRefs: StagedAttachment[] = [];
	private readonly feed: RoomFeed<RoomView>;
	private readonly changed: () => void;
	private sending = false;
	private wantBottom = false;
	/** True while a read runs. A change during the read sets `pending` for one more read. */
	private refreshing = false;
	private pending = false;
	/** Ends the watch on the open room. The session watches one room at a time. */
	private unwatch: (() => void) | undefined;

	constructor(host: Workbench, identity: Person | undefined, changed: () => void) {
		this.host = host;
		this.identity = identity;
		this.changed = changed;
		this.feed = new RoomFeed<RoomView>(host);
		this.browser = new FileBrowser(
			(path) => (tableOfUri(path) === undefined ? host.file(path) : host.labTable(path)),
			changed,
		);
	}

	/** True once when the conversation should scroll to its end, as after a notice. */
	takeBottom(): boolean {
		const bottom = this.wantBottom;
		this.wantBottom = false;
		return bottom;
	}

	get whoami(): string {
		return this.identity?.name ?? '';
	}

	/** The prompt the composer shows above the input, when the session waits for something. */
	get waiting(): string | undefined {
		return this.awaitingGoal ? `Goal for ${this.awaitingGoal}` : undefined;
	}

	// Reading

	async start(): Promise<void> {
		await this.refreshRooms();
		if (!this.identity) {
			const names = this.host.people.map((person) => person.name).join(', ');
			this.say(`Who are you at the bench? Pick a person: ${names}.`);
			return;
		}
		await this.enterFirstRoom();
	}

	private async enterFirstRoom(): Promise<void> {
		const first = this.rooms.find((room) => room.status === 'running') ?? this.rooms[0];
		if (first) await this.switchRoom(first.name);
	}

	async refreshRooms(): Promise<void> {
		try {
			this.rooms = await this.host.rooms();
			this.files = await this.host.files();
			this.tables = await this.host.labTables();
			this.offline = undefined;
		} catch (error) {
			this.offline = errorText(error);
		}
		this.changed();
	}

	/**
	 * Read the open room. A watch calls this on each change. A change that lands
	 * during a read sets `pending`, so one more read runs after the current one
	 * and no change is lost.
	 */
	async refresh(): Promise<void> {
		if (this.refreshing) {
			this.pending = true;
			return;
		}
		this.refreshing = true;
		try {
			do {
				this.pending = false;
				await this.readOnce();
			} while (this.pending);
		} finally {
			this.refreshing = false;
		}
	}

	private async readOnce(): Promise<void> {
		try {
			const view = await this.feed.refresh();
			if (!view) return;
			this.view = view;
			this.offline = undefined;
			await this.readSide(view.name);
			this.rebuild();
		} catch (error) {
			this.offline = errorText(error);
			this.changed();
		}
	}

	/**
	 * The slow fallback. It reads the room list and the workspace files, which no
	 * room watch reports. It reads the open room only when the room does not run,
	 * because a stopped room records nothing for a watch to report.
	 */
	async poll(): Promise<void> {
		await this.refreshRooms();
		if (this.view?.status !== 'running') await this.refresh();
	}

	/** Read what a room read does not hold: the operations and the open steps. A failure keeps the last answer. */
	private async readSide(room: string): Promise<void> {
		const steps = this.steps;
		const [approvals, read] = await Promise.all([
			this.host.approvals(room).catch(() => undefined),
			steps ? this.host.activation(room, steps.id).catch(() => undefined) : undefined,
		]);
		if (this.room !== room) return;
		if (approvals) this.approvals = approvals;
		if (steps && read && this.steps?.id === steps.id) this.steps = { id: steps.id, read };
	}

	/** What the person owes the room, one line each. It is empty when nothing waits. */
	get attention(): string[] {
		return attentionOf(this.view, this.whoami, this.approvals);
	}

	/** The blocks that follow the closed exchanges: what waits on the person, and the open steps. */
	private tail(view: RoomView): Block[] {
		const blocks = notesOf(this.attention, view);
		const steps = this.steps;
		if (!steps?.read) return blocks;
		const activation = view.exchanges
			.flatMap((exchange) => exchange.activations)
			.find((candidate) => candidate.id === steps.id);
		blocks.push({
			type: 'steps',
			title: activation ? activationLine(activation) : steps.id,
			running: !ended(steps.read),
			passes: stepsView(steps.read),
		});
		return blocks;
	}

	rebuild(): void {
		const view = this.view;
		if (!view) return;
		const activity = view.activity.at(-1);
		this.blocks = buildTimeline({
			messages: this.feed.messages,
			exchanges: view.exchanges,
			open: view.exchange,
			humans: new Set(
				view.participants
					.filter((participant) => participant.kind === 'human')
					.map((participant) => participant.name),
			),
			working: workingAgents(view),
			activity: activity ? `${activity.agent ?? 'room'}: ${activity.text}` : undefined,
			expanded: this.expanded,
			tail: this.tail(view),
		});
		this.changed();
	}

	choices(): Choices {
		return {
			rooms: this.rooms.map((room) => ({
				name: room.name,
				status: room.status,
				working: Boolean(room.exchange),
			})),
			people: this.host.people.map((person) => ({ name: person.name, role: person.role })),
			files: this.files,
			says: this.view?.scheduled ?? [],
		};
	}

	suggestions(input: string): Suggestion[] {
		return suggest(input, this.choices());
	}

	// Saying and failing

	say(text: string): void {
		this.notice = text;
		this.noticeSeq += 1;
		this.wantBottom = true;
		this.rebuild();
		this.changed();
	}

	private fail(error: unknown): void {
		this.error = errorText(error);
		this.changed();
	}

	// The composer's submissions

	/** Handle what the person submitted: a goal, a message, or a command. */
	async submit(text: string): Promise<Intent | undefined> {
		this.error = undefined;
		this.notice = undefined;
		if (this.awaitingGoal) return this.createWithGoal(this.awaitingGoal, text);
		return this.execute(parse(text));
	}

	/** Drop a room that waits for its goal. */
	cancelWaiting(): void {
		if (!this.awaitingGoal) return;
		this.awaitingGoal = undefined;
		this.say('Canceled. No room was created.');
	}

	private async execute(parsed: Parsed): Promise<Intent | undefined> {
		if (parsed.kind === 'message') {
			await this.send(parsed.text);
			return undefined;
		}
		if (parsed.kind === 'unknown') {
			this.say(
				`Unknown command /${parsed.name}. Type / to see the commands, or // to send a slash.`,
			);
			return undefined;
		}
		return this.command(parsed.name, parsed.argument);
	}

	private async command(name: string, argument: string): Promise<Intent | undefined> {
		switch (name) {
			case 'room':
				return void (await this.goTo(argument));
			case 'new':
				return void (await this.newRoom(argument));
			case 'user':
				return void (await this.chooseUser(argument));
			case 'files':
				return this.openFiles();
			case 'open':
				return this.openFile(argument);
			case 'attach':
			case 'dismiss': {
				const done = await (name === 'attach'
					? attachCommand(this.host, this, argument)
					: dismissCommand(this.host, this.view, argument));
				return void ('error' in done ? this.fail(done.error) : this.say(done.notice));
			}
			case 'try':
				if (this.view?.prompt) return { type: 'compose', text: this.view.prompt };
				return void this.say('This room has no suggested question.');
			case 'abort':
			case 'stop':
			case 'resume':
				return void (await this.control(name));
			case 'steps':
				return void (await this.stepsCommand(argument));
			case 'expand':
			case 'collapse':
				return void this.setAllOpen(name === 'expand');
			case 'help':
				return void this.say(HELP);
			default:
				return { type: name === 'ps' ? 'processes' : 'quit' };
		}
	}

	// Rooms

	async switchRoom(name: string): Promise<void> {
		if (name === this.room) return;
		const previous = this.entered ? this.room : '';
		this.room = name;
		this.view = undefined;
		this.blocks = [];
		this.focus = undefined;
		this.expanded.clear();
		this.approvals = [];
		this.steps = undefined;
		this.notice = undefined;
		this.pendingRefs = [];
		this.entered = false;
		this.wantBottom = true;
		this.feed.select(name);
		this.watchRoom();
		if (previous) await this.host.leave(previous, this.whoami).catch(() => {});
		await this.join();
		await this.refresh();
	}

	/** Watch the open room, so a change reads it at once. It replaces an earlier watch. */
	private watchRoom(): void {
		this.unwatch?.();
		this.unwatch = this.host.watch(this.room, () => void this.refresh());
	}

	private async join(): Promise<void> {
		if (!this.identity || !this.room) return;
		try {
			await this.host.join(this.room, this.identity.name);
			this.entered = true;
		} catch (error) {
			this.fail(error);
		}
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

	private async newRoom(argument: string): Promise<void> {
		const [name = '', ...goal] = argument.split(/\s+/).filter(Boolean);
		if (!name) return this.say('Name the room: /new <name> [goal]');
		if (!ROOM_NAME.test(name))
			return this.say(
				'Use a lowercase room name, up to 48 letters, digits, or dashes, starting with a letter.',
			);
		if (this.rooms.some((room) => room.name === name)) return this.say(`${name} already exists.`);
		if (goal.length > 0) return this.createWithGoal(name, goal.join(' '));
		this.awaitingGoal = name;
		this.say(`What is ${name} for? Type its goal and press Enter. Esc cancels.`);
	}

	private async createWithGoal(name: string, goal: string): Promise<undefined> {
		const text = goal.trim();
		if (!text || text.length > MAX_GOAL) {
			this.say(
				`A goal takes 1 to ${MAX_GOAL} characters. Type it and press Enter, or Esc to cancel.`,
			);
			return undefined;
		}
		try {
			await this.host.create(name, text);
			this.awaitingGoal = undefined;
			await this.refreshRooms();
			await this.switchRoom(name);
			this.say(`Created ${name}.`);
		} catch (error) {
			this.awaitingGoal = undefined;
			this.fail(error);
		}
		return undefined;
	}

	// People

	private async chooseUser(argument: string): Promise<void> {
		const names = this.host.people.map((person) => person.name);
		if (!argument) return this.say(`Pick a person: ${names.join(', ')}. Type /user <name>.`);
		const person = this.host.people.find((candidate) => candidate.name === argument.toLowerCase());
		if (!person) return this.say(`No person named ${argument}. Pick one of ${names.join(', ')}.`);
		if (this.identity?.name === person.name) return this.say(`You are already ${person.name}.`);
		if (this.entered && this.identity)
			await this.host.leave(this.room, this.identity.name).catch(() => {});
		this.identity = person;
		this.entered = false;
		if (this.room) {
			await this.join();
			await this.refresh();
		} else {
			await this.enterFirstRoom();
		}
		this.say(`You are ${person.name}, ${person.role.toLowerCase()}.`);
	}

	// Messages and room control

	private async send(text: string): Promise<void> {
		if (!text || this.sending) return;
		if (!this.identity) return this.say('Pick a person first: /user <name>.');
		if (!this.room) return this.say('Open a room first: /room <name>.');
		if (this.view && this.view.status !== 'running')
			return this.fail(new Error(`${this.view.name} is ${this.view.status}. Use /resume first.`));
		this.sending = true;
		const refs = this.pendingRefs.map((one) => one.ref);
		try {
			if (!this.entered) await this.join();
			await this.host.send(this.room, this.identity.name, crypto.randomUUID(), text, refs);
			this.pendingRefs.splice(0, refs.length);
			this.wantBottom = true;
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
			await this.host.control(this.room, action);
			if (action === 'stop') this.entered = false;
			if (action === 'resume') await this.join();
			await this.refresh();
			this.say(DONE[action](this.room));
		} catch (error) {
			this.fail(error);
		}
	}

	// Files

	/** The entries of the files panel: the workspace files, then the tables of the lab database. */
	private get entries(): FileEntry[] {
		return [
			...this.files,
			...this.tables.map((name) => ({ path: labUri(name), size: 0, kind: 'table' as const })),
		];
	}

	private async openFiles(path?: string): Promise<Intent | undefined> {
		try {
			this.files = await this.host.files();
			this.tables = await this.host.labTables();
		} catch (error) {
			this.fail(error);
			return undefined;
		}
		this.browser.show(this.entries, path);
		return { type: 'files' };
	}

	// Refs

	/** What a ref is checked against: the workspace files, the lab tables, and this room. */
	private get known(): Known {
		return {
			room: this.room,
			files: this.files.map((file) => file.path),
			tables: this.tables,
			seqs: new Set(this.feed.messages.map((message) => message.seq)),
		};
	}

	/** The refs of the messages the conversation shows, top to bottom. */
	get refItems(): RefItem[] {
		return refItems(this.blocks, this.known);
	}

	/**
	 * Open a ref. A file or a table opens in the files panel, and the terminal
	 * shows the panel when this returns the intent. A message ref moves the focus
	 * to that message. A ref that does not resolve opens nothing.
	 */
	async openRef(id: string): Promise<Intent | undefined> {
		const target = this.refItems.find((item) => item.id === id)?.resolved.target;
		if (!target) return undefined;
		if (target.kind === 'message') {
			this.jump(target.seq);
			return undefined;
		}
		return this.openFiles(target.kind === 'file' ? target.path : labUri(target.name));
	}

	/** Focus one message. It opens the discussion that holds the message. */
	jump(seq: number): void {
		const holder = holderOf(this.blocks, seq);
		if (holder) this.expanded.add(holder);
		this.focus = seq;
		this.rebuild();
		if (!shows(this.blocks, seq)) {
			this.focus = undefined;
			this.say(`Message ${seq} is not in the conversation. A summary stands for it.`);
		}
	}

	/** Drop the focus that a message ref set. */
	clearFocus(): void {
		if (this.focus === undefined) return;
		this.focus = undefined;
		this.changed();
	}

	private async openFile(argument: string): Promise<Intent | undefined> {
		if (!argument) return this.openFiles();
		const wanted = argument.toLowerCase();
		const matches = this.files.filter(
			(file) => file.path.toLowerCase() === wanted || file.path.toLowerCase() === `/${wanted}`,
		);
		const found = matches[0] ?? this.files.find((file) => file.path.toLowerCase().includes(wanted));
		if (found) return this.openFiles(found.path);
		this.say(`No file matches ${argument}. Type /files to search them.`);
		return undefined;
	}

	// Steps

	private async stepsCommand(argument: string): Promise<void> {
		if (argument === 'off') {
			this.steps = undefined;
			return this.rebuild();
		}
		const exchange = pick(this.view?.exchanges ?? [], argument);
		if (!exchange) return this.say(argument ? `No exchange ${argument}.` : 'No activation yet.');
		return this.showExchange(exchange);
	}

	/** Show the steps of the exchange that a discussion key names. The key is the seq of its question. */
	async showSteps(key: string): Promise<void> {
		const exchange = this.view?.exchanges.find((candidate) => String(candidate.from) === key);
		if (exchange) await this.showExchange(exchange);
	}

	private async showExchange(exchange: ExchangeView): Promise<void> {
		const activation = newest(exchange);
		if (!activation) return this.say('That exchange ran no activation.');
		try {
			const read = await this.host.activation(this.room, activation.id);
			this.steps = { id: activation.id, read };
			this.wantBottom = true;
			this.rebuild();
			if (!read || read.passes.length === 0)
				this.say('The trace of that activation holds no steps.');
		} catch (error) {
			this.fail(error);
		}
	}

	// Discussions

	setAllOpen(open: boolean): void {
		const keys = this.blocks.flatMap((block) => (block.type === 'discussion' ? [block.key] : []));
		this.expanded = new Set(open ? keys : []);
		this.rebuild();
	}

	toggle(key: string): void {
		if (!this.expanded.delete(key)) this.expanded.add(key);
		this.rebuild();
	}

	/** End the person's visit, so the room shows them as gone after the terminal exits. */
	async leave(): Promise<void> {
		this.unwatch?.();
		this.unwatch = undefined;
		if (this.room && this.entered && this.identity)
			await this.host.leave(this.room, this.identity.name).catch(() => {});
	}
}
