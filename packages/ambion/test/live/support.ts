/**
 * What every live test shares: the model, the key, fresh room storage,
 * a deadline on the room going quiet, and the invariants the record holds
 * whatever the model said, and what a run cost.
 *
 * A live test proves what a scripted stream cannot: that a model id resolves
 * through Pi's registry, that a real provider accepts the tools the room
 * gives a seat, that the judgment the prompt asks for holds on a real model,
 * and that a real request can be cancelled. It does not prove the routing;
 * `../room.test.ts` and its neighbours prove that, deterministically.
 */
import { memoryJournals } from '@ambionframework/journal';
import type { Usage } from '@earendil-works/pi-ai';
import { describe } from 'vitest';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	isSpoken,
	type Message,
	type PiOptions,
	pi,
	type Room,
	type RoomNotification,
	type Runtime,
	type StartRoomOptions,
	startRoom,
} from '../../src/index.ts';
import { hostingOf, seatSessionId } from '../../src/transport.ts';
import { collect, participantsOf, roomName, waitForRoom } from '../support/room.ts';

/** The model every live seat runs on. The example reads the same variable. */
export const MODEL = process.env.AMBION_MODEL ?? 'anthropic/claude-sonnet-5';

/** The key's variable, derived the way `registryStream` derives it. */
export const KEY_VAR = `${MODEL.slice(0, MODEL.indexOf('/'))
	.toUpperCase()
	.replace(/-/g, '_')}_API_KEY`;

/** `describe` when the key is set; a skipped block when it is not. */
export const live: ReturnType<typeof describe.skipIf> = describe.skipIf(!process.env[KEY_VAR]);

/** How long a live room may take to go quiet before the test gives up on it. */
export const QUIET_MS = 150_000;

type AgentOptions = { identity: string } & Omit<PiOptions, 'model'> & { model?: string };

/** An agent on the live model. */
export const agent = (name: string, options: AgentOptions) => {
	const { identity, model, ...piOptions } = options;
	return defineAgent({ name, identity, executor: pi({ model: model ?? MODEL, ...piOptions }) });
};

/** The room's assistant, with the judgment both of its activations share. */
export const assistant = defineAgent({
	name: 'assistant',
	identity:
		'Seats a specialist from the reserve when a question needs one, and writes the one ' +
		'message a person reads when their exchange closes.',
	executor: pi({
		model: MODEL,
		instructions: `
		When a question opens and specialists are on call, seat each specialist
		whose identity touches the question. Leave a specialist in the reserve
		when its identity has nothing to do with the question.

		When the room is quiet, write the one message your person reads, in the
		shape their preferences ask for, and nothing more.
	`,
	}),
});

export const person = defineHuman({
	name: 'andrei',
	identity: 'Founder. Asks the questions.',
});

type RoomOptions = Omit<StartRoomOptions, 'name' | 'streamFn' | 'runtime'>;

/** A live room with explicit participants and fresh storage for its record and transcripts. */
export async function open(prefix: string, options: RoomOptions) {
	const runtime = createRuntime({ storage: memoryJournals() });
	const session = await startRoom({
		...options,
		name: roomName(prefix),
		runtime,
	});
	return { session, runtime, events: collect(session) };
}

/** A promise that fails after `ms`, naming what did not happen. */
export function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms.`)), ms);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * The room goes quiet, or the test fails and aborts it. A room that keeps
 * waking itself is the gap `docs/agent.md` §7 names, and a live model is the
 * only place it shows.
 */
export async function untilQuiet(session: Room): Promise<void> {
	try {
		await within(
			waitForRoom(session, 'quiet', QUIET_MS),
			QUIET_MS,
			`'${session.name}' going quiet`,
		);
	} catch (error) {
		await session.abort().catch(() => {});
		throw error;
	}
}

/** What one participant said, in record order. */
export const saidBy = (messages: readonly Message[], name: string) =>
	messages.filter(isSpoken).filter((m) => m.from === name);

/** What agents contributed through ordinary speech. */
export const saidByAgents = (messages: readonly Message[], people: string[]) =>
	messages.filter(isSpoken).filter((m) => !people.includes(m.from));

export const activationsOf = (events: RoomNotification[], name: string) =>
	events.filter((e) => e.type === 'activation_start' && e.agent === name).length;

export { errorsIn, invariants } from '../support/invariants.ts';

export interface Spent {
	activations: number;
	tokens: number;
	cost: number;
}

/**
 * What a room spent, read off the seats' own downstream sessions: every
 * activation lands there with the provider's usage on each turn.
 */
export async function spent(runtime: Runtime, session: Room): Promise<Spent> {
	const total: Spent = { activations: 0, tokens: 0, cost: 0 };
	for (const info of await participantsOf(session)) {
		if (info.kind !== 'agent') continue;
		const seat = await hostingOf(runtime).transcripts.open(seatSessionId(session.name, info.name));
		for (const entry of await seat.findEntries()) add(total, entry);
	}
	return total;
}

function add(total: Spent, entry: { type: string; customType?: string }): void {
	if (entry.type === 'custom' && entry.customType === 'ambion/activation') {
		total.activations += 1;
		return;
	}
	if (entry.type !== 'message') return;
	const message = (entry as { message?: { role?: string; usage?: Usage } }).message;
	if (message?.role !== 'assistant' || message.usage === undefined) return;
	total.tokens += message.usage.totalTokens;
	total.cost += message.usage.cost.total;
}

/**
 * One line per test, so a run says what it cost. Written to stdout directly:
 * vitest keeps what a passing test logs through `console` to itself.
 */
export function report(label: string, total: Spent, conflicts = 0): void {
	process.stdout.write(
		`live · ${label}: ${total.activations} activations, ${total.tokens} tokens, ` +
			`$${total.cost.toFixed(4)}, ${conflicts} refused by the lock\n`,
	);
}
