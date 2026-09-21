/**
 * What the Claude live cases share: the key, the model, a room on the real
 * Claude Agent SDK with fresh storage, and a deadline on the room going
 * quiet.
 *
 * A live case proves what the fake executable cannot: that the real SDK
 * behaves as the executor assumes. Each case holds one claim about
 * structure, such as steps, records and counts. None reads exact wording.
 */
import { memoryJournals } from '@ambionframework/journal';
import { describe } from 'vitest';
import {
	type AgentDefinition,
	createRuntime,
	defineAgent,
	defineHuman,
	type Execution,
	type Room,
	startRoom,
	type TraceStep,
} from '../../../ambion/src/index.ts';
import { collect, roomName, waitForRoom } from '../../../ambion/test/support/room.ts';
import { type ClaudeOptions, claude, claudeExecution } from '../../src/index.ts';

/** The Claude model id: `AMBION_MODEL` without its provider prefix. */
export const MODEL = (process.env.AMBION_MODEL ?? 'anthropic/claude-sonnet-5').replace(
	/^anthropic\//,
	'',
);

/** `describe` when the key is set; a skipped block when it is not. */
export const live: ReturnType<typeof describe.skipIf> = describe.skipIf(
	!process.env.ANTHROPIC_API_KEY,
);

export const person = defineHuman({ name: 'andrei', identity: 'Founder. Asks the questions.' });

/** A seat on the real SDK. */
export const seat = (
	name: string,
	identity: string,
	options: Omit<ClaudeOptions, 'model'>,
): AgentDefinition =>
	defineAgent({ name, identity, executor: claude({ model: MODEL, ...options }) });

/** A live room with fresh storage. `execution` defaults to the Claude execution. */
export async function open(
	prefix: string,
	agents: AgentDefinition[],
	execution: Execution = claudeExecution(),
) {
	const runtime = createRuntime({ storage: memoryJournals(), execution });
	const name = roomName(prefix);
	const session = await startRoom({ name, agents, runtime });
	return { session, runtime, name, events: collect(session) };
}

/** A promise that fails after `ms`, naming what did not happen. */
export function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms.`)), ms);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

const QUIET_MS = 150_000;

/** The room goes quiet, or the case fails and aborts it. */
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

/** The steps of one step type, from a flat list. */
export const stepsOfType = <T extends TraceStep['type']>(steps: readonly TraceStep[], type: T) =>
	steps.filter((step): step is Extract<TraceStep, { type: T }> => step.type === type);
