/**
 * The loop of one simulation: the actor sends a message, the room works
 * until the exchange closes and its summary lands, and the actor reads what
 * the person saw. One iteration of the loop is one exchange.
 *
 * - **Waits.** Every wait is a wait on the handle of the exchange:
 *   `waitForClose()`, then `waitForSummary()`. The loop never polls for a
 *   quiet room and never calls `reconcile()`.
 * - **Deadline.** One deadline covers the close and the summary. At the
 *   deadline the loop calls `room.abort()`. The abort closes an open
 *   exchange, or it fails a pending summary, and the loop ends with
 *   `timeout`. An abort that fails, or a close that does not land in a
 *   second period, ends the loop with `failed`.
 * - **Failure.** A rejected wait, a refused send, and an actor that throws
 *   end the loop with `failed`, and the run keeps the message.
 * - **The room.** The test started the room, and the test stops it.
 */
import {
	AmbionError,
	type ClosedExchangeView,
	type Room,
	type RoomNotification,
	type Seq,
	type Usage,
	type Visit,
} from '@ambionframework/ambion';
import type { Ended, Move, Run, RunExchange, Seen, SimulateOptions } from './types.ts';

/** The default of `exchangeMs`: real milliseconds for one exchange. */
export const DEFAULT_EXCHANGE_MS = 150_000;

const ZERO: Usage = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

const noop = () => {};

/**
 * Run the actor against a room that the test started, one exchange at a
 * time, and return the run. The loop does not stop the room.
 */
export async function simulate(room: Room, options: SimulateOptions): Promise<Run> {
	checkOptions(options);
	const events: RoomNotification[] = [];
	const off = room.subscribe((event) => events.push(event));
	try {
		const loop = new Loop(room, options);
		await loop.run();
		return {
			person: options.person,
			moves: loop.moves,
			exchanges: loop.exchanges,
			room: await room.read(),
			events,
			ended: loop.ended,
			...(loop.error === undefined ? {} : { error: loop.error }),
			usage: {
				room: total(loop.exchanges.map((exchange) => exchange.view.usage)),
				actor: total(loop.moves.map((move) => move.usage)),
			},
		};
	} finally {
		off();
	}
}

function checkOptions(options: SimulateOptions): void {
	if (!Number.isSafeInteger(options.exchanges) || options.exchanges < 1) {
		throw new RangeError('`exchanges` must be a positive integer.');
	}
	const ms = options.exchangeMs;
	if (ms !== undefined && (!Number.isFinite(ms) || ms <= 0)) {
		throw new RangeError('`exchangeMs` must be a positive number of milliseconds.');
	}
}

/** A message move: the move the loop sends. */
type Send = Extract<Move, { readonly text: string }>;

const isStop = (move: Move): move is Extract<Move, { readonly stop: string }> => 'stop' in move;

/** The state of one simulation while it runs. */
class Loop {
	readonly moves: Move[] = [];
	readonly exchanges: RunExchange[] = [];
	ended: Ended = 'limit';
	error: string | undefined;
	private readonly room: Room;
	private readonly options: SimulateOptions;

	constructor(room: Room, options: SimulateOptions) {
		this.room = room;
		this.options = options;
	}

	/** Arrive, run the exchanges, and leave. The person leaves on every path. */
	async run(): Promise<void> {
		const visit = await this.room.visit(this.options.person);
		try {
			this.ended = await this.iterate(visit);
		} catch (error) {
			this.ended = 'failed';
			this.error = error instanceof Error ? error.message : String(error);
		}
		// A stopped room refuses the departure. The run keeps the reason it ended.
		await visit.leave().catch(noop);
	}

	private async iterate(visit: Visit): Promise<Ended> {
		while (this.exchanges.length < this.options.exchanges) {
			const move = await this.options.actor(this.seen());
			this.moves.push(move);
			if (isStop(move)) return 'stopped';
			if (await this.exchange(visit, move)) return 'timeout';
		}
		return 'limit';
	}

	/** What the person has seen so far, as a value the actor cannot change. */
	private seen(): Seen {
		return Object.freeze({
			person: this.options.person,
			exchanges: Object.freeze(
				this.exchanges.map(({ view: _view, ...seen }) => Object.freeze(seen)),
			),
		});
	}

	/** One exchange, from the send to the summary. True when the deadline passed. */
	private async exchange(visit: Visit, move: Send): Promise<boolean> {
		const handle = await visit.send(
			move.to === undefined ? { text: move.text } : { text: move.text, to: move.to },
		);
		if (!handle.opened) {
			throw new Error(
				`The message joined the open exchange at ${handle.from}. Close it before the simulation starts.`,
			);
		}
		const deadline = new Deadline(this.room, this.options.exchangeMs ?? DEFAULT_EXCHANGE_MS);
		let lost = false;
		try {
			const discussion = Object.freeze(await deadline.race(handle.waitForClose()));
			const summary = await deadline.race(handle.waitForSummary()).catch((error: unknown) => {
				// The abort at the deadline fails a pending summary. That rejection, and no other, is the timeout.
				if (!deadline.passed || !cutByAbort(error)) throw error;
				lost = true;
				return undefined;
			});
			deadline.clear();
			// An abort in flight lands before the next message, so it cancels no later work.
			// A cut summary counts as the timeout only when that abort landed.
			await deadline.settled();
			if (deadline.failure !== undefined) throw deadline.failure;
			const view = await this.closedView(handle.from);
			this.exchanges.push({
				sent: move.text,
				discussion,
				...(summary === undefined ? {} : { summary }),
				view,
			});
			return lost || (deadline.passed && view.outcome.kind === 'cancelled');
		} finally {
			deadline.clear();
		}
	}

	private async closedView(from: Seq): Promise<ClosedExchangeView> {
		const read = await this.room.read({ messages: false });
		const view = read.exchanges.find((exchange) => exchange.from === from);
		if (view?.status !== 'closed') throw new Error(`The exchange at ${from} did not close.`);
		return view;
	}
}

/**
 * Whether a summary wait failed because the loop's own abort cut the summary.
 * A stopped room and a failed deadline reject with other errors.
 */
function cutByAbort(error: unknown): boolean {
	return (
		error instanceof Error && !(error instanceof AmbionError) && !(error instanceof DeadlineFailure)
	);
}

/** The deadline could not end the exchange: the abort failed, or no close followed it. */
class DeadlineFailure extends Error {
	override readonly name = 'DeadlineFailure';
}

/**
 * The deadline of one exchange. When it passes, it aborts the room's work.
 * When the abort rejects, or the close does not land within a second
 * period of the same length, `race` rejects, so the loop never waits for
 * ever.
 */
class Deadline {
	passed = false;
	private readonly failed: Promise<never>;
	private aborting: Promise<void> | undefined;
	/** Why the deadline could not end the exchange, once it failed. */
	failure: DeadlineFailure | undefined;
	private fail: (error: DeadlineFailure) => void = noop;
	private readonly timers: ReturnType<typeof setTimeout>[] = [];
	private cleared = false;

	constructor(room: Room, ms: number) {
		this.failed = new Promise<never>((_, reject) => {
			this.fail = reject;
		});
		// A deadline that never fails leaves the promise unread.
		this.failed.catch(noop);
		this.timers.push(setTimeout(() => this.pass(room, ms), ms));
	}

	/** `promise`, unless the deadline fails first. */
	race<T>(promise: Promise<T>): Promise<T> {
		return Promise.race([promise, this.failed]);
	}

	/** Wait for the abort of this deadline, when it started one. */
	async settled(): Promise<void> {
		await this.aborting;
	}

	clear(): void {
		this.cleared = true;
		for (const timer of this.timers) clearTimeout(timer);
	}

	private pass(room: Room, ms: number): void {
		this.passed = true;
		this.aborting = room.abort().then(
			() => {
				if (this.cleared) return;
				const late = new DeadlineFailure(`The exchange did not close ${ms} ms after the abort.`);
				this.timers.push(setTimeout(() => this.fail(late), ms));
			},
			(error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				this.failure = new DeadlineFailure(`The abort at the deadline failed: ${message}`);
				this.fail(this.failure);
			},
		);
	}
}

/** The sum of the usages that are present. `cost` stays absent until one carries it. */
function total(usages: readonly (Usage | undefined)[]): Usage {
	let sum = ZERO;
	for (const usage of usages) {
		if (usage === undefined) continue;
		const cost =
			sum.cost === undefined && usage.cost === undefined
				? undefined
				: (sum.cost ?? 0) + (usage.cost ?? 0);
		sum = {
			input: sum.input + usage.input,
			output: sum.output + usage.output,
			cacheRead: sum.cacheRead + usage.cacheRead,
			cacheWrite: sum.cacheWrite + usage.cacheWrite,
			...(cost === undefined ? {} : { cost }),
		};
	}
	return sum;
}
