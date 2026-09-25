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
 *   `timeout`.
 * - **Failure.** A rejected wait, a refused send, and an actor that throws
 *   end the loop with `failed`, and the run keeps the message.
 * - **The room.** The test started the room, and the test stops it.
 */
import type {
	ClosedExchangeView,
	Room,
	RoomNotification,
	Seq,
	Usage,
	Visit,
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
		const deadline = new Deadline(this.room, this.options.exchangeMs ?? DEFAULT_EXCHANGE_MS);
		let summary: RunExchange['summary'];
		try {
			const discussion = await handle.waitForClose();
			summary = await handle.waitForSummary().catch((error: unknown) => {
				// The abort at the deadline fails a pending summary. That rejection is the timeout.
				if (deadline.passed) return undefined;
				throw error;
			});
			deadline.clear();
			const view = await this.closedView(handle.from);
			this.exchanges.push({
				sent: move.text,
				discussion,
				...(summary === undefined ? {} : { summary }),
				view,
			});
			return deadline.passed;
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

/** The deadline of one exchange. When it passes, it aborts the room's work. */
class Deadline {
	passed = false;
	private readonly timer: ReturnType<typeof setTimeout>;

	constructor(room: Room, ms: number) {
		this.timer = setTimeout(() => {
			this.passed = true;
			room.abort().catch(noop);
		}, ms);
	}

	clear(): void {
		clearTimeout(this.timer);
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
