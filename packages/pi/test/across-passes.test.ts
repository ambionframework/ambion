/**
 * One Pi agent serves every pass of an activation. The first pass hands the
 * model the whole view. A later pass hands it the delta: the messages that
 * landed beyond `readThrough`. The transcript and the audit stay whole.
 */
import { type Clock, createRuntime, defineAgent, type Message } from '@ambionframework/ambion';
import {
	AgentRunner,
	type CommitResult,
	type LeaseRequest,
	type LeaseResponse,
	type RoomProtocol,
	type ViewResponse,
} from '@ambionframework/ambion/hosting';
import type { Context } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { fakeClock } from '../../ambion/test/support/clock.ts';
import { tick } from '../../ambion/test/support/room.ts';
import { contextText, quiet, scripted } from '../../ambion/test/support/scripted.ts';
import { noTraces } from '../../ambion/test/support/trace.ts';
import { createExecutionServices, createPiExecutor, pi, seatSessionId } from '../src/index.ts';

const product = defineAgent({
	name: 'product',
	identity: 'The one product.',
	executor: pi({ instructions: 'answer', model: 'scripted/product' }),
});

const said = (seq: number, text: string): Message => ({
	kind: 'said',
	seq,
	at: '2026-01-01T09:00:00.000Z',
	from: 'andrei',
	text,
});

/** A room that serves one view per call to `view`, and reports the newest position on each renewal. */
class MovingRoom implements RoomProtocol {
	readonly views: number[] = [];
	readonly renewals: number[] = [];

	constructor(
		private readonly clock: Clock,
		/** The record each successive view holds. The last one repeats. */
		private readonly records: readonly (readonly Message[])[],
		/** The room position each renewal reports, one per renewal. The last repeats. */
		private readonly positions: readonly number[],
	) {}

	async view(activation: string): Promise<ViewResponse> {
		const record = this.records[Math.min(this.views.length, this.records.length - 1)] ?? [];
		this.views.push(record.length);
		return {
			view: {
				spec: {
					id: activation,
					seat: 'product',
					attempt: 1,
					purpose: { kind: 'respond', message: 1 },
				},
				through: this.positions[Math.min(this.views.length - 1, this.positions.length - 1)] ?? 1,
				context: {
					name: 'passes',
					now: 0,
					participants: [],
					messages: [...record],
					reserve: [],
				},
			},
		};
	}

	async commit(): Promise<CommitResult> {
		return { refused: 'nothing lands here' };
	}

	async lease(lease: LeaseRequest): Promise<LeaseResponse> {
		const expiresAt = this.clock.now() + 60_000;
		if (lease.operation !== 'renew') return { ok: { expiresAt, lastSeq: 1 } };
		const index = Math.min(this.renewals.length, this.positions.length - 1);
		this.renewals.push(lease.readThrough ?? 0);
		return { ok: { expiresAt, lastSeq: this.positions[index + 1] ?? this.positions.at(-1) ?? 1 } };
	}
}

function play(room: MovingRoom, seen: Context[]) {
	const clock = fakeClock();
	const runtime = createRuntime({ clock });
	const services = createExecutionServices({
		storage: runtime.storage,
		clock,
		stream: scripted((context) => {
			seen.push({ ...context, messages: [...context.messages] });
			return quiet();
		}),
	});
	const executor = createPiExecutor({
		definition: product,
		model: services.model,
		stream: services.stream,
		transcripts: services.transcripts,
		room: 'passes',
		now: () => clock.now(),
	});
	const actor = new AgentRunner(room, {
		clock,
		call: services.call,
		definition: product,
		room: 'passes',
		seat: 'product',
		executor,
		trace: noTraces,
	});
	return { actor, services };
}

const texts = (context: Context) =>
	context.messages.map((message) => contextText({ ...context, messages: [message] }));

describe('the Pi executor across the passes of one activation', () => {
	it('keeps one agent, and prompts a later pass with the delta alone', async () => {
		const first = [said(1, 'Can we ship?')];
		const later = [...first, said(2, 'And the pump?')];
		const room = new MovingRoom(fakeClock(), [first, later], [1, 2, 2]);
		const seen: Context[] = [];
		const { actor } = play(room, seen);
		await actor.run('message:1:product:1');
		await tick();

		expect(seen).toHaveLength(2);
		const [before, after] = seen;
		expect(before?.messages).toHaveLength(1);
		// The second request carries the first pass whole, then only what is new.
		expect(after?.messages.length).toBeGreaterThan(2);
		const prompts = texts(after as Context).filter((text) => text.length > 0);
		expect(prompts[0]).toContain("The record of 'passes' so far:");
		const last = prompts.at(-1) ?? '';
		expect(last).toContain('[new]');
		expect(last).toContain('And the pump?');
		expect(last).not.toContain('The record of');
		expect(last).not.toContain('Can we ship?');
	});

	it('writes one activation entry and every turn once to the audit', async () => {
		const first = [said(1, 'Can we ship?')];
		const later = [...first, said(2, 'And the pump?')];
		const room = new MovingRoom(fakeClock(), [first, later], [1, 2, 2]);
		const { actor, services } = play(room, []);
		await actor.run('message:1:product:1');
		await tick();

		const audit = await services.transcripts.open(seatSessionId('passes', 'product'));
		const entries = await audit.findEntries({ order: 'oldestFirst' });
		const markers = entries.filter(
			(entry) => entry.type === 'custom' && entry.customType === 'ambion/activation',
		);
		const turns = entries.filter((entry) => entry.type === 'message');
		expect(markers).toHaveLength(1);
		// Two prompts and two answers: nothing from the first pass repeats.
		expect(turns).toHaveLength(4);
	});

	it('advances readThrough at the provider request for the delta', async () => {
		const first = [said(1, 'Can we ship?')];
		const later = [...first, said(2, 'And the pump?')];
		const room = new MovingRoom(fakeClock(), [first, later], [1, 2, 2]);
		const { actor } = play(room, []);
		await actor.run('message:1:product:1');
		await tick();

		// The renewals name what the seat had read: the first pass, then the delta.
		expect(room.renewals.at(-1)).toBe(2);
	});

	it('starts no run when the record moved and no message came with it', async () => {
		const only = [said(1, 'Can we ship?')];
		// The room position moves to 2 with no message: an entry a model does not read.
		const room = new MovingRoom(fakeClock(), [only], [1, 2, 2]);
		const seen: Context[] = [];
		const { actor } = play(room, seen);
		await actor.run('message:1:product:1');
		await tick();

		expect(seen).toHaveLength(1);
		expect(room.renewals.at(-1)).toBe(2);
	});
});
