import type { AgentSeatInfo, Exchange, Message, SeatInfo } from '@ambionframework/ambion';

export interface RoomStatus {
	name: string;
	participants: SeatInfo[];
	exchange: Exchange | undefined;
	exchangeState: 'idle' | 'working' | 'completed';
}

export class WorkerError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = 'WorkerError';
		this.status = status;
	}
}

interface StartResponse {
	started: string;
	participants: SeatInfo[];
}

interface JoinResponse {
	joined: string;
	participants: SeatInfo[];
}

export interface ExchangeResult {
	owner: string;
	from: number;
	at: string;
}

export type FetchFunction = typeof fetch;

/** Small HTTP client for the generated team's local Worker. */
export class WorkerClient {
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

	async send(text: string): Promise<ExchangeResult> {
		return this.post('/send', { from: 'human', text });
	}

	async messages(since?: number): Promise<Message[]> {
		const suffix = since === undefined ? '' : `?since=${encodeURIComponent(String(since))}`;
		return this.get(`/messages${suffix}`);
	}

	async status(from?: number): Promise<RoomStatus> {
		const suffix = from === undefined ? '' : `?from=${encodeURIComponent(String(from))}`;
		return this.get(`/status${suffix}`);
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

export function agentParticipants(status: RoomStatus): AgentSeatInfo[] {
	return status.participants.filter(
		(participant): participant is AgentSeatInfo => participant.kind === 'agent',
	);
}
