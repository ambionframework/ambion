/**
 * What every live file shares: the model, the key, a room on real storage in
 * memory, a deadline on the room going quiet, and the trace of an activation.
 *
 * A live file needs `CODEX_API_KEY`. Without it the file skips. Every seat
 * runs `gpt-5.6-luna` at medium reasoning effort, so a run is the same
 * whichever account pays for it. Each file holds one claim that a recorded
 * stream cannot prove: a real `codex` runs, and a real model answers.
 */

import {
	type AgentDefinition,
	createRuntime,
	defineAgent,
	defineHuman,
	type Execution,
	isSpoken,
	type Message,
	type Room,
	type RoomNotification,
	readActivation,
	type StartRoomOptions,
	startRoom,
	type TraceStep,
} from '@ambionframework/ambion';
import { settled } from '@ambionframework/ambion/testing';
import { memoryJournals } from '@ambionframework/journal';
import { describe } from 'vitest';
import { type CodexOptions, codex, codexExecution } from '../../src/index.ts';

/** The model every live Codex seat runs on. */
export const MODEL = 'gpt-5.6-luna';

/** The variable that holds the key. */
export const KEY_VAR = 'CODEX_API_KEY';

/** `describe` when the key is set; a skipped block when it is not. */
export const live: ReturnType<typeof describe.skipIf> = describe.skipIf(!process.env[KEY_VAR]);

/** How long a live room may take to go quiet before the test gives up on it. */
export const QUIET_MS = 150_000;

export const person = defineHuman({
	name: 'priya',
	identity: 'Project manager. Asks the questions.',
});

let unique = 0;

/** A room name no other test in the process has used. */
export const roomName = (prefix: string) => `codex-live-${prefix}-${process.pid}-${++unique}`;

/** A Codex seat on the live model. Every definition sets the model and the effort. */
export function seat(
	name: string,
	options: Partial<CodexOptions> & { identity?: string } = {},
): AgentDefinition {
	const { identity, ...rest } = options;
	return defineAgent({
		name,
		identity: identity ?? 'Answers what is asked.',
		executor: codex({
			instructions: 'Answer through one say, in one sentence.',
			model: MODEL,
			modelReasoningEffort: 'medium',
			approvalPolicy: 'never',
			sandboxMode: 'read-only',
			...rest,
		}),
	});
}

type RoomOptions = Omit<StartRoomOptions, 'name' | 'runtime' | 'execution'>;

/** A live room on fresh storage, with the events it emits. */
export async function open(prefix: string, options: RoomOptions & { execution?: Execution } = {}) {
	const { execution, ...rest } = options;
	const runtime = createRuntime({
		storage: memoryJournals(),
		execution: execution ?? codexExecution(),
	});
	const name = roomName(prefix);
	const room = await startRoom({ ...rest, name, runtime });
	const events: RoomNotification[] = [];
	room.subscribe((event) => void events.push(event));
	return { room, name, runtime, events };
}

/** A promise that fails after `ms`, naming what did not happen. */
export function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms.`)), ms);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** The room goes quiet, or the test fails and stops it. */
export async function untilQuiet(room: Room): Promise<void> {
	try {
		await settled(room, { timeout: QUIET_MS });
	} catch (error) {
		await room.abort().catch(() => {});
		throw error;
	}
}

/** What one participant said, in record order. */
export const saidBy = (messages: readonly Message[], name: string) =>
	messages.filter(isSpoken).filter((message) => message.from === name);

/** The activations that a seat started, in order. */
export const activationsOf = (events: readonly RoomNotification[], agent: string): string[] =>
	events.flatMap((event) =>
		event.type === 'activation_start' && event.agent === agent ? [event.activation] : [],
	);

/** Every step of every pass of one activation. */
export async function stepsOf(
	name: string,
	activation: string,
	runtime: Awaited<ReturnType<typeof open>>['runtime'],
): Promise<TraceStep[]> {
	const read = await readActivation(name, activation, { runtime });
	return read?.passes.flatMap((pass) => [...pass.steps]) ?? [];
}

/** The failures a room reported. A live claim holds only when the list is empty. */
export const errorsIn = (events: readonly RoomNotification[]) =>
	events.filter((event) => event.type === 'error' || event.type === 'delivery_error');
