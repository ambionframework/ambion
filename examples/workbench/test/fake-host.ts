import { Session } from '../src/session.ts';
import type {
	ActivationRead,
	Approval,
	FileContent,
	FileEntry,
	Person,
	RoomView,
	Workbench,
} from '../src/workbench.ts';

export const person = (name: string, role: string) =>
	({ name, role, identity: name }) as unknown as Person;
export const view = (name: string, extra: Record<string, unknown> = {}) =>
	({
		name,
		initialized: true,
		goal: `${name} goal`,
		status: 'running',
		activity: [],
		prompt: `Try ${name}`,
		messages: [],
		participants: [],
		exchanges: [],
		exchange: undefined,
		watermark: 0,
		...extra,
	}) as unknown as RoomView;

/** A host that records each call and answers from a table. */
export class FakeHost implements Workbench {
	readonly people = [person('mira', 'Hardware lead'), person('theo', 'Firmware engineer')];
	readonly calls: string[] = [];
	readonly table = new Map<string, RoomView>([
		['bringup', view('bringup')],
		['power', view('power')],
	]);
	fileList: FileEntry[] = [
		{ path: '/library/led-5mm.md', size: 797 },
		{ path: '/shared/notes.md', size: 40 },
	];
	failNext: string | undefined;

	private record(call: string): void {
		this.calls.push(call);
		if (this.failNext) {
			const message = this.failNext;
			this.failNext = undefined;
			throw new Error(message);
		}
	}

	async rooms() {
		return [...this.table.values()];
	}
	/** How many times the session read a room. */
	readCount = 0;
	/** While set, a read waits for it. A test uses it to hold a read open. */
	gate: Promise<void> | undefined;
	/** The listeners for each room, as `watch` registered them. */
	readonly watching = new Map<string, Set<() => void>>();

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
		this.record(`join:${room}:${who}`);
	}
	async leave(room: string, who: string) {
		this.record(`leave:${room}:${who}`);
	}
	sentRefs: string[][] = [];
	async send(room: string, who: string, _key: string, text: string, refs?: string[]) {
		this.sentRefs.push(refs ?? []);
		this.record(`send:${room}:${who}:${text}`);
	}
	async control(room: string, action: string) {
		this.record(`control:${room}:${action}`);
		return this.read(room);
	}
	async create(name: string, goal: string) {
		this.record(`create:${name}:${goal}`);
		const created = view(name, { goal });
		this.table.set(name, created);
		return created;
	}
	/** The traces the host holds, by activation id. */
	readonly traces = new Map<string, ActivationRead>();
	pendingApprovals: Approval[] = [];
	async activation(_room: string, id: string) {
		this.calls.push(`activation:${id}`);
		return this.traces.get(id);
	}
	async approvals() {
		return this.pendingApprovals;
	}
	async files() {
		return this.fileList;
	}
	/** Every path the session asked the host to read. */
	readonly reads: string[] = [];
	async file(path: string): Promise<FileContent> {
		this.reads.push(path);
		return { path, text: `text of ${path}`, truncated: false };
	}
	/** Every local path the session asked the host to attach. */
	readonly attached: string[] = [];
	/** While set, `attach` waits for it. A test uses it to hold a copy in flight. */
	attachGate: Promise<void> | undefined;
	async attach(localPath: string): Promise<FileEntry> {
		this.record(`attach:${localPath}`);
		if (this.attachGate) await this.attachGate;
		this.attached.push(localPath);
		const path = `/attachments/${localPath.split('/').at(-1)}`;
		return { path, size: 42 };
	}
	labNames: string[] = ['runs', 'results'];
	async labTables() {
		return this.labNames;
	}
	async labTable(uri: string): Promise<FileContent> {
		this.reads.push(uri);
		return { path: uri, text: `table ${uri}`, truncated: false };
	}
	async close() {
		this.calls.push('close');
	}
}

export async function started(name: string | null = 'mira') {
	const host = new FakeHost();
	let changes = 0;
	const identity = name ? host.people.find((candidate) => candidate.name === name) : undefined;
	const session = new Session(host, identity, () => {
		changes += 1;
	});
	await session.start();
	return { host, session, changes: () => changes };
}
