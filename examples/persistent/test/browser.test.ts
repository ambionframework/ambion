import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

interface Delivery {
	room: string;
	human: string;
	key: string;
	text: string;
	blocked?: boolean;
}
interface BrowserApp {
	state: {
		rooms: BrowserRoom[];
		taskExchange: string;
		selectedTask: { room: string; id: string } | null;
		taskRead: unknown;
		human: string;
		selected: string;
		entryState: 'restoring' | 'entered' | 'required';
		bootPromise: Promise<void> | null;
		navigating: boolean;
		outbox: Delivery[];
		pollPromise: Promise<void> | null;
		messages: Map<string, unknown[]>;
	};
	flushOutbox(): Promise<void>;
	restoreSelection(): Promise<void>;
	reenterRoom(): Promise<void>;
	poll(full?: boolean): Promise<void> | undefined;
	renderTimeline(): void;
	renderTasks(): void;
	renderHeader(): void;
	inspectTask(task: { id: string }): void;
	createRoom(): Promise<void>;
	switchUser(): Promise<void>;
}

interface BrowserRoom {
	name: string;
	status: string;
	participants: unknown[];
	messages?: unknown[];
	exchanges?: unknown[];
	[key: string]: unknown;
}

interface MockQuery {
	textContent: string;
	disabled: boolean;
}

interface MockElement {
	value: string;
	textContent: string;
	dataset: Record<string, string>;
	style: Record<string, string>;
	className: string;
	type: string;
	disabled: boolean;
	title: string;
	open?: boolean;
	childElementCount: number;
	children: MockElement[];
	classList: { toggle(...args: unknown[]): void };
	listeners: Map<string, (event: unknown) => void>;
	append(...items: MockElement[]): void;
	replaceChildren(...items: MockElement[]): void;
	addEventListener(name: string, listener: (event: unknown) => void): void;
	focus(): void;
	querySelector(): MockQuery;
}

/** Keep the real script and requests. Replace only browser DOM and storage ports. */
function browser(fetch_: typeof fetch, runStartup = false) {
	const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
	const script = html.split('<script>')[1]?.split('</script>')[0];
	if (!script) throw new Error('The browser script is missing.');
	const boot = script.lastIndexOf('\n\t\t\t\trenderDraft();');
	if (boot < 0) throw new Error('The browser startup is missing.');
	const elements = new Map<string, ReturnType<typeof element>>();
	const getElementById = (id: string) => {
		let found = elements.get(id);
		if (!found) {
			found = element();
			elements.set(id, found);
		}
		return found;
	};
	const storage = new Map<string, string>();
	const store = {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => {
			storage.set(key, value);
		},
		removeItem: (key: string) => {
			storage.delete(key);
		},
	};
	const source = runStartup
		? script.replace(
				/\n\t\t\t\}\)\(\);\s*$/,
				'\nreturn {state, flushOutbox, restoreSelection, reenterRoom, poll, renderTimeline, renderTasks, renderHeader, inspectTask, createRoom, switchUser}; })();',
			)
		: `${script.slice(0, boot)}\nreturn {state, flushOutbox, restoreSelection, reenterRoom, poll, renderTimeline, renderTasks, renderHeader, inspectTask, createRoom, switchUser}; })();`;
	const app = runInNewContext(source, {
		document: { getElementById, createElement: element },
		location: { origin: 'http://localhost:3000' },
		crypto,
		AbortController,
		AbortSignal,
		localStorage: store,
		sessionStorage: store,
		fetch: fetch_,
		setTimeout: () => 0,
		clearTimeout: () => {},
		setInterval: () => 0,
	}) as BrowserApp;
	Object.assign(app.state, {
		rooms: [{ name: 'delivery', status: 'running', participants: [] }],
		human: 'alice',
		selected: 'delivery',
		entryState: 'entered',
	});
	return { app, getElementById };
}
function element(): MockElement {
	const children: MockElement[] = [];
	const listeners = new Map<string, (event: unknown) => void>();
	return {
		value: '',
		textContent: '',
		dataset: {},
		style: {},
		className: '',
		type: '',
		disabled: false,
		title: '',
		get childElementCount() {
			return children.length;
		},
		children,
		classList: { toggle() {} },
		append(...items: MockElement[]) {
			children.push(...items);
		},
		replaceChildren(...items: MockElement[]) {
			children.splice(0, children.length, ...items);
		},
		addEventListener(name: string, listener: (event: unknown) => void) {
			listeners.set(name, listener);
		},
		listeners,
		focus() {},
		querySelector: () => ({ textContent: '', disabled: false }),
	};
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const delivery = (): Delivery => ({
	room: 'delivery',
	human: 'alice',
	key: 'saved-key',
	text: 'Keep this exact text.',
});
const deliveryRoom = (present: boolean) => [
	{
		name: 'delivery',
		status: 'running',
		participants: present ? [{ name: 'alice', presence: 'present' }] : [],
	},
];
const recordedRoom = (exchanges: unknown[], messages: unknown[] = [], watermark = 0) => ({
	name: 'delivery',
	initialized: true,
	goal: 'Keep work moving.',
	status: 'running',
	watermark,
	participants: [{ kind: 'human', name: 'alice', presence: 'present' }],
	exchanges,
	exchange: exchanges.find((exchange) => (exchange as { status?: string }).status === 'open'),
	messages,
});
const said = (seq: number, from: string, text: string) => ({
	kind: 'said',
	seq,
	from,
	text,
	at: `2026-09-16T00:00:0${seq}.000Z`,
});
const textOf = (element: MockElement): string =>
	element.textContent || element.children.map((child) => textOf(child)).join('');
const closed = (from: number, through: number, summary: unknown) => ({
	status: 'closed',
	owner: 'alice',
	from,
	through,
	at: '2026-09-16T00:00:00.000Z',
	summary,
});

describe('browser delivery and navigation', () => {
	it('keeps polling read-only after another tab ends the shared presence', async () => {
		const fetch_ = vi.fn<typeof fetch>(async (url) => {
			if (url === '/rooms')
				return response([{ name: 'delivery', status: 'running', participants: [] }]);
			if (url === '/people') return response([{ name: 'alice' }]);
			return response({ ...recordedRoom([]), participants: [] });
		});
		const { app } = browser(fetch_);
		await app.state.pollPromise;
		await app.poll();
		expect(fetch_.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
		expect(app.state.entryState).toBe('required');
	});

	it('restores a saved selection once during the deliberate initial reload', async () => {
		const fetch_ = vi.fn<typeof fetch>(async (url, init) => {
			if (url === '/rooms')
				return response([{ name: 'delivery', status: 'running', participants: [] }]);
			if (url === '/people') return response([{ name: 'alice' }]);
			if (url === '/rooms/delivery/humans/alice' && init?.method === 'PUT')
				return response({ joined: 'alice' });
			return response(recordedRoom([]));
		});
		const { app } = browser(fetch_);
		Object.assign(app.state, { entryState: 'restoring' });
		await app.state.pollPromise;
		await app.restoreSelection();
		await app.poll();
		expect(fetch_.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
	});

	it('runs saved selection restoration from the real browser startup', async () => {
		const fetch_ = vi.fn<typeof fetch>(async (url, init) => {
			if (url === '/rooms')
				return response([{ name: 'delivery', status: 'running', participants: [] }]);
			if (url === '/people') return response([{ name: 'alice' }]);
			if (url === '/rooms/delivery/humans/alice' && init?.method === 'PUT')
				return response({ joined: 'alice' });
			return response(recordedRoom([]));
		});
		const { app } = browser(fetch_, true);
		app.state.human = 'alice';
		app.state.selected = 'delivery';
		app.state.entryState = 'restoring';
		await app.state.bootPromise;
		expect(fetch_.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
	});

	it('re-enters deliberately before retrying the same queued delivery', async () => {
		let present = false;
		const fetch_ = vi.fn<typeof fetch>(async (url, init) => {
			if (url === '/rooms') return response(deliveryRoom(present));
			if (url === '/people') return response([{ name: 'alice' }]);
			if (url === '/rooms/delivery/humans/alice' && init?.method === 'PUT') {
				present = true;
				return response({ joined: 'alice' });
			}
			if (url === '/rooms/delivery/humans/alice' && init?.method === 'POST')
				return response({ from: 4 });
			return response(recordedRoom([]));
		});
		const { app } = browser(fetch_);
		Object.assign(app.state, { entryState: 'required' });
		await app.state.pollPromise;
		const item = delivery();
		app.state.outbox.push(item);
		await app.reenterRoom();
		expect(fetch_.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
		expect(fetch_.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
		expect(JSON.parse(String(fetch_.mock.calls.at(-1)?.[1]?.body))).toEqual({
			key: item.key,
			text: item.text,
		});
		expect(app.state.outbox).toEqual([]);
	});

	it('keeps a presence rejection latched across a stale present poll', async () => {
		const fetch_ = vi.fn<typeof fetch>(async (url, init) => {
			if (url === '/rooms')
				return response([
					{
						name: 'delivery',
						status: 'running',
						participants: [{ name: 'alice', presence: 'present' }],
					},
				]);
			if (url === '/people') return response([{ name: 'alice' }]);
			if (url === '/rooms/delivery/humans/alice' && init?.method === 'POST')
				return response({ error: 'Enter this room before sending.' }, 409);
			return response(recordedRoom([]));
		});
		const { app } = browser(fetch_);
		Object.assign(app.state, { entryState: 'entered' });
		await app.state.pollPromise;
		const item = delivery();
		app.state.outbox.push(item);
		await app.flushOutbox();
		await app.poll();
		expect(fetch_.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
		expect(app.state.outbox).toEqual([item]);
		expect(app.state.entryState).toBe('required');
		expect(fetch_.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
	});

	it('shows reentry when polling finds absence with an empty outbox', async () => {
		const fetch_ = vi.fn<typeof fetch>(async (url) => {
			if (url === '/rooms')
				return response([{ name: 'delivery', status: 'running', participants: [] }]);
			if (url === '/people') return response([{ name: 'alice' }]);
			return response({ ...recordedRoom([]), participants: [] });
		});
		const { app, getElementById } = browser(fetch_);
		await app.poll();
		const pending = getElementById('pending');
		expect(pending.children.some((child) => child.textContent === 're-enter')).toBe(true);
	});

	it('keeps failed initial restoration in the required state', async () => {
		const fetch_ = vi.fn<typeof fetch>(async (url, init) => {
			if (url === '/rooms')
				return response([{ name: 'delivery', status: 'running', participants: [] }]);
			if (url === '/people') return response([{ name: 'alice' }]);
			if (url === '/rooms/delivery/humans/alice' && init?.method === 'PUT')
				throw new TypeError('Failed to fetch');
			return response(recordedRoom([]));
		});
		const { app } = browser(fetch_);
		app.state.entryState = 'restoring';
		await app.poll();
		await app.restoreSelection();
		expect(app.state.entryState).toBe('required');
		expect(fetch_.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
	});

	it('locks navigation while the initial restoration join is pending', async () => {
		const joined = Promise.withResolvers<Response>();
		const fetch_ = vi.fn<typeof fetch>(async (url, init) => {
			if (url === '/rooms')
				return response([{ name: 'delivery', status: 'running', participants: [] }]);
			if (url === '/people') return response([{ name: 'alice' }]);
			if (url === '/rooms/delivery/humans/alice' && init?.method === 'PUT') return joined.promise;
			return response(recordedRoom([]));
		});
		const { app } = browser(fetch_);
		await app.poll();
		app.state.entryState = 'restoring';
		const restoring = app.restoreSelection();
		expect(app.state.navigating).toBe(true);
		joined.resolve(response({ joined: 'alice' }));
		await restoring;
		expect(app.state.navigating).toBe(false);
	});

	it('requires explicit entry when a saved room starts stopped', async () => {
		let running = false;
		const fetch_ = vi.fn<typeof fetch>(async (url) => {
			if (url === '/rooms')
				return response([
					{ name: 'delivery', status: running ? 'running' : 'stopped', participants: [] },
				]);
			if (url === '/people') return response([{ name: 'alice' }]);
			return response({
				...recordedRoom([]),
				status: running ? 'running' : 'stopped',
				participants: [],
			});
		});
		const { app, getElementById } = browser(fetch_);
		app.state.entryState = 'restoring';
		await app.poll();
		await app.restoreSelection();
		expect(app.state.entryState).toBe('required');
		expect(fetch_.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
		running = true;
		await app.poll();
		expect(app.state.entryState).toBe('required');
		expect(
			getElementById('pending').children.some((child) => child.textContent === 're-enter'),
		).toBe(true);
	});

	it('groups a closed exchange without a summary', async () => {
		const { app, getElementById } = browser(vi.fn<typeof fetch>());
		app.state.rooms = [
			recordedRoom(
				[closed(1, 3, { status: 'silent' })],
				[
					said(1, 'alice', 'Question'),
					said(2, 'assistant', 'First reply'),
					said(3, 'assistant', 'Second reply'),
				],
				3,
			),
		];
		app.state.messages.set('delivery', app.state.rooms[0]?.messages || []);
		app.renderTimeline();
		const timeline = getElementById('timeline-inner');
		expect(timeline.children.map((child) => child.className)).toEqual(['message', 'discussion']);
		expect(timeline.children[1]?.children[0]?.textContent).toContain('No summary');
		expect(timeline.children[1]?.open).toBe(false);
	});

	it('shows one agent reply directly without its summary card', async () => {
		const summary = { kind: 'summary', seq: 3, from: 'assistant', text: 'Summary', at: '' };
		const { app, getElementById } = browser(vi.fn<typeof fetch>());
		app.state.rooms = [
			recordedRoom(
				[closed(1, 2, { status: 'published', summary })],
				[said(1, 'alice', 'Question'), said(2, 'assistant', 'Answer')],
				2,
			),
		];
		app.state.messages.set('delivery', app.state.rooms[0]?.messages || []);
		app.renderTimeline();
		expect(getElementById('timeline-inner').children.map((child) => child.className)).toEqual([
			'message',
			'message',
		]);
	});

	it('shows a published summary when a closed exchange has no agent reply', async () => {
		const summary = { kind: 'summary', seq: 2, from: 'assistant', text: 'The answer.', at: '' };
		const { app, getElementById } = browser(vi.fn<typeof fetch>());
		app.state.rooms = [
			recordedRoom(
				[closed(1, 1, { status: 'published', summary })],
				[said(1, 'alice', 'Question')],
				2,
			),
		];
		app.state.messages.set('delivery', app.state.rooms[0]?.messages || []);
		app.renderTimeline();
		const timeline = getElementById('timeline-inner');
		expect(timeline.children.map((child) => child.className)).toEqual(['message', 'message']);
		expect(textOf(timeline.children[1] as MockElement)).toContain('The answer.');
	});

	it('renders a late summary beside a newer open exchange', async () => {
		const summary = { kind: 'summary', seq: 5, from: 'assistant', text: 'Closed answer.', at: '' };
		const { app, getElementById } = browser(vi.fn<typeof fetch>());
		app.state.rooms = [
			recordedRoom(
				[
					closed(1, 3, { status: 'published', summary }),
					{ status: 'open', owner: 'alice', from: 6, at: '2026-09-16T00:00:06.000Z' },
				],
				[
					said(1, 'alice', 'Old question'),
					said(2, 'assistant', 'Old reply'),
					said(3, 'assistant', 'Old followup'),
					said(6, 'alice', 'New question'),
				],
				6,
			),
		];
		app.state.messages.set('delivery', app.state.rooms[0]?.messages || []);
		app.renderTimeline();
		const timeline = getElementById('timeline-inner');
		expect(timeline.children.some((child) => textOf(child).includes('Closed answer.'))).toBe(true);
		expect(textOf(timeline.children.at(-1) as MockElement)).toContain('New question');
	});

	it('invalidates the timeline when only an exchange closes', async () => {
		const { app, getElementById } = browser(vi.fn<typeof fetch>());
		const messages = [
			said(1, 'alice', 'Question'),
			said(2, 'assistant', 'Answer'),
			said(3, 'assistant', 'Followup'),
		];
		app.state.rooms = [
			recordedRoom([{ status: 'open', owner: 'alice', from: 1, at: '' }], messages, 3),
		];
		app.state.messages.set('delivery', messages);
		app.renderTimeline();
		expect(getElementById('timeline-inner').children).toHaveLength(3);
		app.state.rooms[0] = recordedRoom([closed(1, 3, { status: 'silent' })], messages, 3);
		app.renderTimeline();
		expect(getElementById('timeline-inner').children.map((child) => child.className)).toEqual([
			'message',
			'discussion',
		]);
	});

	it('clears a stale open exchange after the coherent selected read', async () => {
		const messages = [
			said(1, 'alice', 'Question'),
			said(2, 'assistant', 'Answer'),
			said(3, 'assistant', 'Followup'),
		];
		const open = { status: 'open', owner: 'alice', from: 1, at: '' };
		let selectedReads = 0;
		const fetch_ = vi.fn<typeof fetch>(async (url) => {
			if (url === '/rooms')
				return response([
					{
						...recordedRoom([open], [], 3),
						exchange: open,
					},
				]);
			if (url === '/people') return response([{ name: 'alice' }]);
			if (String(url).startsWith('/rooms/delivery?')) {
				selectedReads += 1;
				if (selectedReads === 1) return response(recordedRoom([open], messages, 3));
				const closedRoom = recordedRoom([closed(1, 3, { status: 'silent' })], [], 3);
				delete closedRoom.exchange;
				return response(closedRoom);
			}
			return response({});
		});
		const { app, getElementById } = browser(fetch_);
		await app.poll();
		expect(app.state.rooms[0]?.exchange).toEqual(open);
		expect(app.state.messages.get('delivery')).toEqual(messages);
		await app.poll();
		const timeline = getElementById('timeline-inner');
		expect(selectedReads).toBe(2);
		expect(app.state.rooms[0]?.exchange).toBeUndefined();
		expect(app.state.messages.get('delivery')).toEqual(messages);
		expect(timeline.children.map((child) => child.className)).toEqual(['message', 'discussion']);
		expect(textOf(timeline)).toContain('Followup');
	});

	it.each([
		new TypeError('Failed to fetch'),
		new DOMException('Timed out', 'TimeoutError'),
		new DOMException('Aborted', 'AbortError'),
	])('retries an uncertain request with its original key and text: %s', async (error) => {
		const fetch_ = vi
			.fn<typeof fetch>()
			.mockRejectedValueOnce(error)
			.mockResolvedValue(response({ from: 4 }));
		const { app } = browser(fetch_);
		const item = delivery();
		app.state.outbox.push(item);
		await app.flushOutbox();
		expect(app.state.outbox).toEqual([item]);
		expect(item.blocked).not.toBe(true);
		await app.flushOutbox();
		expect(app.state.outbox).toEqual([]);
		expect(fetch_).toHaveBeenCalledTimes(2);
		expect(fetch_.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
			{ key: item.key, text: item.text },
			{ key: item.key, text: item.text },
		]);
	});

	it('keeps a definitive validation rejection available for editing', async () => {
		const fetch_ = vi.fn<typeof fetch>().mockResolvedValue(response({ error: 'Too large' }, 413));
		const { app } = browser(fetch_);
		const item = delivery();
		app.state.outbox.push(item);
		await app.flushOutbox();
		await app.flushOutbox();
		expect(item.blocked).toBe(true);
		expect(app.state.outbox).toEqual([item]);
		expect(fetch_).toHaveBeenCalledTimes(1);
	});

	it('holds the selected identity while room creation is pending', async () => {
		const created = Promise.withResolvers<Response>();
		const fetch_ = vi.fn<typeof fetch>(async (url, init) => {
			if (url === '/rooms' && init?.method === 'POST') return created.promise;
			if (url === '/rooms')
				return response([
					{
						name: 'new-room',
						status: 'running',
						participants: [{ name: 'alice', presence: 'present' }],
					},
				]);
			if (url === '/people') return response([{ name: 'alice' }]);
			if (String(url).startsWith('/rooms/new-room?'))
				return response({ ...recordedRoom([]), name: 'new-room' });
			return response(recordedRoom([]));
		});
		const { app, getElementById } = browser(fetch_);
		getElementById('room-name').value = 'new-room';
		getElementById('new-room-goal').value = 'Review the shared work.';
		const creating = app.createRoom();
		expect(app.state.navigating).toBe(true);
		await app.switchUser();
		expect(app.state.human).toBe('alice');
		created.resolve(response({ name: 'new-room' }, 201));
		await creating;
		await app.state.pollPromise;
		expect(app.state.selected).toBe('new-room');
		expect(
			fetch_.mock.calls
				.filter(([, init]) => ['DELETE', 'PUT'].includes(init?.method ?? ''))
				.map(([url, init]) => [url, init?.method]),
		).toEqual([
			['/rooms/delivery/humans/alice', 'DELETE'],
			['/rooms/new-room/humans/alice', 'PUT'],
		]);
	});
});

describe('Task inspector', () => {
	const task = (id: string, exchange: number, status = 'open') => ({
		id,
		exchange,
		status,
		text: `Assignment ${id}`,
		owner: 'assistant',
		agents: ['reviewer'],
		events: [],
	});
	it('shows the selected exchange and refreshes Task status without new messages', async () => {
		const room = {
			...recordedRoom([{ from: 10, status: 'open' }]),
			tasks: [task('old', 2, 'succeeded'), task('current', 10)],
		};
		const { app, getElementById } = browser(async (input) =>
			response(
				String(input) === '/people'
					? [{ name: 'alice' }]
					: String(input) === '/rooms'
						? [room]
						: room,
			),
		);
		app.state.rooms = [room];
		app.renderTasks();
		expect(textOf(getElementById('task-list'))).toContain('Assignment current');
		expect(textOf(getElementById('task-list'))).not.toContain('Assignment old');
		room.tasks[1] = {
			...task('current', 10, 'succeeded'),
			outcome: 'Review complete.',
		} as (typeof room.tasks)[number];
		await app.poll();
		expect(textOf(getElementById('task-list'))).toContain('Review complete.');
		app.state.taskExchange = '2';
		app.renderTasks();
		expect(textOf(getElementById('task-list'))).toContain('Assignment old');
		expect(textOf(getElementById('task-list'))).not.toContain('Assignment current');
	});
	it('shows background work until the owning exchange closes after Task settlement', () => {
		const { app, getElementById } = browser(async () => response({}));
		const room: BrowserRoom = {
			...recordedRoom([]),
			participants: [],
			exchange: { from: 10 },
			tasks: [task('current', 10, 'succeeded')],
		};
		app.state.rooms = [room];
		app.renderHeader();
		expect(getElementById('room-state').textContent).toBe('Background work');
		room.exchange = undefined;
		app.renderHeader();
		expect(getElementById('room-state').textContent).toBe('Ready');
	});
	it('discards a working-room read after the user closes the inspector', async () => {
		let finish: (value: Response) => void = () => {};
		const fetched = new Promise<Response>((resolve) => {
			finish = resolve;
		});
		const calls: string[] = [];
		const { app } = browser(async (input) => {
			calls.push(String(input));
			return fetched;
		});
		app.inspectTask({ id: 'task-one' });
		expect(calls).toEqual(['/rooms/delivery/tasks/task-one']);
		app.inspectTask({ id: 'task-one' });
		finish(response({ task: task('task-one', 10), room: { participants: [], messages: [] } }));
		await vi.waitFor(() => expect(app.state.selectedTask).toBeNull());
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(app.state.taskRead).toBeNull();
	});
});
