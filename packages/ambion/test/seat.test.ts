/**
 * The seat's side of the wire, driven by hand over a room the test plays:
 * one activation at a time, a steer into the one that runs, and whatever
 * queued behind it runs next.
 */

import type { SessionOpener } from '@ambionframework/pi-journal';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import {
	AgentRunner,
	type CommitResult,
	createPiExecutor,
	hostingOf,
	type LeaseRequest,
	type LeaseResponse,
	type SeatRoom,
	type Steer,
	type ViewResponse,
	type Wake,
} from '../src/hosting.ts';
import type { Message } from '../src/index.ts';
import { type Clock, createRuntime, defineAgent, pi } from '../src/index.ts';
import { fakeClock } from './support/clock.ts';
import { deferred, tick } from './support/room.ts';
import { contextText, quiet, scripted } from './support/scripted.ts';

const product = defineAgent({
	name: 'product',
	identity: 'The one product.',
	executor: pi({ instructions: 'answer', model: 'scripted/product' }),
});

/**
 * A room the test plays. It grants every claim, and it holds the first
 * release until the test lets go, so a wake can land while a finished
 * activation is still releasing its lease.
 */
class PlayedRoom implements SeatRoom {
	readonly claims: string[] = [];
	readonly releases: string[] = [];
	/** The leases held now, and the most that were ever held at once. */
	private readonly holding = new Set<string>();
	mostHeld = 0;
	/** Resolves when the first release starts. */
	readonly releasing = deferred();
	/** The first release waits here. */
	readonly letGo = deferred();
	/** Every renewal from now on is answered stale: the room ended the lease. */
	refuseRenewals = false;
	/** Every renewal from now on never reaches the room. */
	loseRenewals = false;
	/** Every renewal from now on moves the expiry nowhere: the lease reached its deadline. */
	capRenewals: number | undefined;

	constructor(private readonly clock: Clock) {}

	async view(activation: string): Promise<ViewResponse> {
		return {
			view: {
				spec: {
					id: activation,
					seat: 'product',
					attempt: 1,
					purpose: { kind: 'respond', message: 1 },
				},
				through: 1,
				context: { name: 'played', now: 0, participants: [], messages: [], reserve: [] },
			},
		};
	}

	async commit(): Promise<CommitResult> {
		return { refused: 'nothing lands here' };
	}

	async lease(lease: LeaseRequest): Promise<LeaseResponse> {
		const ok = { ok: { expiresAt: this.clock.now() + 60_000, lastSeq: 1 } };
		if (lease.operation === 'claim' || lease.operation === 'renew') {
			// A lease not yet held is a claim; one held is a renewal.
			if (lease.operation === 'claim') {
				this.claimed(lease.activation);
				return ok;
			}
			if (this.loseRenewals) throw new Error('the renewal never reached the room');
			if (this.refuseRenewals) return { stale: 'the lease ended' };
			return this.capRenewals === undefined
				? ok
				: { ok: { expiresAt: this.capRenewals, lastSeq: 1 } };
		}
		if (lease.operation === 'release' && this.releases.length === 0) {
			this.releasing.resolve();
			await this.letGo.promise;
		}
		this.holding.delete(lease.activation);
		this.releases.push(lease.activation);
		return ok;
	}

	private claimed(id: string): void {
		this.claims.push(id);
		this.holding.add(id);
		this.mostHeld = Math.max(this.mostHeld, this.holding.size);
	}
}

/** A model call that never answers and never hears an abort. */
const deaf: StreamFn = () => createAssistantMessageEventStream();

function play(stream: StreamFn = scripted(() => quiet()), transcripts?: SessionOpener) {
	const clock = fakeClock();
	const runtime = createRuntime({ clock, stream });
	const room = new PlayedRoom(clock);
	const executor = createPiExecutor({
		definition: product,
		model: hostingOf(runtime).model,
		stream: hostingOf(runtime).stream,
		transcripts: transcripts ?? hostingOf(runtime).transcripts,
		room: 'played',
		now: () => clock.now(),
	});
	const actor = new AgentRunner(room, {
		clock,
		call: hostingOf(runtime).call,
		definition: product,
		room: 'played',
		seat: 'product',
		executor,
	});
	return { room, actor, clock, runtime };
}

const wakeOf = (activation: string): Wake => ({ room: 'played', seat: 'product', activation });
const steerOf = (activation: string, seq = 2, text = 'And the pump?'): Steer => ({
	room: 'played',
	seat: 'product',
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

async function until(done: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !done(); i += 1) await tick();
	if (!done()) throw new Error('the seat never got there');
}

describe('a seat actor', () => {
	it('ignores a delayed steer when its target activation has already finished', async () => {
		const started = deferred();
		const release = deferred();
		const contexts: string[] = [];
		const { room, actor } = play(
			scripted(async (context, _agent, call) => {
				contexts.push(contextText(context));
				if (call === 2) {
					started.resolve();
					await release.promise;
				}
				return quiet();
			}),
		);
		room.letGo.resolve();
		await actor.run('message:1:product:1');
		const later = actor.run('message:3:product:1');
		try {
			await started.promise;
			await actor.steer(
				steerOf('message:1:product:1', 2, 'Obsolete context from the earlier activation.'),
			);
			release.resolve();
			await later;
			expect(contexts.every((context) => !context.includes('Obsolete context'))).toBe(true);
			expect(room.claims).toEqual(['message:1:product:1', 'message:3:product:1']);
			expect(room.mostHeld).toBe(1);
		} finally {
			release.resolve();
			await actor.cut('message:3:product:1');
		}
	});

	it('ignores steering while idle without claiming work', async () => {
		const { room, actor } = play();
		await actor.steer(steerOf('message:1:product:1'));
		await tick();
		expect(room.claims).toEqual([]);
	});

	it('ignores steering while its target releases without queuing work', async () => {
		const { room, actor } = play();
		const running = actor.run('message:1:product:1');
		try {
			await room.releasing.promise;
			await actor.steer(steerOf('message:1:product:1'));
		} finally {
			room.letGo.resolve();
			await running;
		}
		expect(room.claims).toEqual(['message:1:product:1']);
		expect(room.releases).toEqual(['message:1:product:1']);
	});

	it('queues a wake that lands while the activation releases', async () => {
		const { room, actor } = play();
		void actor.wake(wakeOf('message:1:product:1'));
		await room.releasing.promise;
		// the activation is over and its release is in flight: it reads nothing more,
		// so the message runs as an activation of its own, and none runs beside it
		await actor.wake(wakeOf('message:2:product:1'));
		room.letGo.resolve();
		await until(() => room.releases.length === 2);
		expect(room.claims).toEqual(['message:1:product:1', 'message:2:product:1']);
		expect(room.mostHeld).toBe(1);
	});

	it('takes a wake to its end: it claims the lease, runs, and releases', async () => {
		const { room, actor } = play();
		room.letGo.resolve();
		await actor.wake(wakeOf('message:1:product:1'));
		await until(() => room.releases.length === 1);
		expect(room.claims).toEqual(['message:1:product:1']);
		expect(room.releases).toEqual(['message:1:product:1']);
		expect(room.mostHeld).toBe(1);
	});

	it('reopens the audit session after its first open fails', async () => {
		let opens = 0;
		let base: SessionOpener | undefined;
		const transcripts: SessionOpener = {
			async open(id, parent) {
				opens += 1;
				if (opens === 1) throw new Error('audit open failed');
				if (base === undefined) throw new Error('base session opener is absent');
				return base.open(id, parent);
			},
		};
		const fixture = play(undefined, transcripts);
		base = hostingOf(fixture.runtime).transcripts;
		fixture.room.letGo.resolve();
		await fixture.actor.run('message:1:product:1');

		expect(opens).toBe(2);
		expect(fixture.room.releases).toEqual(['message:1:product:1']);
	});

	it('steers a recorded message into its running activation without starting work', async () => {
		const gate = deferred();
		const { room, actor } = play(
			scripted(async () => {
				await gate.promise;
				return quiet();
			}),
		);
		room.letGo.resolve();
		void actor.wake(wakeOf('message:1:product:1'));
		await until(() => room.claims.length === 1);
		await actor.steer(steerOf('message:1:product:1'));
		await tick();
		expect(room.claims).toEqual(['message:1:product:1']);
		gate.resolve();
		await until(() => room.releases.length === 1);
		expect(room.claims).toEqual(['message:1:product:1']);
		expect(room.mostHeld).toBe(1);
	});

	it('cuts an activation whose run ignores the abort, and runs what queued behind it', async () => {
		const { room, actor } = play(deaf);
		room.letGo.resolve();
		const ran = actor.run('message:1:product:1');
		await until(() => room.claims.length === 1);
		await actor.wake(wakeOf('message:2:product:1'));
		// the room ended the first lease: the actor moves on now, and the deaf run is left behind
		await actor.cut('message:1:product:1');
		await until(() => room.claims.length === 2);
		expect(room.releases).toEqual(['message:1:product:1']);
		await actor.cut('message:2:product:1');
		await ran;
		expect(room.releases).toEqual(['message:1:product:1', 'message:2:product:1']);
		expect(room.mostHeld).toBe(1);
	});

	it('cuts the activation when the room refuses its renewal', async () => {
		const { room, actor, clock } = play(deaf);
		room.letGo.resolve();
		const ran = actor.run('message:1:product:1');
		await until(() => room.claims.length === 1);
		// the room answers the renewal stale: the lease ended, so nothing this
		// activation writes lands, and the actor stops waiting on it
		room.refuseRenewals = true;
		// the claim is answered; one tick lets the actor arm its renewal alarm
		await tick();
		await clock.advance(31_000);
		await ran;
		expect(room.releases).toEqual(['message:1:product:1']);
	});

	it('cuts the activation at the expiry it held when a renewal never reached the room', async () => {
		const { room, actor, clock } = play(deaf);
		room.letGo.resolve();
		const ran = actor.run('message:1:product:1');
		await until(() => room.claims.length === 1);
		// the renewal is lost, so the room expires the lease where it stands: the
		// actor waits for that expiry and cuts the activation there, not before
		room.loseRenewals = true;
		await tick();
		await clock.advance(31_000);
		expect(room.releases).toEqual([]);
		await clock.advance(30_000);
		await ran;
		expect(room.releases).toEqual(['message:1:product:1']);
	});

	it('cuts the activation at the deadline, when a renewal moves the expiry nowhere', async () => {
		const { room, actor, clock } = play(deaf);
		room.letGo.resolve();
		const deadline = clock.now() + 60_000;
		const ran = actor.run('message:1:product:1');
		await until(() => room.claims.length === 1);
		// the room renews no further: the lease reached its deadline, and the
		// actor cuts the activation there, not at the renewal that said so
		room.capRenewals = deadline;
		await tick();
		await clock.advance(31_000);
		expect(room.releases).toEqual([]);
		await clock.advance(30_000);
		await ran;
		expect(room.releases).toEqual(['message:1:product:1']);
	});

	it('resolves run once every wake that queued behind the activation has run, in order and once each', async () => {
		const { room, actor } = play();
		const ran = actor.run('message:1:product:1');
		await room.releasing.promise;
		await actor.wake(wakeOf('message:2:product:1'));
		await actor.wake(wakeOf('message:3:product:1'));
		// a wake sent twice queues once and keeps the place the first one took;
		// the wake of the activation that is releasing runs no second time
		await actor.wake(wakeOf('message:2:product:1'));
		await actor.wake(wakeOf('message:1:product:1'));
		room.letGo.resolve();
		await ran;
		expect(room.claims).toEqual([
			'message:1:product:1',
			'message:2:product:1',
			'message:3:product:1',
		]);
		expect(room.releases).toEqual([
			'message:1:product:1',
			'message:2:product:1',
			'message:3:product:1',
		]);
		expect(room.mostHeld).toBe(1);
	});
});
