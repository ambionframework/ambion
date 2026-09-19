import type { Message, ParticipantInfo } from '@ambionframework/ambion';

/** One person the Workbench offers as an identity. */
export interface Person {
	name: string;
	role?: string;
	preferences?: string;
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
}

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
		const value: unknown = text ? JSON.parse(text) : {};
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
