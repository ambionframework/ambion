/**
 * The seat's side of the wire, driven by hand over a room the test plays:
 * one activation at a time, a steer into the one that runs, and whatever
 * queued behind it runs next. The runner stays live when a room call hangs,
 * fails, or answers late, and when the model resolves late or fails.
 */
import { createRuntime, type Message } from '@ambionframework/ambion';
import {
	type CommitResult,
	hostingOf,
	type LeaseRequest,
	type LeaseResponse,
	type Steer,
	type Wake,
} from '@ambionframework/ambion/hosting';
import { fakeClock } from '@ambionframework/ambion/testing';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import {
	type Api,
	type Context,
	createAssistantMessageEventStream,
	type Model,
} from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { deferred, tick } from '../../ambion/test/support/room.ts';
import { contextText, quiet, scripted, speak } from '../../ambion/test/support/scripted.ts';
import { stubModel } from '../src/services.ts';
import { deaf, ok, playSeat, until, worker } from './support/runner.ts';

const first = 'message:1:worker:1';
const second = 'message:2:worker:1';
const third = 'message:3:worker:1';

const wake = (activation: string): Wake => ({ room: 'played', seat: worker.name, activation });
const steer = (activation: string, seq = 2, text = 'And the pump?'): Steer => ({
	room: 'played',
	seat: worker.name,
	activation,
	after: seq - 1,
	message: {
		kind: 'said',
		seq,
		at: '2026-01-01T00:00:00.000Z',
		from: 'priya',
		text,
	} satisfies Message,
});

const never = <T>() => new Promise<T>(() => {});

function pending<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** Holds the first release until the test lets go, so a wake can land while it releases. */
function heldRelease() {
	const releasing = deferred();
	const letGo = deferred();
	let held = false;
	const lease = async (request: LeaseRequest) => {
		if (request.operation !== 'release' || held) return undefined;
		held = true;
		releasing.resolve();
		await letGo.promise;
		return undefined;
	};
	return { releasing, letGo, lease };
}

describe('a seat actor', () => {
	it('ignores a delayed steer when its target activation has already finished', async () => {
		const started = deferred();
		const release = deferred();
		const contexts: string[] = [];
		const { room, actor } = playSeat({
			stream: scripted(async (context, _agent, call) => {
				contexts.push(contextText(context));
				if (call === 2) {
					started.resolve();
					await release.promise;
				}
				return quiet();
			}),
		});
		await actor.run(first);
		const later = actor.run(third);
		try {
			await started.promise;
			await actor.steer(steer(first, 2, 'Obsolete context from the earlier activation.'));
			release.resolve();
			await later;
			expect(contexts.every((context) => !context.includes('Obsolete context'))).toBe(true);
			expect(room.claims).toEqual([first, third]);
			expect(room.mostHeld).toBe(1);
		} finally {
			release.resolve();
			await actor.cut(third);
		}
	});

	it('ignores steering while idle without claiming work', async () => {
		const { room, actor } = playSeat();
		await actor.steer(steer(first));
		await tick();
		expect(room.claims).toEqual([]);
	});

	it('ignores steering while its target releases without queuing work', async () => {
		const hold = heldRelease();
		const { room, actor } = playSeat({ lease: hold.lease });
		const running = actor.run(first);
		try {
			await hold.releasing.promise;
			await actor.steer(steer(first));
		} finally {
			hold.letGo.resolve();
			await running;
		}
		expect(room.claims).toEqual([first]);
		expect(room.releases).toEqual([first]);
	});

	it('queues a wake that lands while the activation releases', async () => {
		const hold = heldRelease();
		const { room, actor } = playSeat({ lease: hold.lease });
		void actor.wake(wake(first));
		await hold.releasing.promise;
		// the activation is over and its release is in flight: it reads nothing more,
		// so the message runs as an activation of its own, and none runs beside it
		await actor.wake(wake(second));
		hold.letGo.resolve();
		await until(() => room.releases.length === 2);
		expect(room.claims).toEqual([first, second]);
		expect(room.mostHeld).toBe(1);
	});

	it('takes a wake to its end: it claims the lease, runs, and releases', async () => {
		const { room, actor } = playSeat();
		await actor.wake(wake(first));
		await until(() => room.releases.length === 1);
		expect(room.claims).toEqual([first]);
		expect(room.releases).toEqual([first]);
		expect(room.mostHeld).toBe(1);
	});

	it('steers a recorded message into its running activation without starting work', async () => {
		const gate = deferred();
		const { room, actor } = playSeat({
			stream: scripted(async () => {
				await gate.promise;
				return quiet();
			}),
		});
		void actor.wake(wake(first));
		await until(() => room.claims.length === 1);
		await actor.steer(steer(first));
		await tick();
		expect(room.claims).toEqual([first]);
		gate.resolve();
		await until(() => room.releases.length === 1);
		expect(room.claims).toEqual([first]);
		expect(room.mostHeld).toBe(1);
	});

	it('cuts an activation whose run ignores the abort, and runs what queued behind it', async () => {
		const { room, actor } = playSeat({ stream: deaf });
		const ran = actor.run(first);
		await until(() => room.claims.length === 1);
		await actor.wake(wake(second));
		// the room ended the first lease: the actor moves on now, and the deaf run is left behind
		await actor.cut(first);
		await until(() => room.claims.length === 2);
		expect(room.releases).toEqual([first]);
		await actor.cut(second);
		await ran;
		expect(room.releases).toEqual([first, second]);
		expect(room.mostHeld).toBe(1);
	});

	it('resolves run once every wake that queued behind the activation has run, in order and once each', async () => {
		const hold = heldRelease();
		const { room, actor } = playSeat({ lease: hold.lease });
		const ran = actor.run(first);
		await hold.releasing.promise;
		await actor.wake(wake(second));
		await actor.wake(wake(third));
		// a wake sent twice queues once and keeps the place the first one took;
		// the wake of the activation that is releasing runs no second time
		await actor.wake(wake(second));
		await actor.wake(wake(first));
		hold.letGo.resolve();
		await ran;
		expect(room.claims).toEqual([first, second, third]);
		expect(room.releases).toEqual([first, second, third]);
		expect(room.mostHeld).toBe(1);
	});
});

describe('runner liveness', () => {
	it('uses a ten second default timeout for room calls', () => {
		expect(hostingOf(createRuntime({ clock: fakeClock(0) })).limits.call.timeout).toBe(10_000);
	});

	it('does not start an activation from an already-expired claim', async () => {
		let providerCalls = 0;
		const { actor, clock, room } = playSeat({
			stream: scripted(() => {
				providerCalls += 1;
				return quiet();
			}),
			lease: (request) =>
				request.activation === first && request.operation === 'claim'
					? ok(clock, clock.now() - 1)
					: undefined,
		});
		await actor.run(first);
		expect(providerCalls).toBe(0);
		expect(room.of('renew', first)).toHaveLength(0);
		expect(room.of('release', first)).toEqual([expect.objectContaining({ reason: 'failed' })]);
		await actor.run(second);
		expect(providerCalls).toBe(1);
		expect(room.of('claim', second)).toHaveLength(1);
	});

	it('bounds lost claim and release calls by the configured attempts', async () => {
		const events: string[] = [];
		const { actor, clock, room } = playSeat({
			call: { attempts: 2, timeout: 100 },
			lease: (request) =>
				(request.activation === first && request.operation === 'claim') ||
				(request.activation === second && request.operation === 'release')
					? never()
					: undefined,
			emit: (event) => {
				if (event.type === 'delivery_error') events.push(event.operation);
			},
		});
		const firstRun = actor.run(first);
		await until(() => room.calls.length === 1);
		await clock.advance(200);
		await firstRun;
		const secondRun = actor.run(second);
		await until(() => room.of('release', second).length > 0);
		await clock.advance(200);
		await secondRun;
		expect(room.of('claim', first)).toHaveLength(2);
		expect(room.of('release', second)).toHaveLength(2);
		expect(events).toEqual(['claim', 'release']);
	});

	it.each(['claim', 'view', 'release'] as const)(
		'cuts a hung %s and lets the next wake claim immediately',
		async (hung) => {
			let viewed = false;
			const { actor, room } = playSeat({
				lease: (request) =>
					request.activation === first && request.operation === hung ? never() : undefined,
				view: (id) => {
					viewed = true;
					return hung === 'view' && id === first ? never() : undefined;
				},
			});
			const firstRun = actor.run(first);
			await until(() => (hung === 'view' ? viewed : room.of(hung, first).length > 0));
			await actor.cut(first);
			await actor.wake(wake(second));
			await until(() => room.of('claim', second).length > 0);
			await firstRun;
			expect(room.of('claim', second)).toHaveLength(1);
		},
	);

	it('uses one cut to progress when the cut starts a hung release', async () => {
		const { actor, room, clock } = playSeat({
			stream: deaf,
			call: { attempts: 2, timeout: 100 },
			lease: (request) =>
				request.activation === first && request.operation === 'release' ? never() : undefined,
		});
		const firstRun = actor.run(first);
		await until(() => room.of('claim', first).length > 0);
		await tick();
		await clock.advance(50);
		await until(() => room.of('renew').length > 0);
		await actor.cut(first);
		await actor.wake(wake(second));
		try {
			await until(() => room.of('claim', second).length > 0);
		} finally {
			await clock.advance(200);
			await actor.cut(second);
			await firstRun;
		}
	});

	it('ignores a late claim reply after the next activation starts', async () => {
		const late = pending<LeaseResponse>();
		const starts: string[] = [];
		const { actor, clock, room } = playSeat({
			stream: (model) => {
				starts.push(model.id);
				return createAssistantMessageEventStream();
			},
			lease: (request) =>
				request.activation === first && request.operation === 'claim' ? late.promise : undefined,
		});
		const firstRun = actor.run(first);
		await until(() => room.of('claim', first).length > 0);
		await actor.cut(first);
		await actor.wake(wake(second));
		await until(() => starts.length === 1);
		late.resolve(ok(clock, 10_000));
		await tick();
		await actor.cut(second);
		await firstRun;
		expect(starts).toEqual(['scripted/worker']);
		expect(room.of('release', first)).toHaveLength(0);
	});

	it('does not rearm a renewal that replies after a cut', async () => {
		const late = pending<LeaseResponse>();
		const { actor, room, clock } = playSeat({
			stream: deaf,
			lease: (request) => {
				if (request.activation === first && request.operation === 'renew') return late.promise;
				return request.activation === second ? ok(clock, 100_000) : undefined;
			},
		});
		const firstRun = actor.run(first);
		await until(() => room.of('claim', first).length > 0);
		await tick();
		await clock.advance(50);
		await until(() => room.of('renew', first).length > 0);
		await actor.cut(first);
		await actor.wake(wake(second));
		await until(() => room.of('claim', second).length > 0);
		late.resolve(ok(clock, 10_000));
		await clock.advance(9_950);
		expect(room.of('renew', first)).toHaveLength(1);
		await actor.cut(second);
		await firstRun;
	});

	/**
	 * The lease expires at 100 and the runner renews at 50. A refused renewal
	 * cuts the activation at once. Any other renewal that does not move the
	 * expiry leaves the activation to run until the expiry it holds. The row
	 * whose renewal never resolves holds a room call open for 10 seconds, so
	 * the lease expiry cuts the activation before the call times out.
	 */
	it.each([
		{
			renewal: 'the room refuses',
			answer: () => ({ stale: 'ended' }),
			cutAt: 50,
			reason: 'released',
		},
		{
			renewal: 'never reaches the room',
			answer: () => Promise.reject(new Error('renewal lost')),
			cutAt: 100,
			reason: 'failed',
			events: ['renew'],
		},
		{
			renewal: 'never resolves',
			answer: () => never<LeaseResponse>(),
			call: { attempts: 1, timeout: 10_000 },
			cutAt: 100,
			reason: 'failed',
		},
		{
			renewal: 'moves the expiry nowhere',
			answer: () => ({ ok: { expiresAt: 100, lastSeq: 1 } }),
			cutAt: 100,
			reason: 'failed',
		},
	])(
		'cuts the activation at $cutAt as $reason when the renewal $renewal',
		async ({ answer, call, cutAt, reason, events }) => {
			const reported: string[] = [];
			const { actor, room, clock } = playSeat({
				stream: deaf,
				...(call === undefined ? {} : { call }),
				lease: (request) => (request.operation === 'renew' ? answer() : undefined),
				emit: (event) => {
					if (event.type === 'delivery_error') reported.push(event.operation);
				},
			});
			const run = actor.run(first);
			await until(() => room.claims.length === 1);
			// the claim is answered; one tick lets the actor arm its renewal alarm
			await tick();
			await clock.advance(50);
			await until(() => room.of('renew').length > 0);
			expect(reported).toEqual(events ?? []);
			if (cutAt > 50) {
				await clock.advance(cutAt - 51);
				expect(room.releases).toEqual([]);
				await clock.advance(1);
			}
			await run;
			expect(room.of('release')).toEqual([expect.objectContaining({ activation: first, reason })]);
		},
	);

	it('fails and reports an activation whose view is lost, even when the diagnostic callback throws', async () => {
		const events: { type: string; activation: string; cause?: string }[] = [];
		const { actor, room } = playSeat({
			view: async () => {
				throw new Error('view unavailable');
			},
			emit: (event) => {
				if (event.type === 'error' || event.type === 'delivery_error')
					events.push({
						type: event.type,
						activation: event.activation,
						cause: 'cause' in event ? event.cause : undefined,
					});
				throw new Error('diagnostic listener failed');
			},
		});
		await actor.run(first);
		await actor.run(second);
		expect(room.claims).toEqual([first, second]);
		expect(room.of('release')).toEqual([
			expect.objectContaining({ activation: first, reason: 'failed' }),
			expect.objectContaining({ activation: second, reason: 'failed' }),
		]);
		expect(events).toContainEqual({ type: 'delivery_error', activation: first, cause: undefined });
		expect(events).toContainEqual({ type: 'error', activation: first, cause: 'transient' });
	});

	it('keeps an applied commit when its reply is lost', async () => {
		let commits = 0;
		const events: string[] = [];
		const { actor, clock, room } = playSeat({
			stream: scripted((_context, _agent, call) =>
				call === 1 ? speak('recorded before the reply is lost') : quiet(),
			),
			call: { attempts: 1, timeout: 100 },
			commit: () => {
				commits += 1;
				return never<CommitResult>();
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
		expect(room.releases).toEqual([first]);
	});

	it('keeps cancelled and stale responses out of delivery errors', async () => {
		const events: string[] = [];
		const late = pending<LeaseResponse>();
		const { actor, clock, room } = playSeat({
			call: { attempts: 1, timeout: 100 },
			lease: (request) => {
				if (request.operation !== 'claim') return undefined;
				return request.activation === first ? late.promise : { stale: 'ended' };
			},
			emit: (event) => {
				if (event.type === 'delivery_error') events.push(event.operation);
			},
		});
		const firstRun = actor.run(first);
		await until(() => room.of('claim', first).length > 0);
		await actor.cut(first);
		await actor.wake(wake(second));
		await firstRun;
		late.resolve(ok(clock));
		expect(events).toEqual([]);
	});
});

describe('async seat model resolution', () => {
	const model = stubModel('scripted/worker', 'worker') as Model<Api>;

	it('does not start a provider request when model resolution finishes after a cut', async () => {
		const ready = pending<Model<Api>>();
		const started = deferred();
		const resolved = deferred();
		let providerCalls = 0;
		const { room, actor } = playSeat({
			stream: scripted(() => {
				providerCalls += 1;
				return quiet();
			}),
			model: async () => {
				started.resolve();
				const value = await ready.promise;
				resolved.resolve();
				return value;
			},
		});
		const running = actor.run(first);
		await started.promise;
		expect(room.claims).toEqual([first]);
		await actor.cut(first);
		await running;
		ready.resolve(model);
		await resolved.promise;
		await tick();
		expect(providerCalls).toBe(0);
		expect(room.of('release')).toEqual([expect.objectContaining({ reason: 'released' })]);
	});

	it('ends the lease as failed when model resolution rejects', async () => {
		const { room, actor } = playSeat({
			model: async () => {
				throw new Error('catalog failed');
			},
		});
		await actor.run(first);
		expect(room.of('release')).toEqual([expect.objectContaining({ reason: 'failed' })]);
	});

	it('keeps a steer held during model resolution and acknowledges it at provider input', async () => {
		const ready = pending<Model<Api>>();
		const started = deferred();
		const contexts: Context[] = [];
		let lastSeq = 1;
		const base = scripted(() => quiet());
		const stream: StreamFn = (resolved, context, options) => {
			contexts.push({ ...context, messages: [...context.messages] });
			return base(resolved, context, options);
		};
		const { room, actor, clock } = playSeat({
			stream,
			model: async () => {
				started.resolve();
				return ready.promise;
			},
			lease: () => ok(clock, clock.now() + 60_000, lastSeq),
		});
		const running = actor.run(first);
		await started.promise;
		await actor.steer({ ...steer(first, 2, 'Follow up') });
		lastSeq = 2;
		ready.resolve(model);
		await running;

		expect(contexts.length).toBeGreaterThanOrEqual(2);
		expect(contextText(contexts[0] as Context)).not.toContain('Follow up');
		expect(contextText(contexts[1] as Context)).toContain('Follow up');
		expect(room.of('release')).toEqual([expect.objectContaining({ readThrough: 2 })]);
	});
});
