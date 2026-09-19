import type { Message, ParticipantInfo } from '@ambionframework/ambion';

/** One person the Workbench offers as an identity. */
export interface Person {
	name: string;
	role?: string;
	preferences?: string;
}

/** How the room closed an exchange's summary. */
export type SummaryState = 'published' | 'pending' | 'failed' | 'silent';

/** One exchange in a room read: a question, and everything until the room went quiet. */
export interface ExchangeInfo {
	from: number;
	through?: number;
	status: 'open' | 'closed';
	owner: string;
	summary?: { status: SummaryState; summary?: Message };
}

/** One room, as the list and read endpoints return it. */
export interface RoomView {
	name: string;
	status: 'running' | 'stopping' | 'stopped';
	goal?: string;
	pattern?: string;
	prompt?: string;
	participants: ParticipantInfo[];
	messages?: Message[];
	exchanges?: ExchangeInfo[];
	/** The open exchange, when the room has one. */
	exchange?: { owner: string; from: number; at: string };
}

/** A room lifecycle action. Abort cancels the open exchange; stop and resume end and start a run. */
export type RoomAction = 'abort' | 'stop' | 'resume';

/** The result of an accepted human message. */
export interface Accepted {
	from: number;
	owner: string;
	at: string;
}

/** A small HTTP client for the Workbench host. The web and terminal share it. */
export class WorkbenchClient {
	private readonly base: string;

	constructor(baseUrl: string) {
		this.base = baseUrl.replace(/\/$/, '');
	}

	people(): Promise<Person[]> {
		return this.request('/people');
	}

	rooms(): Promise<RoomView[]> {
		return this.request('/rooms');
	}

	read(name: string, since: number): Promise<RoomView> {
		return this.request(`/rooms/${encodeURIComponent(name)}?since=${since}`);
	}

	control(name: string, action: RoomAction): Promise<RoomView> {
		return this.request(`/rooms/${encodeURIComponent(name)}/${action}`, { method: 'POST' });
	}

	join(name: string, person: string): Promise<unknown> {
		return this.request(this.humanPath(name, person), { method: 'PUT' });
	}

	leave(name: string, person: string): Promise<unknown> {
		return this.request(this.humanPath(name, person), { method: 'DELETE' });
	}

	send(name: string, person: string, key: string, text: string): Promise<Accepted> {
		return this.request(this.humanPath(name, person), {
			method: 'POST',
			body: JSON.stringify({ key, text }),
		});
	}

	private humanPath(name: string, person: string): string {
		return `/rooms/${encodeURIComponent(name)}/humans/${encodeURIComponent(person)}`;
	}

	private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
		let response: Response;
		try {
			response = await fetch(`${this.base}${path}`, {
				...init,
				signal: AbortSignal.timeout(10_000),
				headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
			});
		} catch {
			throw new Error(`Could not reach the Workbench at ${this.base}. Is the host running?`);
		}
		const text = await response.text();
		let value: unknown = {};
		try {
			value = text ? JSON.parse(text) : {};
		} catch {
			// A proxy can answer with an HTML page. Keep the status, not a parse error.
			if (response.ok) throw new Error('The Workbench sent a reply that is not JSON.');
		}
		if (!response.ok) throw new Error(readError(value, response.status));
		return value as T;
	}
}

function readError(value: unknown, status: number): string {
	if (typeof value === 'object' && value !== null && 'error' in value) {
		const message = (value as { error: unknown }).error;
		if (typeof message === 'string') return message;
	}
	return `Request failed with HTTP ${status}.`;
}
