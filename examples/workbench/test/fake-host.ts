import { people } from '../src/definitions.ts';
import { Session } from '../src/session.ts';
import type {
	ActivationSteps,
	Approval,
	FileContent,
	ProcessView,
	RoomView,
	Workbench,
} from '../src/workbench.ts';

export const view = (name: string, extra: Record<string, unknown> = {}) =>
	({
		name,
		initialized: true,
		goal: `${name} goal`,
		status: 'running',
		activity: [],
		failures: new Map(),
		prompt: `Try ${name}`,
		messages: [],
		scheduled: [],
		participants: [],
		exchanges: [],
		exchange: undefined,
		watermark: 0,
		...extra,
	}) as unknown as RoomView;

/**
 * A host that answers from a table and records each call. A test uses it for
 * what a real host does not let it arrange: a view it writes by hand, a read or
 * a copy it holds open, and a count of the reads and the watches.
 */
export class FakeHost implements Workbench {
	readonly people = people;
	readonly calls: string[] = [];
	readonly table = new Map<string, RoomView>([
		['bringup', view('bringup')],
		['power', view('power')],
	]);
	/** How many times the session read a room. */
	readCount = 0;
	/** While set, a read waits for it. */
	gate: Promise<void> | undefined;
	/** While set, `send` waits for it. */
	sendGate: Promise<void> | undefined;
	/** While set, `attach` waits for it. */
	attachGate: Promise<void> | undefined;
	readonly watching = new Map<string, Set<() => void>>();
	readonly sentRefs: string[][] = [];
	/** The traces the host holds, by activation id. */
	readonly traces = new Map<string, ActivationSteps>();
	pendingApprovals: Approval[] = [];
	/** Every path the session asked the host to read. */
	readonly reads: string[] = [];
	/** The processes the host lists. A cancel moves one to `cancelled`. */
	processTable: ProcessView[] = [];
	readonly processWatchers = new Set<() => void>();
	/** While set, a process list waits for it. */
	processGate: Promise<void> | undefined;
	/** While set, a process list fails with it. */
	processFailure: string | undefined;
	/** The state a cancel gives. `running` stands for a process that did not end in time. */
	cancelState: ProcessView['state'] = 'cancelled';

	async rooms() {
		return [...this.table.values()];
	}
	async read(room: string) {
		this.readCount += 1;
		if (this.gate) await this.gate;
		const found = this.table.get(room);
		if (!found) throw new Error(`No room ${room}`);
		return found;
	}
	watch(room: string, changed: () => void) {
		const listeners = this.watching.get(room) ?? new Set<() => void>();
		listeners.add(changed);
		this.watching.set(room, listeners);
		return () => {
			listeners.delete(changed);
		};
	}
	/** Tell every listener of a room that it changed, as the host does on a room event. */
	notify(room: string): void {
		for (const listener of [...(this.watching.get(room) ?? [])]) listener();
	}
	listeners(room: string): number {
		return this.watching.get(room)?.size ?? 0;
	}
	async join(room: string, who: string) {
		this.calls.push(`join:${room}:${who}`);
	}
	async leave(room: string, who: string) {
		this.calls.push(`leave:${room}:${who}`);
	}
	async send(room: string, who: string, _key: string, text: string, refs?: string[]) {
		this.calls.push(`send:${room}:${who}:${text}`);
		if (this.sendGate) await this.sendGate;
		this.sentRefs.push(refs ?? []);
	}
	async control(room: string) {
		return this.read(room);
	}
	/** What `dismiss` answers: true while the say waits. */
	dismissed = true;
	async dismiss(room: string, handle: number) {
		this.calls.push(`dismiss:${room}:${handle}`);
		return this.dismissed;
	}
	async create(name: string): Promise<RoomView> {
		throw new Error(`The fake host creates no room ${name}.`);
	}
	async activation(_room: string, id: string) {
		this.calls.push(`activation:${id}`);
		return this.traces.get(id);
	}
	async approvals() {
		return this.pendingApprovals;
	}
	async files() {
		return [{ path: '/library/led-5mm.md', size: 797 }];
	}
	async file(path: string): Promise<FileContent> {
		this.reads.push(path);
		return { path, text: `text of ${path}`, truncated: false };
	}
	async attach(localPath: string) {
		this.calls.push(`attach:${localPath}`);
		if (this.attachGate) await this.attachGate;
		return { path: `/attachments/${localPath.split('/').at(-1)}`, size: 42 };
	}
	async processes() {
		const table = [...this.processTable];
		if (this.processGate) await this.processGate;
		if (this.processFailure) throw new Error(this.processFailure);
		return table;
	}
	async processOutput(handle: string) {
		this.reads.push(handle);
		return { handle, text: `output of ${handle}\n`, size: 20, truncated: false };
	}
	async cancelProcess(handle: string) {
		this.calls.push(`cancel:${handle}`);
		this.processTable = this.processTable.map((process) =>
			process.handle === handle ? { ...process, state: this.cancelState } : process,
		);
		const found = this.processTable.find((process) => process.handle === handle);
		if (!found) throw new Error(`No process ${handle}.`);
		return found;
	}
	watchProcesses(changed: () => void) {
		this.processWatchers.add(changed);
		return () => {
			this.processWatchers.delete(changed);
		};
	}
	async labTables() {
		return ['runs', 'results'];
	}
	async labTable(uri: string): Promise<FileContent> {
		this.reads.push(uri);
		return { path: uri, text: `table ${uri}`, truncated: false };
	}
	async close() {}
}

export async function started() {
	const host = new FakeHost();
	const session = new Session(host, people[0], () => {});
	await session.start();
	return { host, session };
}
