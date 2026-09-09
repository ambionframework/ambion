/**
 * The seat's side of the wire, driven by hand over a room the test plays:
 * one activation at a time, and whatever queued behind it runs next.
 */
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
	/** How many activations hold a lease now, and the most that ever did at once. */
	private holding = 0;
	mostHeld = 0;
	/** Resolves when the first release starts. */
	readonly releasing = deferred();
	/** The first release waits here. */
	readonly letGo = deferred();

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
			// A claim carries no `heard`; a renewal does.
			if (lease.heard === undefined) this.claimed(lease.activation);
			return ok;
		}
		if (this.releases.length === 0) {
			this.releasing.resolve();
			await this.letGo.promise;
		}
		this.holding -= 1;
		this.releases.push(lease.activation);
		return ok;
	}

	private claimed(id: string): void {
		this.claims.push(id);
		this.holding += 1;
		this.mostHeld = Math.max(this.mostHeld, this.holding);
	}
}

function play() {
	const clock = fakeClock();
	const runtime = createRuntime({ clock, agents: [product], stream: scripted(() => quiet()) });
	const room = new PlayedRoom(clock);
	const actor = new SeatActor(room, {
		runtime,
		room: 'played',
		seat: 'product',
		sessions: runtime.sessions,
		stream: runtime.stream,
		model: runtime.model,
	});
	return { room, actor };
}

const wakeOf = (activation: string): Wake => ({ room: 'played', seat: 'product', activation });

async function until(done: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !done(); i += 1) await tick();
	if (!done()) throw new Error('the seat never got there');
}

describe('a seat actor', () => {
	it('runs one activation at a time: a wake that lands during the release runs next', async () => {
		const { room, actor } = play();
		void actor.wake(wakeOf('1:product'));
		await room.releasing.promise;
		// the first activation is over and its release is in flight: a message
		// that lands now is not steered into it, and it runs no second activation beside it
		await actor.wake({ ...wakeOf('2:product'), steer: { seq: 2, line: '[priya] And the pump?' } });
		room.letGo.resolve();
		await until(() => room.releases.length === 2);
		expect(room.claims).toEqual(['1:product', '2:product']);
		expect(room.mostHeld).toBe(1);
	});

	it('resolves run once what queued behind the activation has run too, in order, once each', async () => {
		const { room, actor } = play();
		const ran = actor.run('1:product');
		await room.releasing.promise;
		await actor.wake(wakeOf('2:product'));
		await actor.wake(wakeOf('3:product'));
		// a wake sent twice queues once
		await actor.wake(wakeOf('2:product'));
		room.letGo.resolve();
		await ran;
		expect(room.claims).toEqual(['1:product', '2:product', '3:product']);
		expect(room.releases).toEqual(['1:product', '2:product', '3:product']);
		expect(room.mostHeld).toBe(1);
	});
});
