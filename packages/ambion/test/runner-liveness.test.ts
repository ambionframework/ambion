import type { StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import type { SeatContext } from '../src/host/runtime.ts';
import { type Clock, createRuntime, defineAgent, pi } from '../src/index.ts';
import {
	AgentRunner,
	type CommitRequest,
	type CommitResult,
	createPiExecutor,
	type LeaseRequest,
	type LeaseResponse,
	type SeatRoom,
	type ViewResponse,
	type Wake,
} from '../src/transport.ts';
import { fakeClock } from './support/clock.ts';
import { tick } from './support/room.ts';
import { quiet, scripted, speak } from './support/scripted.ts';

const worker = defineAgent({
	name: 'worker',
	identity: 'The worker.',
	executor: pi({ instructions: 'answer', model: 'scripted/worker' }),
});

const first = 'message:1:worker:1';
const second = 'message:2:worker:1';

type Answer = LeaseResponse | Promise<LeaseResponse>;
type LeaseScript = (request: LeaseRequest) => Answer;

interface RoomOptions {
	lease?: LeaseScript;
	view?: (id: string) => Promise<ViewResponse>;
	commit?: (request: CommitRequest) => Promise<CommitResult>;
}

class LivenessRoom implements SeatRoom {
	readonly calls: LeaseRequest[] = [];

	constructor(
		private readonly clock: Clock,
		private readonly options: RoomOptions = {},
	) {}

	view(id: string): Promise<ViewResponse> {
		return (
			this.options.view?.(id) ??
			Promise.resolve({
				view: {
					spec: { id, seat: worker.name, attempt: 1, purpose: { kind: 'respond', message: 1 } },
					through: 1,
					context: { name: 'liveness', now: 0, participants: [], messages: [], reserve: [] },
				},
			})
		);
	}

	async commit(request: CommitRequest): Promise<CommitResult> {
		return this.options.commit?.(request) ?? { refused: 'nothing lands here' };
	}

	async lease(request: LeaseRequest): Promise<LeaseResponse> {
		this.calls.push(request);
		return (
			this.options.lease?.(request) ?? {
				ok: { expiresAt: this.clock.now() + 100, lastSeq: 1 },
			}
		);
	}
}

function ok(clock: Clock, expiry = clock.now() + 100): LeaseResponse {
	return { ok: { expiresAt: expiry, lastSeq: 1 } };
}

function pending<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function wake(activation: string): Wake {
	return { room: 'liveness', seat: worker.name, activation };
}

function fixture(
	options: {
		lease?: LeaseScript;
		view?: (id: string) => Promise<ViewResponse>;
		commit?: (request: CommitRequest) => Promise<CommitResult>;
		stream?: StreamFn;
		call?: { attempts?: number; timeout?: number };
		emit?: (event: Parameters<NonNullable<SeatContext['emit']>>[0]) => void;
	} = {},
) {
	const clock = fakeClock(0);
	const runtime = createRuntime({
		clock,
		stream: options.stream ?? scripted(() => quiet()),
		call: options.call,
	});
	const room = new LivenessRoom(clock, {
		lease: options.lease,
		view: options.view,
		commit: options.commit,
	});
	const executor = createPiExecutor({
		definition: worker,
		model: runtime.model,
		stream: runtime.stream,
		transcripts: runtime.transcripts,
		room: 'liveness',
		now: () => clock.now(),
	});
	const actor = new AgentRunner(room, {
		clock,
		call: runtime.call,
		definition: worker,
		room: 'liveness',
		seat: worker.name,
		executor,
		emit: options.emit,
	});
	return { actor, clock, room };
}

async function until(done: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200 && !done(); attempt += 1) await tick();
	if (!done()) throw new Error('the runner did not progress');
}

const deaf: StreamFn = () => createAssistantMessageEventStream();

describe('runner liveness', () => {
	it('uses a ten second default timeout for room calls', () => {
		const runtime = createRuntime({ clock: fakeClock(0) });
		expect(runtime.call.timeout).toBe(10_000);
	});

	it('does not start an activation from an already-expired claim', async () => {
		let providerCalls = 0;
		const { actor, clock, room } = fixture({
			stream: scripted(() => {
				providerCalls += 1;
				return quiet();
			}),
			lease: (request) =>
				request.activation === first && request.operation === 'claim'
					? ok(clock, clock.now() - 1)
					: ok(clock),
		});
		await actor.run(first);
		expect(providerCalls).toBe(0);
		expect(
			room.calls.filter((call) => call.activation === first && call.operation === 'renew'),
		).toHaveLength(0);
		expect(room.calls).toContainEqual(
			expect.objectContaining({
				activation: first,
				operation: 'release',
				reason: 'failed',
			}),
		);
		await actor.run(second);
		expect(providerCalls).toBe(1);
		expect(
			room.calls.some((call) => call.activation === second && call.operation === 'claim'),
		).toBe(true);
	});

	it('bounds lost claim and release calls by the configured attempts', async () => {
		const events: { operation: string }[] = [];
		const { actor, clock, room } = fixture({
			call: { attempts: 2, timeout: 100 },
			lease: (request) => {
				if (request.activation === first && request.operation === 'claim')
					return new Promise<LeaseResponse>(() => {});
				if (request.activation === second && request.operation === 'release')
					return new Promise<LeaseResponse>(() => {});
				return ok(clock);
			},
			emit: (event) => {
				if (event.type === 'delivery_error') events.push({ operation: event.operation });
			},
		});
		const firstRun = actor.run(first);
		await until(() => room.calls.length === 1);
		await clock.advance(200);
		await firstRun;
		const secondRun = actor.run(second);
		await until(() =>
			room.calls.some((call) => call.activation === second && call.operation === 'release'),
		);
		await clock.advance(200);
		await secondRun;
		expect(
			room.calls.filter((call) => call.activation === first && call.operation === 'claim'),
		).toHaveLength(2);
		expect(
			room.calls.filter((call) => call.activation === second && call.operation === 'release'),
		).toHaveLength(2);
		expect(events).toEqual([{ operation: 'claim' }, { operation: 'release' }]);
	});

	it('cuts a hung claim and lets the next wake claim immediately', async () => {
		const { actor, clock, room } = fixture({
			lease: (request) =>
				request.activation === first && request.operation === 'claim'
					? new Promise<LeaseResponse>(() => {})
					: ok(clock),
		});
		const firstRun = actor.run(first);
		await until(() =>
			room.calls.some((call) => call.activation === first && call.operation === 'claim'),
		);
		await actor.cut(first);
		await actor.wake(wake(second));
		await until(() =>
			room.calls.some((call) => call.activation === second && call.operation === 'claim'),
		);
		await firstRun;
		expect(
			room.calls.filter((call) => call.activation === second && call.operation === 'claim'),
		).toHaveLength(1);
	});

	it('cuts a hung view and lets the next wake claim immediately', async () => {
		let waiting = true;
		let viewStarted = false;
		const { actor, room } = fixture({
			view: async () => {
				viewStarted = true;
				if (waiting) return new Promise<ViewResponse>(() => {});
				return { stale: 'the activation was cut' };
			},
		});
		const firstRun = actor.run(first);
		await until(() => viewStarted);
		await actor.cut(first);
		waiting = false;
		await actor.wake(wake(second));
		await until(() =>
			room.calls.some((call) => call.activation === second && call.operation === 'claim'),
		);
		await firstRun;
		expect(
			room.calls.filter((call) => call.activation === second && call.operation === 'claim'),
		).toHaveLength(1);
	});

	it('cuts a hung release and lets a queued wake claim immediately', async () => {
		const { actor, clock, room } = fixture({
			stream: scripted(() => quiet()),
			lease: (request) =>
				request.activation === first && request.operation === 'release'
					? new Promise<LeaseResponse>(() => {})
					: ok(clock),
		});
		const firstRun = actor.run(first);
		await until(() =>
			room.calls.some((call) => call.activation === first && call.operation === 'claim'),
		);
		await actor.cut(first);
		await actor.wake(wake(second));
		await until(() =>
			room.calls.some((call) => call.activation === second && call.operation === 'claim'),
		);
		await firstRun;
		expect(
			room.calls.some((call) => call.activation === first && call.operation === 'release'),
		).toBe(true);
	});

	it('uses one cut to progress when the cut starts a hung release', async () => {
		const { actor, room, clock } = fixture({
			stream: deaf,
			call: { attempts: 2, timeout: 100 },
			lease: (request) =>
				request.activation === first && request.operation === 'release'
					? new Promise<LeaseResponse>(() => {})
					: ok(clock),
		});
		const firstRun = actor.run(first);
		await until(() =>
			room.calls.some((call) => call.activation === first && call.operation === 'claim'),
		);
		await tick();
		await clock.advance(50);
		await until(() => room.calls.some((call) => call.operation === 'renew'));
		await actor.cut(first);
		await actor.wake(wake(second));
		try {
			await until(() =>
				room.calls.some((call) => call.activation === second && call.operation === 'claim'),
			);
		} finally {
			await clock.advance(200);
			await actor.cut(second);
			await firstRun;
		}
		expect(
			room.calls.some((call) => call.activation === second && call.operation === 'claim'),
		).toBe(true);
	});

	it('ignores a late claim reply after the next activation starts', async () => {
		const late = pending<LeaseResponse>();
		const starts: string[] = [];
		const stream: StreamFn = (model) => {
			starts.push(model.id);
			return createAssistantMessageEventStream();
		};
		const { actor, clock, room } = fixture({
			stream,
			lease: (request) =>
				request.activation === first && request.operation === 'claim' ? late.promise : ok(clock),
		});
		const firstRun = actor.run(first);
		await until(() =>
			room.calls.some((call) => call.activation === first && call.operation === 'claim'),
		);
		await actor.cut(first);
		await actor.wake(wake(second));
		await until(() => starts.length === 1);
		late.resolve(ok(clock, 10_000));
		await tick();
		await actor.cut(second);
		await firstRun;
		expect(starts).toEqual(['scripted/worker']);
		expect(
			room.calls.filter((call) => call.activation === first && call.operation === 'release'),
		).toHaveLength(0);
	});

	it('does not rearm a renewal that replies after a cut', async () => {
		const late = pending<LeaseResponse>();
		const { actor, room, clock } = fixture({
			stream: deaf,
			lease: (request) => {
				if (request.activation === first && request.operation === 'renew') return late.promise;
				return ok(clock, request.activation === second ? 100_000 : 100);
			},
		});
		const firstRun = actor.run(first);
		await until(() =>
			room.calls.some((call) => call.activation === first && call.operation === 'claim'),
		);
		await tick();
		await clock.advance(50);
		await until(() =>
			room.calls.some((call) => call.activation === first && call.operation === 'renew'),
		);
		await actor.cut(first);
		await actor.wake(wake(second));
		await until(() =>
			room.calls.some((call) => call.activation === second && call.operation === 'claim'),
		);
		late.resolve(ok(clock, 10_000));
		await clock.advance(9_950);
		expect(
			room.calls.filter((call) => call.activation === first && call.operation === 'renew'),
		).toHaveLength(1);
		await actor.cut(second);
		await firstRun;
	});

	it('reports a lost renewal while holding the lease through its confirmed expiry', async () => {
		const events: string[] = [];
		const { actor, room, clock } = fixture({
			stream: deaf,
			lease: (request) =>
				request.operation === 'renew' ? Promise.reject(new Error('renewal lost')) : ok(clock, 100),
			emit: (event) => {
				if (event.type === 'delivery_error') events.push(event.operation);
			},
		});
		const run = actor.run(first);
		await until(() => room.calls.some((call) => call.operation === 'claim'));
		await tick();
		await clock.advance(50);
		await until(() => room.calls.some((call) => call.operation === 'renew'));
		expect(events).toEqual(['renew']);
		expect(room.calls.some((call) => call.operation === 'release')).toBe(false);
		await clock.advance(49);
		expect(room.calls.some((call) => call.operation === 'release')).toBe(false);
		await clock.advance(1);
		await run;
	});

	it('cuts at the confirmed expiry while a renewal never resolves', async () => {
		const { actor, room, clock } = fixture({
			stream: deaf,
			call: { attempts: 1, timeout: 10_000 },
			lease: (request) =>
				request.operation === 'renew' ? new Promise<LeaseResponse>(() => {}) : ok(clock, 100),
		});
		const run = actor.run(first);
		await until(() => room.calls.some((call) => call.operation === 'claim'));
		await tick();
		await clock.advance(50);
		await until(() => room.calls.some((call) => call.operation === 'renew'));
		await clock.advance(49);
		expect(room.calls.some((call) => call.operation === 'release')).toBe(false);
		await clock.advance(1);
		await run;
		expect(room.calls).toContainEqual(
			expect.objectContaining({ operation: 'release', reason: 'failed' }),
		);
	});

	it('does not strand the runner when an executor diagnostic callback throws', async () => {
		const { actor, room } = fixture({
			view: async () => {
				throw new Error('view unavailable');
			},
			emit: () => {
				throw new Error('diagnostic listener failed');
			},
		});
		await actor.run(first);
		await actor.run(second);
		expect(room.calls.filter((call) => call.operation === 'claim')).toHaveLength(2);
		expect(room.calls.filter((call) => call.operation === 'release')).toHaveLength(2);
	});

	it('keeps an applied commit when its reply is lost', async () => {
		let commits = 0;
		const events: string[] = [];
		const { actor, clock, room } = fixture({
			stream: scripted((_context, _agent, call) =>
				call === 1 ? speak('recorded before the reply is lost') : quiet(),
			),
			call: { attempts: 1, timeout: 100 },
			commit: async () => {
				commits += 1;
				return new Promise<CommitResult>(() => {});
			},
			emit: (event) => {
				if (event.type === 'delivery_error') events.push(event.operation);
			},
		});
		const run = actor.run(first);
		await until(() => commits === 1);
		await clock.advance(100);
		await run;
		expect(commits).toBe(1);
		expect(events).toEqual(['commit']);
		expect(room.calls.some((call) => call.operation === 'release')).toBe(true);
	});

	it('keeps cancelled and stale responses out of delivery errors', async () => {
		const events: string[] = [];
		const late = pending<LeaseResponse>();
		const { actor, clock, room } = fixture({
			call: { attempts: 1, timeout: 100 },
			lease: (request) => {
				if (request.activation === first && request.operation === 'claim') return late.promise;
				if (request.activation === second && request.operation === 'claim')
					return { stale: 'ended' };
				return ok(clock);
			},
			emit: (event) => {
				if (event.type === 'delivery_error') events.push(event.operation);
			},
		});
		const firstRun = actor.run(first);
		await until(() =>
			room.calls.some((call) => call.activation === first && call.operation === 'claim'),
		);
		await actor.cut(first);
		await actor.wake(wake(second));
		await firstRun;
		late.resolve(ok(clock));
		expect(events).toEqual([]);
	});
});
