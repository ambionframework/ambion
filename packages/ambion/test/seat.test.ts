/**
 * The seat's side of the wire, driven by hand over a room the test plays:
 * one activation at a time, a steer into the one that runs, and whatever
 * queued behind it runs next.
 */
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import {
	type Clock,
	type CommitResponse,
	createRuntime,
	defineAgent,
	type Lease,
	type LeaseResponse,
	SeatActor,
	type SeatRoom,
	type ViewResponse,
	type Wake,
} from '../src/index.ts';
import { fakeClock } from './support/clock.ts';
import { deferred, tick } from './support/room.ts';
import { quiet, scripted } from './support/scripted.ts';

const product = defineAgent({
	name: 'product',
	identity: 'The one product.',
	instructions: 'answer',
	model: 'scripted/product',
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

	constructor(private readonly clock: Clock) {}

	async view(activation: string): Promise<ViewResponse> {
		return {
			view: {
				activation,
				seat: 'product',
				model: 'scripted/product',
				lastSeq: 1,
				systemPrompt: 'You are the product.',
				context: 'The record so far.',
				hand: 'say',
			},
		};
	}

	async commit(): Promise<CommitResponse> {
		return { refused: 'nothing lands here' };
	}

	async lease(lease: Lease): Promise<LeaseResponse> {
		const ok = { ok: { expiry: this.clock.now() + 60_000, lastSeq: 1 } };
		if (lease.phase === 'running') {
			// A lease not yet held is a claim; one held is a renewal.
			if (!this.holding.has(lease.activation)) {
				this.claimed(lease.activation);
				return ok;
			}
			if (this.loseRenewals) throw new Error('the renewal never reached the room');
			return this.refuseRenewals ? { stale: 'the lease ended' } : ok;
		}
		if (this.releases.length === 0) {
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

function play(stream: StreamFn = scripted(() => quiet())) {
	const clock = fakeClock();
	const runtime = createRuntime({ clock, stream });
	runtime.catalog.set(product.name, product);
	const room = new PlayedRoom(clock);
	const actor = new SeatActor(room, {
		clock,
		catalog: runtime.catalog,
		room: 'played',
		seat: 'product',
		sessions: runtime.sessions,
		stream: runtime.stream,
		model: runtime.model,
	});
	return { room, actor, clock };
}

const wakeOf = (activation: string): Wake => ({ room: 'played', seat: 'product', activation });

async function until(done: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !done(); i += 1) await tick();
	if (!done()) throw new Error('the seat never got there');
}

describe('a seat actor', () => {
	it('queues a wake that lands while the activation releases, and steers it into nothing', async () => {
		const { room, actor } = play();
		void actor.wake(wakeOf('1:product'));
		await room.releasing.promise;
		// the activation is over and its release is in flight: it reads nothing more,
		// so the message runs as an activation of its own, and none runs beside it
		await actor.wake({ ...wakeOf('2:product'), steer: { seq: 2, line: '[priya] And the pump?' } });
		room.letGo.resolve();
		await until(() => room.releases.length === 2);
		expect(room.claims).toEqual(['1:product', '2:product']);
		expect(room.mostHeld).toBe(1);
	});

	it('takes a wake to its end: it claims the lease, runs, and releases', async () => {
		const { room, actor } = play();
		room.letGo.resolve();
		await actor.wake(wakeOf('1:product'));
		await until(() => room.releases.length === 1);
		expect(room.claims).toEqual(['1:product']);
		expect(room.releases).toEqual(['1:product']);
		expect(room.mostHeld).toBe(1);
	});

	it('steers a wake a message caused into the activation that runs, and starts none beside it', async () => {
		const gate = deferred();
		const { room, actor } = play(
			scripted(async () => {
				await gate.promise;
				return quiet();
			}),
		);
		room.letGo.resolve();
		void actor.wake(wakeOf('1:product'));
		await until(() => room.claims.length === 1);
		await actor.wake({ ...wakeOf('2:product'), steer: { seq: 2, line: '[priya] And the pump?' } });
		await tick();
		expect(room.claims).toEqual(['1:product']);
		gate.resolve();
		await until(() => room.releases.length === 1);
		expect(room.claims).toEqual(['1:product']);
		expect(room.mostHeld).toBe(1);
	});

	it('cuts an activation whose run ignores the abort, and runs what queued behind it', async () => {
		const { room, actor } = play(deaf);
		room.letGo.resolve();
		const ran = actor.run('1:product');
		await until(() => room.claims.length === 1);
		await actor.wake(wakeOf('2:product'));
		// the room ended the first lease: the actor moves on now, and the deaf run is left behind
		await actor.cut('1:product');
		await until(() => room.claims.length === 2);
		expect(room.releases).toEqual(['1:product']);
		await actor.cut('2:product');
		await ran;
		expect(room.releases).toEqual(['1:product', '2:product']);
		expect(room.mostHeld).toBe(1);
	});

	it('cuts the activation when the room refuses its renewal', async () => {
		const { room, actor, clock } = play(deaf);
		room.letGo.resolve();
		const ran = actor.run('1:product');
		await until(() => room.claims.length === 1);
		// the room answers the renewal stale: the lease ended, so nothing this
		// activation writes lands, and the actor stops waiting on it
		room.refuseRenewals = true;
		// the claim is answered; one tick lets the actor arm its renewal alarm
		await tick();
		await clock.advance(31_000);
		await ran;
		expect(room.releases).toEqual(['1:product']);
	});

	it('cuts the activation at the expiry it held when a renewal never reached the room', async () => {
		const { room, actor, clock } = play(deaf);
		room.letGo.resolve();
		const ran = actor.run('1:product');
		await until(() => room.claims.length === 1);
		// the renewal is lost, so the room expires the lease where it stands: the
		// actor waits for that expiry and cuts the activation there, not before
		room.loseRenewals = true;
		await tick();
		await clock.advance(31_000);
		expect(room.releases).toEqual([]);
		await clock.advance(30_000);
		await ran;
		expect(room.releases).toEqual(['1:product']);
	});

	it('resolves run once every wake that queued behind the activation has run, in order and once each', async () => {
		const { room, actor } = play();
		const ran = actor.run('1:product');
		await room.releasing.promise;
		await actor.wake(wakeOf('2:product'));
		await actor.wake(wakeOf('3:product'));
		// a wake sent twice queues once and keeps the place the first one took;
		// the wake of the activation that is releasing runs no second time
		await actor.wake(wakeOf('2:product'));
		await actor.wake(wakeOf('1:product'));
		room.letGo.resolve();
		await ran;
		expect(room.claims).toEqual(['1:product', '2:product', '3:product']);
		expect(room.releases).toEqual(['1:product', '2:product', '3:product']);
		expect(room.mostHeld).toBe(1);
	});
});
