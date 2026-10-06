/** The canvas lifecycle: which rooms exist, whether each one runs, and their handles. */
import {
	type AgentDefinition,
	AmbionError,
	type PersonDefinition,
	type Room,
	readRoom,
	resumeRoom,
	startRoom,
	type ToolBundle,
} from '@ambionframework/ambion';
import { isName } from '@ambionframework/ambion/names';
import type { RoomMirror } from '@ambionframework/workspace';
import { type ActPort, type Answer, Answers, actOn } from './acts.ts';
import { type BreakoutPort, DEFAULT_PER_OPENER, startOf } from './breakout.ts';
import { Bridge } from './bridge.ts';
import {
	assertNoTeam,
	castOf,
	type Definitions,
	definitionsOf,
	refuse,
	rootStartOf,
} from './cast.ts';
import { EVENT_OPERATION, roomOf } from './events.ts';
import type { CurrentPort } from './port.ts';
import { Queues } from './queue.ts';
import type { CanvasClose, CanvasRoom, CanvasWidget } from './store.ts';
import { openerBundle, workerBundle } from './tools.ts';
import type {
	Canvas,
	CanvasEvent,
	CanvasOperation,
	CanvasRoomOptions,
	OpenCanvasOptions,
	WidgetAct,
	WidgetActResult,
	WidgetOptions,
} from './types.ts';
import { widgetBundle } from './widget-tools.ts';
import { assertCatalog, type WidgetPort } from './widgets.ts';

interface Handle {
	readonly room: Room;
	mirror?: RoomMirror;
	/** Ends the subscription of the bridge to a breakout room. */
	unsubscribe?: () => void;
}

class CanvasRun implements Canvas {
	readonly name: string;
	private readonly options: OpenCanvasOptions;
	private readonly rows = new Map<string, CanvasRoom>();
	private readonly handles = new Map<string, Handle>();
	private readonly queues = new Queues();
	/** The widget calls of one room. A separate queue, so a stop that waits for a call never waits behind one. */
	private readonly widgetQueues = new Queues();
	private readonly revisions = new Map<string, CanvasWidget>();
	private readonly answered = new Answers();
	/** The current revision of each widget, by room and name. */
	private readonly current = new Map<string, Map<string, CanvasWidget>>();
	private readonly bridge: Bridge;
	private readonly listeners = new Set<(event: CanvasEvent) => void>();
	private definitions: Definitions | undefined;
	private resumed = false;
	private ready = false;
	private closed = false;
	private closing: Promise<void> | undefined;
	/** The launch pass of `resume`. `close` waits for it. */
	private resuming: Promise<void> | undefined;
	private readonly port: BreakoutPort;
	private bundles: { opener: ToolBundle; worker: ToolBundle } | undefined;
	private widgetsBundle: ToolBundle | undefined;

	constructor(options: OpenCanvasOptions) {
		this.name = options.name;
		this.options = options;
		assertCatalog(options.widgets?.kinds ?? []);
		this.bridge = this.bridgeOf();
		this.port = this.portOf();
	}

	tools(): ToolBundle {
		return this.toolBundles().opener;
	}

	workerTools(): ToolBundle {
		return this.toolBundles().worker;
	}

	widgetTools(): ToolBundle {
		const kinds = this.options.widgets?.kinds ?? [];
		if (kinds.length === 0)
			throw refuse(
				`The canvas "${this.name}" has no widget kinds. Pass widgets: { kinds } to openCanvas.`,
			);
		this.widgetsBundle ??= widgetBundle(this.widgetPort(kinds));
		return this.widgetsBundle;
	}

	widgets(room: string): readonly CanvasWidget[] {
		return [...(this.current.get(room)?.values() ?? [])].map((widget) => structuredClone(widget));
	}

	revision(id: string): CanvasWidget | undefined {
		const found = this.revisions.get(id);
		return found === undefined ? undefined : structuredClone(found);
	}

	answers(room: string): ReadonlyMap<string, number> {
		return new Map([...this.answered.of(room)].map(([revision, answer]) => [revision, answer.seq]));
	}

	act(person: PersonDefinition, act: WidgetAct): Promise<WidgetActResult> {
		return actOn(this.actPort(), person, act);
	}

	/** What the widget calls of a room share: the readiness, the widget queue, the rows, and the current revisions. */
	private currentPort(): CurrentPort {
		return {
			assertReady: () => this.assertReady(),
			serial: (room, operation) => this.widgetQueues.run(room, operation),
			row: (name) => this.rows.get(name),
			current: (room, name) => this.current.get(room)?.get(name),
		};
	}

	private actPort(): ActPort {
		return {
			...this.currentPort(),
			canvas: this.name,
			revision: (id) => this.revisions.get(id),
			room: (name) => this.handles.get(name)?.room,
			hold: (room, revision, answer) => this.answer(room, revision, answer),
			fail: (room, error) => this.report(room, 'act', error),
		};
	}

	/** Holds the answer, and tells the listeners when the revision had none. */
	private answer(room: string, revision: string, answer: Answer): void {
		if (this.answered.hold(room, revision, answer))
			this.emit({ type: 'answered', room, revision, seq: answer.seq });
	}

	/** What the widget tools read and write: the rows and revisions of this run. */
	private widgetPort(kinds: WidgetOptions['kinds']): WidgetPort {
		return {
			...this.currentPort(),
			kinds,
			widgets: (room) => this.widgets(room),
			answer: (room, revision) => this.answered.of(room).get(revision),
			append: (widget, operation) => this.appendRevision(widget, operation),
		};
	}

	/** Writes the revision, then makes it current, and tells the listeners. */
	private async appendRevision(widget: CanvasWidget, operation: 'show' | 'hide'): Promise<void> {
		await this.guard(widget.room, operation, async () => {
			if ((await this.options.store.appendRevision(widget)) === 'exists')
				throw new Error(`The store holds the revision "${widget.revision}" already.`);
		});
		this.holdRevision(widget);
		this.emit({ type: 'widget', widget: structuredClone(widget) });
	}

	private holdRevision(widget: CanvasWidget): void {
		this.revisions.set(widget.revision, widget);
		const room = this.current.get(widget.room) ?? new Map<string, CanvasWidget>();
		room.set(widget.name, widget);
		this.current.set(widget.room, room);
	}

	private toolBundles(): { opener: ToolBundle; worker: ToolBundle } {
		this.bundles ??= { opener: openerBundle(this.port), worker: workerBundle(this.port) };
		return this.bundles;
	}

	/** What the breakout tools read and write: the rows and handles of this run. */
	private portOf(): BreakoutPort {
		return {
			perOpener: this.options.breakout.perOpener ?? DEFAULT_PER_OPENER,
			team: this.team(),
			assertReady: () => this.assertReady(),
			serial: (name, operation) => this.serial(name, operation),
			ordered: (parent, operation) => this.bridge.order(parent, operation),
			row: (name) => this.rows.get(name),
			rows: () => [...this.rows.values()],
			room: (name) => this.handles.get(name)?.room,
			mirror: (name) => this.handles.get(name)?.mirror?.path,
			create: (row) => this.createBreakout(row),
			complete: (name) => this.completeBreakout(name),
			archive: (name, close) => this.archive(name, close),
		};
	}

	/** The bridge reads the rows and the live handles of this run. */
	private bridgeOf(): Bridge {
		return new Bridge({
			runtime: this.options.runtime,
			row: (name) => this.rows.get(name),
			rows: () => [...this.rows.values()],
			room: (name) => this.handles.get(name)?.room,
			closed: () => this.closed,
			fail: (room, error) => this.report(room, 'notice', error),
		});
	}

	async resume(options: { readonly agents: readonly AgentDefinition[] }): Promise<void> {
		this.assertNotClosed();
		if (this.resumed) throw refuse('The canvas resumed already. It takes its definitions once.');
		const definitions = definitionsOf(options.agents, this.options.breakout.team);
		this.resumed = true;
		try {
			for (const row of await this.options.store.list()) this.rows.set(row.name, row);
			for (const widget of await this.options.store.revisions()) this.holdRevision(widget);
		} catch (error) {
			this.rows.clear();
			this.revisions.clear();
			this.current.clear();
			this.resumed = false;
			throw error;
		}
		this.definitions = definitions;
		this.ready = true;
		this.resuming = this.launchRunning();
		await this.resuming;
	}

	private async launchRunning(): Promise<void> {
		await this.launchAll((row) => row.depth === 0);
		await this.launchAll(
			(row) => row.start.kind === 'breakout' && this.handles.has(row.start.parent),
		);
		for (const row of [...this.rows.values()])
			if (row.depth === 0 && this.handles.has(row.name) && !this.closed)
				await this.bridge.replay(row.name);
	}

	async open(options: CanvasRoomOptions): Promise<Room> {
		this.assertReady();
		if (!isName(options.name)) throw refuse(`"${options.name}" is not a room name.`);
		assertNoTeam(options, this.team());
		return this.serial(options.name, () => this.openRow(options));
	}

	async start(name: string): Promise<void> {
		this.assertReady();
		return this.serial(name, () => this.startRow(name));
	}

	async stop(name: string): Promise<void> {
		this.assertReady();
		return this.serial(name, () => this.stopRow(name));
	}

	async archive(name: string, close: CanvasClose): Promise<CanvasClose> {
		this.assertReady();
		return this.serial(name, () => this.archiveRow(name, close));
	}

	close(): Promise<void> {
		this.closing ??= this.shutdown();
		return this.closing;
	}

	room(name: string): Room | undefined {
		return this.handles.get(name)?.room;
	}

	rooms(): readonly CanvasRoom[] {
		return [...this.rows.values()].map((row) => structuredClone(row));
	}

	subscribe(listener: (event: CanvasEvent) => void): () => void {
		this.listeners.add(listener);
		return () => void this.listeners.delete(listener);
	}

	private assertNotClosed(): void {
		if (this.closed) throw refuse(`The canvas "${this.name}" is closed.`);
	}

	private assertReady(): void {
		this.assertNotClosed();
		if (!this.ready) throw refuse(`The canvas "${this.name}" needs resume first.`);
	}

	private team(): ReadonlySet<string> {
		return new Set(this.options.breakout.team);
	}

	private emit(event: CanvasEvent): void {
		for (const listener of [...this.listeners]) {
			try {
				listener(event);
			} catch (error) {
				this.report(roomOf(event), EVENT_OPERATION[event.type], error);
			}
		}
	}

	private report(room: string, operation: CanvasOperation, error: unknown): void {
		try {
			this.options.onError?.({ room, operation, error });
		} catch {
			// A failing error handler must not break the lifecycle.
		}
	}

	/** Runs the operations on one room name one at a time, in call order. */
	private serial<T>(name: string, operation: () => Promise<T>): Promise<T> {
		return this.queues.run(name, operation);
	}

	/** Reports a failure to `onError`, and throws it again. */
	private async guard<T>(
		name: string,
		operation: CanvasOperation,
		work: () => Promise<T>,
	): Promise<T> {
		try {
			return await work();
		} catch (error) {
			this.report(name, operation, error);
			throw error;
		}
	}

	private row(name: string): CanvasRoom {
		const found = this.rows.get(name);
		if (found === undefined) throw refuse(`The canvas has no room "${name}".`);
		return found;
	}

	private liveRow(name: string): CanvasRoom {
		const found = this.row(name);
		if (found.state === 'archived') throw refuse(`The room "${name}" is archived.`);
		return found;
	}

	private async record(name: string, state: 'running' | 'stopped'): Promise<void> {
		const found = this.liveRow(name);
		if (found.state === state) return;
		await this.options.store.setState(name, state);
		this.rows.set(name, { ...found, state });
	}

	private children(parent: string): CanvasRoom[] {
		return [...this.rows.values()].filter(
			(row) => row.start.kind === 'breakout' && row.start.parent === parent,
		);
	}

	/** Starts or resumes each running row that the filter accepts, and reports each failure. */
	private async launchAll(accept: (row: CanvasRoom) => boolean): Promise<void> {
		const rows = [...this.rows.values()].filter((row) => row.state === 'running' && accept(row));
		for (const row of rows) {
			if (this.closed) return;
			await this.serial(row.name, async () => {
				if (this.closed) return;
				await this.guard(row.name, 'resume', () => this.launch(row.name));
			}).catch(() => {});
		}
	}

	private async openRow(options: CanvasRoomOptions): Promise<Room> {
		const found = this.rows.get(options.name);
		if (found !== undefined) return this.openExisting(found);
		const row: CanvasRoom = {
			name: options.name,
			goal: options.goal,
			depth: 0,
			state: 'running',
			start: rootStartOf(options),
		};
		await this.guard(row.name, 'open', async () => {
			castOf(row, this.requireDefinitions());
			if ((await this.options.store.insert(row)) === 'exists')
				throw refuse(`The canvas has a room "${row.name}" already.`);
			this.rows.set(row.name, row);
		});
		this.emit({ type: 'opened', room: structuredClone(row) });
		return this.guard(row.name, 'open', () => this.launch(row.name));
	}

	private async openExisting(found: CanvasRoom): Promise<Room> {
		if (found.depth !== 0)
			throw refuse(`"${found.name}" is a breakout room. A host opens root rooms.`);
		const live = this.handles.get(found.name);
		if (live !== undefined) return live.room;
		await this.startRow(found.name);
		return this.handleOf(found.name);
	}

	private handleOf(name: string): Room {
		const handle = this.handles.get(name);
		if (handle === undefined) throw refuse(`The room "${name}" is not running.`);
		return handle.room;
	}

	private requireDefinitions(): Definitions {
		if (this.definitions === undefined)
			throw refuse(`The canvas "${this.name}" needs resume first.`);
		return this.definitions;
	}

	private async startRow(name: string): Promise<void> {
		const row = this.liveRow(name);
		if (row.start.kind === 'breakout' && !this.handles.has(row.start.parent))
			throw refuse(`The parent "${row.start.parent}" of "${name}" is not running.`);
		await this.guard(name, 'start', async () => {
			await this.record(name, 'running');
			await this.launch(name);
		});
		if (row.depth === 0) await this.startChildren(name);
		const parent = startOf(row)?.parent ?? name;
		if (!this.closed && this.handles.has(parent)) await this.bridge.replay(parent);
	}

	private async startChildren(parent: string): Promise<void> {
		for (const child of this.children(parent))
			if (child.state === 'running')
				await this.serial(child.name, () =>
					this.guard(child.name, 'start', () => this.launch(child.name)),
				).catch(() => {});
	}

	/** Starts the room from its row, or resumes it from its journal, and attaches its mirror. */
	private async launch(name: string): Promise<Room> {
		this.assertNotClosed();
		const live = this.handles.get(name);
		if (live !== undefined) return live.room;
		const row = this.liveRow(name);
		const handle: Handle = { room: await this.begin(row) };
		this.handles.set(name, handle);
		this.listen(row, handle);
		// A failed read leaves the answers to the next act.
		await this.answered
			.learn(name, handle.room)
			.catch((error: unknown) => this.report(name, 'start', error));
		// A host subscribes to the room on `started`, so the event comes before the mirror and the start post.
		this.emit({ type: 'started', room: name });
		await this.attach(handle);
		await this.postStart(row, handle);
		return handle.room;
	}

	/** A breakout room reports each closed exchange to the bridge, which reads the record. */
	private listen(row: CanvasRoom, handle: Handle): void {
		if (row.start.kind !== 'breakout') return;
		const name = row.name;
		handle.unsubscribe = handle.room.subscribe((event) => {
			if (event.type !== 'exchange_closed' || this.closed) return;
			this.bridge.pass(name).catch((error: unknown) => this.report(name, 'notice', error));
		});
	}

	private async begin(row: CanvasRoom): Promise<Room> {
		const cast = castOf(row, this.requireDefinitions());
		const runtime = this.options.runtime;
		const recorded = await readRoom(row.name, { runtime, messages: false });
		return recorded.initialized
			? resumeRoom(row.name, { agents: cast.members, runtime })
			: startRoom({ ...cast.start, name: row.name, goal: row.goal, runtime });
	}

	/**
	 * A breakout room starts with its first message under the key `breakout-start:<name>`.
	 * A journal that holds the key lands nothing, so each start and each resume posts it. A start
	 * that the room refuses cannot pass on a retry, so the row closes as failed. Any other failure
	 * stops the room, keeps the row running, and the next start posts again.
	 */
	private async postStart(row: CanvasRoom, handle: Handle): Promise<void> {
		const start = row.start;
		if (start.kind !== 'breakout') return;
		try {
			await handle.room.post({
				...(start.to === undefined ? {} : { to: start.to }),
				text: start.message,
				key: `breakout-start:${row.name}`,
			});
		} catch (error) {
			const refused =
				error instanceof AmbionError && error.code !== 'room_stopped' && error.code !== 'stale';
			const closing = refused
				? this.archiveRow(row.name, { result: 'failed', note: error.message })
				: this.release(row.name);
			await closing.catch(() => {});
			throw error;
		}
	}

	/** The mirror is a copy. A failed attach goes to `onError`, and the room runs. */
	private async attach(handle: Handle): Promise<void> {
		const workspace = this.options.workspace;
		if (workspace === undefined) return;
		const name = handle.room.name;
		try {
			handle.mirror = await workspace.mirror(handle.room, {
				onError: (error) => this.report(name, 'mirror', error),
			});
		} catch (error) {
			this.report(name, 'mirror', error);
		}
	}

	/** Stops the room, then its mirror, so the mirror holds the last message. */
	private async release(name: string): Promise<void> {
		const handle = this.handles.get(name);
		if (handle === undefined) return;
		handle.unsubscribe?.();
		try {
			await handle.room.stop();
		} finally {
			this.handles.delete(name);
			// The mirror is a copy: its error goes to `onError`, and the stop error reaches the caller.
			await handle.mirror?.stop().catch((error: unknown) => this.report(name, 'mirror', error));
		}
		this.emit({ type: 'stopped', room: name });
	}

	private async stopRow(name: string): Promise<void> {
		const row = this.liveRow(name);
		await this.guard(name, 'stop', async () => {
			await this.record(name, 'stopped');
			await this.release(name);
		});
		if (row.depth === 0) await this.releaseChildren(name);
	}

	/** A root stops its breakout rooms. Their rows keep their state. */
	private async releaseChildren(parent: string): Promise<void> {
		for (const child of this.children(parent))
			await this.serial(child.name, () =>
				this.guard(child.name, 'stop', () => this.release(child.name)),
			).catch(() => {});
	}

	/** Writes the row of a breakout room, and starts the room with its first message. */
	private async createBreakout(row: CanvasRoom): Promise<void> {
		// The row holds its place at once, so a concurrent call counts it against `perOpener`.
		this.rows.set(row.name, row);
		await this.guard(row.name, 'breakout', async () => {
			try {
				if ((await this.options.store.insert(row)) === 'exists')
					throw refuse(`The canvas has a room "${row.name}" already.`);
			} catch (error) {
				this.rows.delete(row.name);
				throw error;
			}
		});
		this.emit({ type: 'opened', room: structuredClone(row) });
		await this.guard(row.name, 'breakout', () => this.launch(row.name));
	}

	/** Starts a running breakout room that has no live handle. A live handle needs nothing. */
	private async completeBreakout(name: string): Promise<void> {
		if (this.handles.has(name)) return;
		await this.guard(name, 'breakout', () => this.launch(name));
		// A resumed journal can close an exchange before the bridge listens.
		this.bridge.pass(name).catch((error: unknown) => this.report(name, 'notice', error));
	}

	private async archiveRow(name: string, close: CanvasClose): Promise<CanvasClose> {
		const row = this.row(name);
		if (row.depth !== 1) throw refuse(`"${name}" is a root room. Only a breakout room archives.`);
		const recorded = await this.guard(name, 'archive', () =>
			this.options.store.archive(name, close),
		);
		this.rows.set(name, { ...row, state: 'archived', close: recorded });
		await this.guard(name, 'archive', () => this.release(name));
		if (row.state !== 'archived') this.emit({ type: 'archived', room: name, close: recorded });
		return recorded;
	}

	/** Waits for the calls in flight, then stops every handle. Each row keeps its state. */
	private async shutdown(): Promise<void> {
		this.closed = true;
		await this.resuming?.catch(() => {});
		await this.queues.settled();
		await this.widgetQueues.settled();
		await this.bridge.settled();
		for (const name of [...this.handles.keys()])
			await this.guard(name, 'close', () => this.release(name)).catch(() => {});
	}
}

/** Open a canvas over a store. `resume` takes the definitions and starts the rooms that run. */
export function openCanvas(options: OpenCanvasOptions): Canvas {
	if (!isName(options.name)) throw refuse(`"${options.name}" is not a canvas name.`);
	return new CanvasRun(options);
}
