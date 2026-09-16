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
		restored: boolean;
		navigating: boolean;
		outbox: Delivery[];
		pollPromise: Promise<void> | null;
	};
	flushOutbox(): Promise<void>;
	createRoom(): Promise<void>;
	switchUser(): Promise<void>;
}

/** Keep the real script and requests. Replace only browser DOM and storage ports. */
function browser(fetch_: typeof fetch) {
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
	const app = runInNewContext(
		`${script.slice(0, boot)}\nreturn {state, flushOutbox, createRoom, switchUser}; })();`,
		{
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
		},
	) as BrowserApp;
	Object.assign(app.state, {
		rooms: [{ name: 'delivery', status: 'running', participants: [] }],
		human: 'alice',
		selected: 'delivery',
		restored: true,
	});
	return { app, getElementById };
}
function element() {
	return {
		value: '',
		textContent: '',
		dataset: {},
		style: {},
		childElementCount: 0,
		classList: { toggle() {} },
		append() {},
		replaceChildren() {},
		addEventListener() {},
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

describe('browser delivery and navigation', () => {
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
