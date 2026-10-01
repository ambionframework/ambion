/**
 * What the evals of the assistant share: the models, a room with a live
 * assistant beside a specialist whose evidence the test fixes, the
 * specialist's script, the evidence a failed case keeps, and the cost line.
 *
 * `AMBION_MODEL` names the model of the assistant and of the actor, and
 * `JUDGE_MODEL` names the judge's model, `AMBION_MODEL` by default. A suite
 * that grades one provider's model names a model of another provider
 * for the judge.
 * `AMBION_THINKING` sets the thinking level of the assistant and the actor,
 * and `JUDGE_THINKING` sets the judge's. Each one is `off` by default.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import {
	type Attention,
	createRuntime,
	defineAgent,
	defineHuman,
	type HumanDefinition,
	isSaid,
	type Message,
	type Room,
	type SaidMessage,
	startRoom,
} from '@ambionframework/ambion';
import { type Execution, visitOf } from '@ambionframework/ambion/hosting';
import { byAgent, quiet, type Script, say, scripted } from '@ambionframework/ambion/testing';
import { type PiOptions, piExecution } from '@ambionframework/pi';
import type { Simulation, SimulationExchange, Verdict } from '@ambionframework/simulator';
import { describe, onTestFailed, onTestFinished } from 'vitest';
import { defineAssistant } from '../../src/index.ts';

export const MODEL = process.env.AMBION_MODEL ?? 'anthropic/claude-sonnet-5';
export const JUDGE_MODEL = process.env.JUDGE_MODEL || MODEL;

type Thinking = NonNullable<PiOptions['thinking']>;
export const THINKING = (process.env.AMBION_THINKING || 'off') as Thinking;
export const JUDGE_THINKING = (process.env.JUDGE_THINKING || 'off') as Thinking;

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
	/**
	 * The person who leaves after the first question, before the first
	 * activation of the assistant starts. Absent, nobody leaves early.
	 */
	readonly leaves?: HumanDefinition;
}

/**
 * `execution`, whose every wake waits until `hold` resolves. The first wake
 * calls `hold`, and each later wake, a resent one included, waits on that
 * call. No activation starts before the entry that `hold` lands.
 */
function heldUntil(execution: Execution, hold: () => Promise<void>): Execution {
	let held: Promise<void> | undefined;
	return {
		...(execution.kind === undefined ? {} : { kind: execution.kind }),
		connector(host) {
			const inner = execution.connector(host);
			return {
				connect(room, request) {
					const port = inner.connect(room, request);
					return {
						wake: async (wake) => {
							held ??= hold();
							await held;
							return port.wake(wake);
						},
						steer: (steer) => port.steer(steer),
						cut: (activation) => port.cut(activation),
					};
				},
			};
		},
	};
}

/**
 * A room with the default assistant and the `inventory` specialist, on its
 * own runtime, stopped when the test ends. The assistant runs on its model,
 * and the specialist on its script. With `leaves`, the first wake of the
 * assistant waits until that person leaves: the person sends the question,
 * and the departure lands on the record before the first activation starts.
 */
export async function openRoom(options: RoomOptions): Promise<Room> {
	const model = options.assistant?.model ?? MODEL;
	let room: Room | undefined;
	const { leaves } = options;
	const assistant = options.assistant?.execution ?? piExecution();
	// The assistant runs on Pi, and the scripted execution serves every other kind.
	const execution = [
		leaves === undefined
			? assistant
			: heldUntil(assistant, async () => {
					const visit = room === undefined ? undefined : visitOf(room, leaves.name);
					if (visit === undefined) throw new Error(`${leaves.name} is not in the room to leave.`);
					await visit.leave();
				}),
		scripted(byAgent({ inventory: options.specialist })),
	];
	const started = await startRoom({
		name: `assistant-eval-${crypto.randomUUID()}`,
		assistant: defineAssistant({ model, thinking: THINKING, instructions: options.instructions }),
		agents: [inventory],
		seats: options.attention === undefined ? {} : { inventory: options.attention },
		runtime: createRuntime({ execution }),
	});
	room = started;
	onTestFinished(() => started.stop());
	return started;
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
	(evidence: (requests: readonly SaidMessage[]) => Reply): Script =>
	({ view, results }) => {
		// One say for each activation: the view of a later step may not hold it yet.
		if (results.length > 0) return quiet();
		// An activation outside an exchange carries no request to answer.
		if (view.context.exchange === undefined) return quiet();
		const { from } = view.context.exchange;
		const exchange = view.context.messages.filter(
			(message): message is SaidMessage => isSaid(message) && message.seq >= from,
		);
		if (exchange.some((message) => message.from === 'inventory')) return quiet();
		const reply = evidence(exchange.filter((message) => message.from === priya.name));
		if (reply === undefined) return quiet();
		// A specialist reports to the room. It addresses a participant only with a question for it.
		return typeof reply === 'string' ? say(reply) : say(reply.text, reply.to);
	};

/** The presence entries of one kind about `subject` in one exchange, in record order. */
export const presence = (
	exchange: SimulationExchange | undefined,
	kind: 'seated' | 'unseated',
	subject: string,
): Message[] =>
	(exchange?.discussion ?? []).filter(
		(message) => message.kind === kind && 'subject' in message && message.subject === subject,
	);

/** What one participant said in one exchange, in record order. */
export const saidBy = (exchange: SimulationExchange | undefined, name: string): SaidMessage[] =>
	(exchange?.discussion ?? []).filter(
		(message): message is SaidMessage => isSaid(message) && message.from === name,
	);

/** What a case keeps for a person to read when it fails. */
export interface Evidence {
	simulation?: Simulation;
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
		const { simulation, verdict } = evidence;
		process.stdout.write(
			`assistant eval · ${MODEL} · ${name}: room $${cost(simulation?.usage.room)}, actor $${cost(simulation?.usage.actor)}, judge $${cost(verdict?.usage)}\n`,
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
