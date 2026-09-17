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
		rooms: { name: string; status: string; participants: unknown[] }[];
		human: string;
		selected: string;
		entryState: 'restoring' | 'entered' | 'required';
		bootPromise: Promise<void> | null;
		navigating: boolean;
		outbox: Delivery[];
		pollPromise: Promise<void> | null;
	};
	flushOutbox(): Promise<void>;
	restoreSelection(): Promise<void>;
	reenterRoom(): Promise<void>;
	poll(full?: boolean): Promise<void> | undefined;
	createRoom(): Promise<void>;
	switchUser(): Promise<void>;
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
				'\nreturn {state, flushOutbox, restoreSelection, reenterRoom, poll, createRoom, switchUser}; })();',
			)
		: `${script.slice(0, boot)}\nreturn {state, flushOutbox, restoreSelection, reenterRoom, poll, createRoom, switchUser}; })();`;
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

describe('browser delivery and navigation', () => {
	it('keeps polling read-only after another tab ends the shared presence', async () => {
		const fetch_ = vi.fn<typeof fetch>(async (url) => {
			if (url === '/rooms')
				return response([{ name: 'delivery', status: 'running', participants: [] }]);
			if (url === '/people') return response([{ name: 'alice' }]);
			return response([]);
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
			return response([]);
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
			return response([]);
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
			return response([]);
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
			return response([]);
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
			return response([]);
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
			return response([]);
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
			return response([]);
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
			return response([]);
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
			return response([]);
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
