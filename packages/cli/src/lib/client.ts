import type { ExchangeRef, ParticipantInfo, RoomRead } from '@ambionframework/ambion';

export interface StartResponse {
	started: string;
	participants: readonly ParticipantInfo[];
}

export interface JoinResponse {
	joined: string;
	participants: readonly ParticipantInfo[];
}

/** What the terminal needs of a room. A Worker and a Node host both provide it. */
export interface RoomClient {
	health(): Promise<{ ok: boolean }>;
	start(): Promise<StartResponse>;
	join(name?: string): Promise<JoinResponse>;
	send(text: string): Promise<ExchangeRef>;
	/** A detached read. With `since`, the messages come back after that sequence. */
	read(options?: { since?: number }): Promise<RoomRead>;
}

export class WorkerError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = 'WorkerError';
		this.status = status;
	}
}

export type FetchFunction = typeof fetch;

/** Small HTTP client for the generated Cloudflare project's local Worker. */
export class WorkerClient implements RoomClient {
	private readonly base: string;
	private readonly requestFetch: FetchFunction;

	constructor(baseUrl: string, requestFetch: FetchFunction = fetch) {
		this.base = baseUrl.replace(/\/$/, '');
		this.requestFetch = requestFetch;
	}

	async health(): Promise<{ ok: boolean }> {
		return this.get('/health');
	}

	async start(): Promise<StartResponse> {
		return this.post('/start');
	}

	async join(name = 'human'): Promise<JoinResponse> {
		return this.post('/join', { name });
	}

	async send(text: string): Promise<ExchangeRef> {
		return this.post('/send', { from: 'human', text });
	}

	async read(options: { since?: number } = {}): Promise<RoomRead> {
		const { since } = options;
		const suffix = since === undefined ? '' : `?since=${encodeURIComponent(String(since))}`;
		return this.get(`/read${suffix}`);
	}

	private async get<T>(path: string): Promise<T> {
		return this.call<T>(path, { method: 'GET' });
	}

	private async post<T>(path: string, body?: unknown): Promise<T> {
		return this.call<T>(path, {
			method: 'POST',
			...(body === undefined
				? {}
				: {
						body: JSON.stringify(body),
						headers: { 'content-type': 'application/json' },
					}),
		});
	}

	private async call<T>(path: string, init: RequestInit): Promise<T> {
		let response: Response;
		try {
			response = await this.requestFetch(`${this.base}${path}`, {
				...init,
				signal: init.signal ?? AbortSignal.timeout(2_000),
			});
		} catch (error) {
			throw new WorkerError(
				error instanceof Error
					? `Worker request failed: ${error.message}`
					: 'Worker request failed.',
				0,
			);
		}
		const text = await response.text();
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			throw new WorkerError(`Worker returned invalid JSON (${response.status}).`, response.status);
		}
		if (!response.ok) {
			const message =
				typeof value === 'object' &&
				value !== null &&
				'error' in value &&
				typeof value.error === 'string'
					? value.error
					: `Worker request failed with HTTP ${response.status}.`;
			throw new WorkerError(message, response.status);
		}
		return value as T;
	}
}
