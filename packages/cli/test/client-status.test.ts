import type { ExchangeView, RoomRead } from '@ambionframework/ambion';
import { describe, expect, it } from 'vitest';
import { deriveStatus, formatUsage } from '../src/lib/status.ts';

const usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 };

const open = (from: number): ExchangeView => ({
	owner: 'human',
	from,
	at: 'now',
	status: 'open',
	activations: [],
});

const closed = (from: number, extra: Partial<Extract<ExchangeView, { status: 'closed' }>> = {}) =>
	({
		owner: 'human',
		from,
		at: 'now',
		through: from + 3,
		status: 'closed',
		activations: [],
		summary: { status: 'silent' },
		outcome: { kind: 'complete' },
		...extra,
	}) as ExchangeView;

function read(exchanges: ExchangeView[]): RoomRead {
	const current = exchanges.find((exchange) => exchange.status === 'open');
	return {
		name: 'team',
		initialized: true,
		messages: [],
		participants: [],
		exchanges,
		exchange: current?.status === 'open' ? current : undefined,
		watermark: 9,
	};
}

describe('deriveStatus', () => {
	it('is idle when no exchange is on the record', () => {
		expect(deriveStatus(read([]))).toMatchObject({ state: 'idle', cost: undefined });
	});

	it('is working on an open exchange', () => {
		expect(deriveStatus(read([open(2)]))).toMatchObject({ state: 'working' });
		expect(deriveStatus(read([open(2)]), 2)).toMatchObject({ state: 'working' });
	});

	it('counts a question that is not on the record yet as work', () => {
		expect(deriveStatus(read([]), 5).state).toBe('working');
	});

	it('is completed on a closed exchange the terminal sent', () => {
		expect(deriveStatus(read([closed(2)]), 2).state).toBe('completed');
	});

	it('follows the sent exchange and ignores a later one', () => {
		const status = deriveStatus(read([closed(2), open(8)]), 2);
		expect(status.state).toBe('completed');
	});

	it('shows the cost of a closed exchange', () => {
		const status = deriveStatus(read([closed(2, { usage: { ...usage, cost: 0.0123 } })]), 2);
		expect(status.cost).toBe('$0.0123');
	});

	it('sums the usage of an open exchange', () => {
		const activation = {
			id: 'a',
			seat: 'planner',
			attempt: 1,
			purpose: 'respond' as const,
			outcome: { status: 'running' as const },
			usage,
		};
		const exchange: ExchangeView = { ...open(2), activations: [activation, activation] };
		expect(deriveStatus(read([exchange]), 2).cost).toBe('300 tokens');
	});

	it('names the person an awaiting exchange waits on', () => {
		const status = deriveStatus(
			read([closed(2, { outcome: { kind: 'awaiting', person: 'human' } })]),
			2,
		);
		expect(status.awaiting).toBe('human');
		expect(deriveStatus(read([closed(2)]), 2).awaiting).toBeUndefined();
	});
});

describe('formatUsage', () => {
	it('prefers cost, then tokens, then nothing', () => {
		expect(formatUsage({ ...usage, cost: 1 })).toBe('$1.0000');
		expect(formatUsage({ ...usage, input: 12_000 })).toBe('12.1k tokens');
		expect(formatUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeUndefined();
		expect(formatUsage(undefined)).toBeUndefined();
	});
});
