/**
 * A seat runner that a test drives by hand: the core `AgentRunner` over the Pi
 * executor, a fake clock, and a room the test plays.
 */
import { type AgentDefinition, type Clock, createRuntime } from '@ambionframework/ambion';
import {
	type AgentExecutionContext,
	AgentRunner,
	type CommitRequest,
	type CommitResult,
	hostingOf,
	type LeaseRequest,
	type LeaseResponse,
	type RoomProtocol,
	type ViewResponse,
} from '@ambionframework/ambion/hosting';
import { fakeClock } from '@ambionframework/ambion/testing';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { scriptedAgent, tick } from '../../../ambion/test/support/room.ts';
import { quiet, scripted } from '../../../ambion/test/support/scripted.ts';
import { noTraces } from '../../../ambion/test/support/trace.ts';
import { createExecutionServices, createPiExecutor, type ModelResolver } from '../../src/index.ts';

export const worker = scriptedAgent('worker');

/** A granted lease. Absent an expiry, it expires 100 ms from now. */
export const ok = (clock: Clock, expiresAt = clock.now() + 100, lastSeq = 1): LeaseResponse => ({
	ok: { expiresAt, lastSeq },
});

/** A model call that never answers and never hears an abort. */
export const deaf: StreamFn = () => createAssistantMessageEventStream();

export interface PlayedRoomOptions {
	/** An answer for one lease call. `undefined` takes the default: granted for 100 ms. */
	readonly lease?: (
		request: LeaseRequest,
	) => LeaseResponse | undefined | Promise<LeaseResponse | undefined>;
	readonly view?: (id: string) => Promise<ViewResponse> | undefined;
	readonly commit?: (request: CommitRequest) => Promise<CommitResult>;
}

/**
 * A room the test plays. It logs every lease call, and it counts a lease as
 * held from its claim until the room answers its release.
 */
export class PlayedRoom implements RoomProtocol {
	readonly calls: LeaseRequest[] = [];
	private readonly holding = new Set<string>();
	/** The most leases that were ever held at once. */
	mostHeld = 0;

	constructor(
		private readonly clock: Clock,
		private readonly options: PlayedRoomOptions = {},
	) {}

	view(id: string): Promise<ViewResponse> {
		return (
			this.options.view?.(id) ??
			Promise.resolve({
				view: {
					spec: { id, seat: worker.name, attempt: 1, purpose: { kind: 'respond', message: 1 } },
					through: 1,
					context: { name: 'played', now: 0, participants: [], messages: [], reserve: [] },
				},
			})
		);
	}

	async commit(request: CommitRequest): Promise<CommitResult> {
		return this.options.commit?.(request) ?? { refused: 'nothing lands here' };
	}

	async lease(request: LeaseRequest): Promise<LeaseResponse> {
		this.calls.push(request);
		if (request.operation === 'claim') {
			this.holding.add(request.activation);
			this.mostHeld = Math.max(this.mostHeld, this.holding.size);
		}
		const answer = (await this.options.lease?.(request)) ?? ok(this.clock);
		if (request.operation === 'release') this.holding.delete(request.activation);
		return answer;
	}

	/** The lease calls of one operation, and of one activation when the test names it. */
	of(operation: LeaseRequest['operation'], activation?: string): LeaseRequest[] {
		return this.calls.filter(
			(call) =>
				call.operation === operation &&
				(activation === undefined || call.activation === activation),
		);
	}

	get claims(): string[] {
		return this.of('claim').map((call) => call.activation);
	}

	get releases(): string[] {
		return this.of('release').map((call) => call.activation);
	}
}

export interface SeatOptions {
	readonly definition?: AgentDefinition;
	/** The room name the executor renders. */
	readonly name?: string;
	readonly stream?: StreamFn;
	readonly model?: ModelResolver;
	readonly call?: { attempts?: number; timeout?: number };
	readonly emit?: AgentExecutionContext['emit'];
}

/**
 * One storage and one clock for the run. Each `start` builds a fresh Pi
 * executor and runner over them: a restart of the seat.
 */
export function seatHost(options: SeatOptions = {}) {
	const definition = options.definition ?? worker;
	const name = options.name ?? 'played';
	const clock = fakeClock(0);
	const runtime = createRuntime({ clock, limits: { call: options.call } });
	const services = createExecutionServices({
		storage: runtime.storage,
		clock,
		stream: options.stream ?? scripted(() => quiet()),
	});
	const start = (room: RoomProtocol) =>
		new AgentRunner(room, {
			clock,
			call: hostingOf(runtime).limits.call,
			definition,
			room: name,
			seat: definition.name,
			executor: createPiExecutor({
				definition,
				model: options.model ?? services.model,
				stream: services.stream,
				now: () => clock.now(),
			}),
			emit: options.emit,
			trace: noTraces,
		});
	return { clock, services, start };
}

/** A runner over a new played room. */
export function playSeat(options: SeatOptions & PlayedRoomOptions = {}) {
	const host = seatHost(options);
	const room = new PlayedRoom(host.clock, options);
	return { ...host, room, actor: host.start(room) };
}

export async function until(done: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200 && !done(); attempt += 1) await tick();
	if (!done()) throw new Error('the runner did not progress');
}
