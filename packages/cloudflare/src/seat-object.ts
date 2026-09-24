/**
 * One seat as one Durable Object. A wake stores the activation id and sets
 * an alarm; the alarm claims the lease, reads the view, runs the activation
 * to its end and releases the lease, all inside one alarm handler. A wake
 * that arrives while an activation runs is handed to the runner to queue;
 * steering is forwarded separately to the exact live activation. A cut is
 * handed to the runner the same way. The seat gives the steps of each
 * activation to the logger that `configure` takes. The Pi executor lives on
 * the object instance, and it keeps the seat's Pi harness sessions in a
 * `MemorySessionRepo` there. A seat continues its session inside one
 * exchange while the object stays in memory. An eviction loses the
 * sessions, and the next activation starts fresh.
 */

import { DurableObject } from 'cloudflare:workers';
import type { Clock, ExecutionEvent } from '@ambionframework/ambion';
import { systemClock } from '@ambionframework/ambion';
import type { Executor, RoomProtocol, Steer, Wake } from '@ambionframework/ambion/hosting';
import { AgentRunner, seatContext } from '@ambionframework/ambion/hosting';
import { createPiExecutor, type ExecutionServices } from '@ambionframework/pi';
import type { SeatEvent } from './configure.ts';
import { definitionOf, executionFor, seatEvent, traceLogger } from './configure.ts';
import type { Env } from './room-object.ts';
import { seatMetadata } from './storage.ts';

type RecoveryCall<T> = { kind: 'value'; value: T } | { kind: 'lost'; error: Error };

/**
 * What a seat did, flattened for whoever the worker gave the events to.
 *
 * An activation runs inside the seat's object, and the events it raises reach
 * no other object: `emit` is a call in this process. So this line is the only
 * way a reader outside learns that a tool was called. `configure` decides
 * where it goes, and writes it to the logs when the worker says nothing.
 *
 * The core writes nothing to stdout, and the decision is a host's to make.
 */
function seatLine(room: string, seat: string, event: ExecutionEvent): SeatEvent {
	return {
		ambion: 'seat',
		room,
		seat,
		activation: event.activation,
		event: event.type,
		...(event.type === 'delivery_error' ? { operation: event.operation } : {}),
		...('toolName' in event ? { tool: event.toolName } : {}),
		...('error' in event ? { error: event.error.message } : {}),
		at: new Date().toISOString(),
	};
}

export class SeatObject extends DurableObject<Env> {
	private runner: AgentRunner | undefined;
	/** The Pi executor of the seat and its sessions, kept while the object stays in memory. */
	private executor: { readonly seat: string; readonly executor: Executor } | undefined;
	/** Whether an alarm runs in this object now. */
	private alarming = false;
	private readonly metadata;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.metadata = seatMetadata(ctx);
	}

	/**
	 * A wake for the activation the object holds, or for a fresh one when it
	 * holds none, sets the alarm. A wake for a different activation while one
	 * runs is queued by the runner.
	 */
	async wake(wake: Wake): Promise<void> {
		const next = this.metadata.change((current) =>
			current.activation !== undefined && current.activation !== wake.activation
				? undefined
				: {
						patch: {
							room: wake.room,
							seat: wake.seat,
							activation: wake.activation,
							phase: current.phase ?? 'pending',
							wakes: (current.wakes ?? 0) + 1,
						},
					},
		);
		if (next.activation !== wake.activation) {
			if (this.runner !== undefined) await this.runner.wake(wake);
			return;
		}
		if (!next.hold) await this.ctx.storage.setAlarm(Date.now());
	}

	/** Forward steering to a live runner without changing durable wake state. */
	async steer(steer: Steer): Promise<void> {
		await this.runner?.steer(steer);
	}

	/**
	 * The room ended this activation's lease: the runner stops it, when it runs
	 * here. A cut for an activation this object holds but has not started
	 * reaches no runner, and the alarm that starts it is refused its claim.
	 */
	async cut(activation: string): Promise<void> {
		this.metadata.change((current) => ({ patch: { cuts: (current.cuts ?? 0) + 1 } }));
		await this.runner?.cut(activation);
	}

	/**
	 * A seat on hold keeps the wakes it is sent and runs nothing: the room
	 * sends them again until the hold lifts, and the lift takes the one it
	 * holds. A host drains a seat this way before it moves it.
	 */
	async hold(on: boolean): Promise<void> {
		const next = this.metadata.change(() => ({ patch: { hold: on } }));
		if (!on && next.activation !== undefined) {
			await this.ctx.storage.setAlarm(Date.now());
		}
	}

	/** How many wakes this seat has taken. The tests read it. */
	async wakes(): Promise<number> {
		return this.metadata.read().wakes ?? 0;
	}

	/** How many cuts the room has sent this seat. The tests read it. */
	async cuts(): Promise<number> {
		return this.metadata.read().cuts ?? 0;
	}

	/**
	 * Run the activation this seat holds. A second call while a run is live
	 * in this object returns at once: the live run owns the activation. The
	 * flag lives in memory, so an object that was evicted mid-activation has
	 * none, and its next alarm releases the run that never came back.
	 */
	override async alarm(): Promise<void> {
		if (this.alarming) return;
		this.alarming = true;
		try {
			await this.runHeld();
		} finally {
			this.alarming = false;
		}
	}

	private async runHeld(): Promise<void> {
		const state = this.metadata.read();
		const { activation, room, seat } = state;
		if (activation === undefined || room === undefined || seat === undefined) return;
		const protocol = this.roomFor(room);
		const execution = executionFor({ clock: systemClock() });
		if (state.phase === 'running') {
			// A run that never came back: the object was evicted mid-activation.
			try {
				await this.releaseRecovered(
					protocol,
					execution.call,
					execution.clock,
					room,
					seat,
					activation,
				);
			} finally {
				await this.clear(activation);
			}
			return;
		}
		this.metadata.change(() => ({ patch: { phase: 'running' } }));
		const definition = definitionOf(seat);
		const executor = this.executorFor(seat, definition, execution);
		const emit = (event: ExecutionEvent) => seatEvent(seatLine(room, seat, event));
		this.runner = new AgentRunner(
			protocol,
			seatContext({
				clock: execution.clock,
				call: execution.call,
				definition,
				room,
				seat,
				executor,
				emit,
				logger: traceLogger(),
				limits: execution.trace,
			}),
		);
		try {
			await this.runner.run(activation);
		} finally {
			this.runner = undefined;
			await this.clear(activation);
		}
	}

	/** The seat's Pi executor: the one this object holds, or a new one. */
	private executorFor(
		seat: string,
		definition: ReturnType<typeof definitionOf>,
		execution: ExecutionServices,
	): Executor {
		if (this.executor?.seat === seat) return this.executor.executor;
		const executor = createPiExecutor({
			definition,
			model: execution.model,
			stream: execution.stream,
			now: () => execution.clock.now(),
			sessions: execution.sessions,
		});
		this.executor = { seat, executor };
		return executor;
	}

	/** Release a recovered activation within the configured call budget. */
	private async releaseRecovered(
		protocol: RoomProtocol,
		call: ExecutionServices['call'],
		clock: Clock,
		room: string,
		seat: string,
		activation: string,
	): Promise<void> {
		let failure: Error | undefined;
		for (let attempt = 0; attempt < call.attempts; attempt += 1) {
			const result = await this.recoveryCall(
				() =>
					protocol.lease({ activation, operation: 'release', reason: 'failed', readThrough: 0 }),
				clock,
				call.timeout,
			);
			if (result.kind === 'value') return;
			failure = result.error;
		}
		if (failure === undefined) return;
		try {
			seatEvent(
				seatLine(room, seat, {
					type: 'delivery_error',
					agent: seat,
					activation,
					operation: 'release',
					error: failure,
				}),
			);
		} catch {
			// A recovery diagnostic cannot keep the seat occupied.
		}
	}

	/** Wait for one recovered release or its local deadline. */
	private async recoveryCall<T>(
		send: () => Promise<T>,
		clock: Clock,
		timeout: number,
	): Promise<RecoveryCall<T>> {
		let stopAlarm = () => {};
		let resolveDeadline: () => void = () => {};
		const deadline = new Promise<void>((resolve) => {
			resolveDeadline = resolve;
		});
		stopAlarm = clock.alarm(clock.now() + timeout, resolveDeadline);
		const result = await Promise.race([
			Promise.resolve()
				.then(send)
				.then(
					(value) => ({ kind: 'value' as const, value }),
					(error: unknown) => ({ kind: 'lost' as const, error: asError(error) }),
				),
			deadline.then(() => ({ kind: 'lost' as const, error: new Error('Room call timed out.') })),
		]);
		stopAlarm();
		return result;
	}

	/** The three calls this seat makes on its room, each over a stub of its own. */
	private roomFor(room: string): RoomProtocol {
		return {
			view: (id, range) => this.roomStub(room).view(id, range),
			commit: (commit) => this.roomStub(room).commit(commit),
			lease: (lease) => this.roomStub(room).lease(lease),
		};
	}

	/**
	 * A stub for the room, taken for one call. A stub dies with the object it
	 * names, so an activation that held one across an eviction lost the room
	 * and wrote nothing: the commit threw, the release threw after it, and the
	 * lease it holds sat live until it expired. A stub taken per call reaches
	 * the room that holds the name now, and builds it again when none does.
	 */
	private roomStub(room: string) {
		return this.env.ROOM.get(this.env.ROOM.idFromName(room));
	}

	private async clear(activation: string): Promise<void> {
		this.metadata.change((current) =>
			current.activation === activation ? { remove: ['activation', 'phase'] } : undefined,
		);
	}
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
