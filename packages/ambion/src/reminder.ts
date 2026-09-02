/**
 * The reminder: a text an agent writes for its later self, and the clock that
 * delivers it.
 *
 * An agent that needs something the record does not hold yet — a delivery
 * that lands at 14:00, a reply that is not due until Monday — sets a reminder.
 * The workspace holds it (`ReminderStore`, behind the backend) until it is
 * due, and the session it was set in delivers it: one `reminder` message on
 * the record, stamped from the agent that set it, which wakes that agent and
 * nobody else. A timer is the fourth event source `README.md` names, and it
 * enters the room the way every other event does.
 *
 * Three things live here:
 *
 * - **The draft.** What a caller gives becomes a `Reminder`: a due time from
 *   `at` or `after`, a repeat interval from `every`, and a refusal for each
 *   thing that cannot be set.
 * - **The clock.** One per run. It arms every reminder for this session,
 *   reads the store back at the due moment, and hands the room what to
 *   deliver. `stopSession` clears it; the next run arms what is left.
 * - **The hands.** `remind` and `cancel_reminder` are bound to every agent
 *   that names a workspace, beside `read`, `write`, `edit` and `bash`; the
 *   `Reminders` view is what a custom tool reaches through `ctx.workspace()`.
 *
 * The design contract is docs/reminder.md.
 */
import { randomUUID } from 'node:crypto';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { spanText } from './render.ts';
import { delivered } from './seat.ts';
import type { Reminder, ReminderInput, ReminderStore, Reminders } from './types.ts';

/** A repeat interval shorter than this would be a room waking itself for ever. */
const REPEAT_FLOOR_MS = 60_000;

/** Node refuses a longer timer, so a far due time is waited for in stretches. */
const TIMER_MAX_MS = 2_147_483_647;

const UNITS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** A duration a model writes: one count and one unit, `'90s'`, `'20m'`, `'2h'`, `'3d'`. */
function parseDuration(text: string, field: string): number {
	const match = /^\s*(\d+)\s*([smhd])\s*$/.exec(text);
	if (!match) {
		throw new Error(
			`'${field}' takes a count and a unit — '90s', '20m', '2h' or '3d' — not '${text}'.`,
		);
	}
	return Number(match[1]) * (UNITS[match[2] ?? 's'] ?? 1);
}

/** When the reminder is due, from exactly one of `at` and `after`. */
function dueOf(input: ReminderInput, now: number): number {
	if ((input.at === undefined) === (input.after === undefined)) {
		throw new Error("Give exactly one of 'at' (an ISO time) and 'after' (a duration).");
	}
	if (input.after !== undefined) return now + parseDuration(input.after, 'after');
	const at = Date.parse(input.at ?? '');
	if (!Number.isFinite(at)) throw new Error(`'at' is not an ISO 8601 time: '${input.at}'.`);
	if (at <= now)
		throw new Error(`'at' is in the past (${input.at}). Name a later time, or use 'after'.`);
	return at;
}

/** The interval a reminder repeats at, or nothing when it is delivered once. */
function everyOf(input: ReminderInput): number | undefined {
	if (input.every === undefined) return undefined;
	const every = parseDuration(input.every, 'every');
	if (every < REPEAT_FLOOR_MS) {
		throw new Error(`'every' is at least one minute; '${input.every}' is shorter.`);
	}
	return every;
}

/** One reminder from what a caller gave, or a refusal that names what is wrong. */
function draftReminder(
	owner: string,
	session: string,
	input: ReminderInput,
	now: number,
): Reminder {
	const text = input.text.trim();
	if (text === '') throw new Error('The reminder is empty. Say what it is for.');
	const due = dueOf(input, now);
	const every = everyOf(input);
	return {
		id: `r-${randomUUID().slice(0, 8)}`,
		owner,
		session,
		text,
		due: new Date(due).toISOString(),
		...(every === undefined ? {} : { every }),
		setAt: new Date(now).toISOString(),
	};
}

/**
 * The first due time after `now` on a repeating reminder's own grid. A
 * reminder that came due many times while no run held its session is
 * delivered once, and then keeps its rhythm.
 */
export function nextDue(reminder: Reminder, now: number): string {
	const every = reminder.every ?? REPEAT_FLOOR_MS;
	const due = Date.parse(reminder.due);
	const missed = Math.max(0, Math.floor((now - due) / every) + 1);
	return new Date(due + missed * every).toISOString();
}

// -- the clock ---------------------------------------------------------------

/** What the clock needs of the room: where it is, and what to do when a reminder is due. */
export interface ClockRoom {
	readonly session: string;
	/** Commit the reminder to the record. The clock settles the store afterwards. */
	deliver(reminder: Reminder): Promise<void>;
	/** A reminder that could not be delivered or settled. */
	failed(reminder: Reminder, error: Error): void;
}

interface Armed {
	reminder: Reminder;
	store: ReminderStore;
	/** Absent while a reminder already due is being delivered. */
	timer?: NodeJS.Timeout;
}

/**
 * The reminders armed for one run. It holds a timer per reminder and the
 * store each came from, and nothing else: the store is the truth at the due
 * moment, so a reminder cancelled from elsewhere is delivered nowhere.
 */
export class Clock {
	private readonly armed = new Map<string, Armed>();

	constructor(private readonly room: ClockRoom) {}

	get session(): string {
		return this.room.session;
	}

	/**
	 * Arm one reminder for this run. One already armed takes its new due. One
	 * already due is delivered now, and the promise resolves once it has been:
	 * a run that finds a reminder overdue wakes its owner before anything
	 * waiting on the room resolves.
	 */
	arm(reminder: Reminder, store: ReminderStore): Promise<void> {
		this.disarm(reminder.id);
		const delay = Date.parse(reminder.due) - Date.now();
		if (delay <= 0) {
			this.armed.set(reminder.id, { reminder, store });
			return this.wake(reminder.id);
		}
		const timer = setTimeout(() => void this.wake(reminder.id), Math.min(delay, TIMER_MAX_MS));
		this.armed.set(reminder.id, { reminder, store, timer });
		return Promise.resolve();
	}

	disarm(id: string): void {
		const armed = this.armed.get(id);
		if (!armed) return;
		clearTimeout(armed.timer);
		this.armed.delete(id);
	}

	/** What one agent is waiting for in this run, soonest first. */
	pendingFor(owner: string): Reminder[] {
		return [...this.armed.values()]
			.map((armed) => armed.reminder)
			.filter((reminder) => reminder.owner === owner)
			.sort((a, b) => Date.parse(a.due) - Date.parse(b.due));
	}

	/** The run is over. What is armed stays in its store for the next one. */
	clear(): void {
		for (const armed of this.armed.values()) clearTimeout(armed.timer);
		this.armed.clear();
	}

	private async wake(id: string): Promise<void> {
		const armed = this.armed.get(id);
		if (!armed) return;
		// A far due time is waited for in stretches; this one is not over yet.
		if (Date.parse(armed.reminder.due) > Date.now()) {
			await this.arm(armed.reminder, armed.store);
			return;
		}
		this.armed.delete(id);
		try {
			const current = (await armed.store.list()).find((reminder) => reminder.id === id);
			if (!current) return;
			await this.room.deliver(current);
			await this.settle(current, armed.store);
		} catch (error) {
			this.room.failed(armed.reminder, error instanceof Error ? error : new Error(String(error)));
		}
	}

	/** Delivered: a repeating reminder takes its next due and stays; one delivered once leaves the store. */
	private async settle(reminder: Reminder, store: ReminderStore): Promise<void> {
		if (reminder.every === undefined) {
			await store.remove(reminder.id);
			return;
		}
		const next = { ...reminder, due: nextDue(reminder, Date.now()) };
		await store.put(next);
		await this.arm(next, store);
	}
}

// -- what an agent reaches ---------------------------------------------------

/** One agent's reminders in one workspace, bound to the run the call is made in. */
export function remindersFor(owner: string, store: ReminderStore, clock: Clock): Reminders {
	return {
		async set(input) {
			const reminder = draftReminder(owner, clock.session, input, Date.now());
			await store.put(reminder);
			await clock.arm(reminder, store);
			return reminder;
		},
		async list() {
			return (await store.list())
				.filter((reminder) => reminder.owner === owner)
				.sort((a, b) => Date.parse(a.due) - Date.parse(b.due));
		},
		async cancel(id) {
			const mine = (await store.list()).find((r) => r.id === id && r.owner === owner);
			if (!mine) return false;
			await store.remove(id);
			clock.disarm(id);
			return true;
		},
	};
}

/** How a tool reaches the calling agent's reminders: resolved fresh on every call. */
export type Reach = (signal?: AbortSignal) => Promise<Reminders>;

/** What a seat is told when it set one. */
function setText(reminder: Reminder, now: number): string {
	const until = spanText(Date.parse(reminder.due) - now);
	const repeat = reminder.every === undefined ? '' : `, then every ${spanText(reminder.every)}`;
	return (
		`Set ${reminder.id}: due ${reminder.due} (in ${until})${repeat}. ` +
		'It reaches you alone, as a line on the record, and wakes you.'
	);
}

export function remindTool(reach: Reach): AgentTool {
	return {
		name: 'remind',
		label: 'remind',
		description:
			'Set a reminder for yourself. When it is due it lands on the record as a line only you ' +
			'wake for. Give exactly one of `at` and `after`. Write the text for a reader with no ' +
			'memory of this turn: what to check, and why.',
		parameters: Type.Object({
			text: Type.String({ description: 'What you read when it is due.' }),
			at: Type.Optional(Type.String({ description: 'When it is due, ISO 8601, in the future.' })),
			after: Type.Optional(
				Type.String({
					description: "How long from now: a count and a unit — '90s', '20m', '2h', '3d'.",
				}),
			),
			every: Type.Optional(
				Type.String({
					description: "Repeat at this interval once due, same form, at least '1m'. Omit for once.",
				}),
			),
		}),
		execute: async (_toolCallId, rawParams, signal) => {
			const reminders = await reach(signal);
			const reminder = await reminders.set(rawParams as ReminderInput);
			return { content: [{ type: 'text', text: setText(reminder, Date.now()) }], details: {} };
		},
	};
}

export function cancelReminderTool(reach: Reach): AgentTool {
	return {
		name: 'cancel_reminder',
		label: 'cancel_reminder',
		description:
			'Cancel one of your own reminders by its id. Your pending reminders are listed in your context.',
		parameters: Type.Object({ id: Type.String() }),
		execute: async (_toolCallId, rawParams, signal) => {
			const { id } = rawParams as { id: string };
			const reminders = await reach(signal);
			if (!(await reminders.cancel(id.trim()))) {
				throw new Error(
					`No reminder '${id}' of yours is set. Cancel one from the list in your context.`,
				);
			}
			return delivered('cancelled');
		},
	};
}
