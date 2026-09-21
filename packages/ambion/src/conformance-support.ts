/**
 * What the two conformance suites share: the record of a scripted room's
 * calls, and the polling that waits for the seat side.
 */
import type { LeaseRequest } from './protocol.ts';

/** One call the seat made to a scripted room, with the answer. */
export interface Call {
	readonly op: 'view' | 'commit' | 'lease';
	readonly request: unknown;
	readonly response: unknown;
}

/** The length of a lease a scripted room grants, in milliseconds. */
export const LEASE_MS = 60_000;

/** Polls every 20 ms until `read` holds, or fails after `patience`. */
export async function until(read: () => boolean, patience: number, what: string): Promise<void> {
	const deadline = Date.now() + patience;
	while (!read()) {
		if (Date.now() > deadline) throw new Error(`Nothing came within ${patience} ms: ${what}.`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const check = (condition: boolean, what: string): void => {
	if (!condition) throw new Error(what);
};

/** What the helpers read of a scripted room. */
export interface Recorded {
	readonly calls: Call[];
}

export const operations = (room: Recorded, op: Call['op']) => room.calls.filter((c) => c.op === op);

export const leases = (room: Recorded) =>
	operations(room, 'lease').map((c) => c.request as LeaseRequest);

export const released = (room: Recorded) => leases(room).some((r) => r.operation === 'release');

export const claims = (room: Recorded) =>
	leases(room).filter((r) => r.operation === 'claim').length;
