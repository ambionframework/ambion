/**
 * What the evals of the assistant share: the models, a room with a live
 * assistant beside a specialist whose evidence the test fixes, the
 * specialist's script, the evidence a failed case keeps, and the cost line.
 *
 * `AMBION_MODEL` names the model of the assistant and of the actor, and
 * `JUDGE_MODEL` names the judge's model, `AMBION_MODEL` by default. A suite
 * that grades one model family names another family for the judge.
 * `AMBION_THINKING` sets the thinking level of the assistant and the actor,
 * and `JUDGE_THINKING` sets the judge's. Each one is `off` by default.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import {
	type Attention,
	createRuntime,
	defineAgent,
	defineHuman,
	isSpoken,
	type Message,
	type Room,
	type SpokenMessage,
	startRoom,
} from '@ambionframework/ambion';
import { composeExecutions, type Execution } from '@ambionframework/ambion/hosting';
import { byAgent, quiet, type Script, scripted, speak } from '@ambionframework/ambion/testing';
import { type PiOptions, piExecution } from '@ambionframework/pi';
import type { Run, RunExchange, Verdict } from '@ambionframework/simulator';
import { describe, onTestFailed, onTestFinished } from 'vitest';
import { defineAssistant } from '../../src/index.ts';

export const MODEL = process.env.AMBION_MODEL ?? 'anthropic/claude-sonnet-5';
export const JUDGE_MODEL = process.env.JUDGE_MODEL ?? MODEL;

type Thinking = NonNullable<PiOptions['thinking']>;
export const THINKING = (process.env.AMBION_THINKING ?? 'off') as Thinking;
export const JUDGE_THINKING = (process.env.JUDGE_THINKING ?? 'off') as Thinking;

const keyOf = (model: string) =>
	`${(model.split('/')[0] ?? '').toUpperCase().replace(/-/g, '_')}_API_KEY`;

/** `describe` when both keys are set; a skipped block when either is not. */
export const live: ReturnType<typeof describe.skipIf> = describe.skipIf(
	!process.env[keyOf(MODEL)] || !process.env[keyOf(JUDGE_MODEL)],
);

/** Real milliseconds for one exchange and its summary. */
export const EXCHANGE_MS = 90_000;

export const priya = defineHuman({ name: 'priya', identity: 'Owns the request.' });

const inventory = defineAgent({
	name: 'inventory',
	identity: 'Checks warehouse stock and prepares dispatch plans.',
	executor: { kind: 'scripted', instructions: 'Report the stock evidence once.', tools: [] },
});

export interface RoomOptions {
	/** The specialist's script. It runs on the scripted execution and spends nothing. */
	readonly specialist: Script;
	/** The specialist's attention. Absent, the specialist starts in the reserve. */
	readonly attention?: Attention;
	/** Application instructions for the assistant. */
	readonly instructions?: string;
	/** The assistant's model and execution. Absent, the live model on `piExecution()`. */
	readonly assistant?: { readonly model: string; readonly execution: Execution };
}

/**
 * A room with the default assistant and the `inventory` specialist, on its
 * own runtime, stopped when the test ends. The assistant runs on its model,
 * and the specialist on its script.
 */
export async function openRoom(options: RoomOptions): Promise<Room> {
	const model = options.assistant?.model ?? MODEL;
	const execution = composeExecutions({
		pi: options.assistant?.execution ?? piExecution(),
		scripted: scripted(byAgent({ inventory: options.specialist })),
	});
	const room = await startRoom({
		name: `assistant-eval-${crypto.randomUUID()}`,
		assistant: defineAssistant({ model, thinking: THINKING, instructions: options.instructions }),
		agents: [inventory],
		seats: options.attention === undefined ? {} : { inventory: options.attention },
		runtime: createRuntime({ execution }),
	});
	onTestFinished(() => room.stop());
	return room;
}

/** What a scripted specialist says: text to the room, or text to one participant. */
export type Reply = string | { readonly text: string; readonly to: string } | undefined;

/**
 * A specialist that says `evidence` once in each exchange, and says nothing
 * in an exchange where `evidence` gives no reply. `evidence` reads what the
 * person said in the exchange, so the words of an agent never pick the
 * reply. It reads the view: the step counter of `scripted()` spans the
 * runtime, so it cannot tell one exchange from the next.
 */
export const answers =
	(evidence: (requests: readonly SpokenMessage[]) => Reply): Script =>
	({ view, results }) => {
		// One say for each activation: the view of a later step may not hold it yet.
		if (results.length > 0) return quiet();
		// An activation outside an exchange carries no request to answer.
		if (view.context.exchange === undefined) return quiet();
		const { from } = view.context.exchange;
		const exchange = view.context.messages.filter(
			(message): message is SpokenMessage => isSpoken(message) && message.seq >= from,
		);
		if (exchange.some((message) => message.from === 'inventory')) return quiet();
		const reply = evidence(exchange.filter((message) => message.from === priya.name));
		if (reply === undefined) return quiet();
		// A specialist reports to the room. It addresses a participant only with a question for it.
		return typeof reply === 'string' ? speak(reply) : speak(reply.text, reply.to);
	};

/** The presence entries of one kind about `subject` in one exchange, in record order. */
export const presence = (
	exchange: RunExchange | undefined,
	kind: 'seated' | 'unseated',
	subject: string,
): Message[] =>
	(exchange?.discussion ?? []).filter(
		(message) => message.kind === kind && 'subject' in message && message.subject === subject,
	);

/** What one participant said in one exchange, in record order. */
export const saidBy = (exchange: RunExchange | undefined, name: string): SpokenMessage[] =>
	(exchange?.discussion ?? []).filter(
		(message): message is SpokenMessage => isSpoken(message) && message.from === name,
	);

/** What a case keeps for a person to read when it fails. */
export interface Evidence {
	run?: Run;
	verdict?: Verdict;
}

/**
 * The evidence of the running case. When the case ends, one line on stdout
 * gives what the room, the actor, and the judge spent. It goes to stdout
 * directly: vitest keeps what a passing test logs through `console`.
 *
 * When the case fails, the evidence goes to `test/live/runs/<model>/<name>.json`,
 * which git ignores, and the path goes to stdout. The repository forbids a
 * second live run to chase a flake, so the file is the record of the first.
 */
export function track(name: string): Evidence {
	const evidence: Evidence = {};
	onTestFinished(() => {
		const cost = (usage: { cost?: number } | undefined) => (usage?.cost ?? 0).toFixed(4);
		const { run, verdict } = evidence;
		process.stdout.write(
			`assistant eval · ${MODEL} · ${name}: room $${cost(run?.usage.room)}, actor $${cost(run?.usage.actor)}, judge $${cost(verdict?.usage)}\n`,
		);
	});
	onTestFailed(() => {
		const dir = new URL(`./runs/${MODEL.replace(/[^a-z0-9.-]+/gi, '-')}/`, import.meta.url);
		mkdirSync(dir, { recursive: true });
		const path = new URL(`${name.replace(/[^a-z0-9-]+/gi, '-')}.json`, dir);
		const replacer = (_key: string, value: unknown) =>
			value instanceof Error ? value.message : value;
		writeFileSync(path, JSON.stringify(evidence, replacer, 2));
		process.stdout.write(`assistant eval · ${name}: evidence in ${path.pathname}\n`);
	});
	return evidence;
}
