import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { Api, Context, Model } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { type Clock, createRuntime, defineAgent } from '../src/index.ts';
import {
	type CommitResult,
	type LeaseRequest,
	type LeaseResponse,
	SeatActor,
	type SeatRoom,
	type ViewResponse,
} from '../src/transport.ts';
import { fakeClock } from './support/clock.ts';
import { tick } from './support/room.ts';
import { quiet, scripted } from './support/scripted.ts';

const product = defineAgent({
	name: 'product',
	identity: 'The one product.',
	instructions: 'answer',
	model: 'scripted/product',
});

const model = {
	id: 'scripted/product',
	name: 'Product',
	api: 'scripted',
	provider: 'scripted',
} as unknown as Model<Api>;

class ModelRoom implements SeatRoom {
	readonly claims: string[] = [];
	readonly releases: Extract<LeaseRequest, { operation: 'release' }>[] = [];
	lastSeq = 1;

	constructor(private readonly clock: Clock) {}

	async view(activation: string): Promise<ViewResponse> {
		return {
			view: {
				spec: {
					id: activation,
					seat: product.name,
					attempt: 1,
					cause: 'message',
					through: 1,
					grant: { kind: 'say', tool: 'say' },
				},
				model: product.model,
				systemPrompt: 'You are the product.',
				context: 'The record so far.',
			},
		};
	}

	async commit(): Promise<CommitResult> {
		return { refused: 'nothing lands here' };
	}

	async lease(lease: LeaseRequest): Promise<LeaseResponse> {
		if (lease.operation === 'claim') this.claims.push(lease.activation);
		if (lease.operation === 'release') this.releases.push(lease);
		return { ok: { expiresAt: this.clock.now() + 60_000, lastSeq: this.lastSeq } };
	}
}

function actorFor(
	room: ModelRoom,
	clock: Clock,
	stream: StreamFn,
	modelResolver: (id: string, agent: string) => Promise<Model<Api>>,
) {
	const runtime = createRuntime({ clock, stream });
	return new SeatActor(room, {
		clock,
		call: runtime.call,
		definition: product,
		room: 'model-test',
		seat: product.name,
		transcripts: runtime.transcripts,
		stream: runtime.stream,
		model: modelResolver,
	});
}

const wake = 'message:1:product:1';

function deferredValue<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe('async seat model resolution', () => {
	it('does not start a provider request when model resolution finishes after a cut', async () => {
		const clock = fakeClock();
		const room = new ModelRoom(clock);
		const modelReady = deferredValue<Model<Api>>();
		const resolverStarted = deferredValue<void>();
		const modelResolved = deferredValue<void>();
		let providerCalls = 0;
		const stream = scripted(() => {
			providerCalls += 1;
			return quiet();
		});
		const actor = actorFor(room, clock, stream, async () => {
			resolverStarted.resolve();
			const resolved = await modelReady.promise;
			modelResolved.resolve();
			return resolved;
		});
		const running = actor.run(wake);

		await resolverStarted.promise;
		expect(room.claims).toEqual([wake]);
		await actor.cut(wake);
		await running;
		modelReady.resolve(model);
		await modelResolved.promise;
		await tick();

		expect(providerCalls).toBe(0);
		expect(room.releases[0]?.reason).toBe('released');
	});

	it('ends the lease as failed when model resolution rejects', async () => {
		const clock = fakeClock();
		const room = new ModelRoom(clock);
		const stream = scripted(() => quiet());
		const actor = actorFor(room, clock, stream, async () => {
			throw new Error('catalog failed');
		});

		await actor.run(wake);

		expect(room.releases).toHaveLength(1);
		expect(room.releases[0]?.reason).toBe('failed');
	});

	it('keeps a steer held during model resolution and acknowledges it at provider input', async () => {
		const clock = fakeClock();
		const room = new ModelRoom(clock);
		const modelReady = deferredValue<Model<Api>>();
		const resolverStarted = deferredValue<void>();
		const contexts: Context[] = [];
		const base = scripted(() => quiet());
		const stream: StreamFn = (resolved, context, options) => {
			contexts.push({ ...context, messages: [...context.messages] });
			return base(resolved, context, options);
		};
		const actor = actorFor(room, clock, stream, async () => {
			resolverStarted.resolve();
			return modelReady.promise;
		});
		const running = actor.run(wake);

		await resolverStarted.promise;
		await actor.wake({
			room: 'model-test',
			seat: product.name,
			activation: 'message:2:product:1',
			steer: { after: 1, seq: 2, line: '[priya] Follow up' },
		});
		room.lastSeq = 2;
		modelReady.resolve(model);
		await running;

		expect(contexts.length).toBeGreaterThanOrEqual(2);
		const requestText = (index: number) =>
			contexts[index]?.messages
				.map((message) =>
					typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
				)
				.join('\n') ?? '';
		expect(requestText(0)).not.toContain('Follow up');
		expect(requestText(1)).toContain('Follow up');
		expect(room.releases[0]?.readThrough).toBe(2);
	});
});
