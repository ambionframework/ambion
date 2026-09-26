/**
 * The deterministic tools for a room on Pi: a scripted `StreamFn` that
 * `piExecution({ stream })` takes, the helpers that read what the model was
 * shown, and the harness that runs the executor suite of
 * `@ambionframework/ambion/conformance` on the Pi executor. A test that
 * needs no Pi imports `scripted` from `@ambionframework/ambion/testing`,
 * which runs a script with no model.
 */
import type { ExecutorHarness, ExecutorPlan } from '@ambionframework/ambion/conformance';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Context, JsonObject } from '@earendil-works/pi-ai';
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
} from '@earendil-works/pi-ai';
import { pi } from './define.ts';
import { createPiExecutor } from './executor.ts';
import { scriptContext } from './script-context.ts';
import { stubModel } from './services.ts';
import { memorySessions } from './sessions.ts';

/** One activation's answer: the model's message, given the context and which call this is. */
export type Script = (
	context: Context,
	agent: string,
	call: number,
) => AssistantMessage | Promise<AssistantMessage>;

/**
 * A deterministic stream. It routes on the seat that the stub model names
 * (`model.name`), so no script reads the prompt to find out who it is. It
 * counts calls per seat, answers an abort with an aborted message, and turns
 * a script that throws into an error on the stream.
 */
export function scripted(script: Script): StreamFn {
	const calls = new Map<string, number>();
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const agent = model.name;
		const call = (calls.get(agent) ?? 0) + 1;
		calls.set(agent, call);
		let finished = false;
		const finish = (message: AssistantMessage) => {
			if (finished) return;
			finished = true;
			if (message.stopReason === 'error' || message.stopReason === 'aborted') {
				stream.push({ type: 'error', reason: message.stopReason, error: message });
				return;
			}
			stream.push({ type: 'start', partial: message });
			stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
		};
		// A stream that ignores the signal keeps answering a cancelled activation for ever.
		const aborted = () =>
			finish(fauxAssistantMessage('', { stopReason: 'aborted', errorMessage: 'aborted' }));
		if (options?.signal?.aborted) {
			queueMicrotask(aborted);
			return stream;
		}
		options?.signal?.addEventListener('abort', aborted, { once: true });
		void Promise.resolve()
			.then(() => script(scriptContext(context), agent, call))
			.catch((error: unknown) =>
				fauxAssistantMessage('', { stopReason: 'error', errorMessage: String(error) }),
			)
			.then(finish);
		return stream;
	};
}

/**
 * Route a script by seat: one entry per agent that has lines, `quiet()` for the
 * rest. Keeping the seats apart is what keeps each one readable; a single
 * callback branching on `agent` buries the scenario in an if-chain.
 */
export const byAgent = (seats: Record<string, Script>): Script => {
	const table = new Map(Object.entries(seats));
	return (context, agent, call) => (table.get(agent) ?? (() => quiet()))(context, agent, call);
};

export const callTool = (tool: string, args: JsonObject) =>
	fauxAssistantMessage([fauxToolCall(tool, args)], { stopReason: 'toolUse' });

export const speak = (text: string, to?: string) => callTool('say', to ? { to, text } : { text });

export const quiet = (thought = 'nothing to add') =>
	fauxAssistantMessage(thought, { stopReason: 'stop' });

export const isClosing = (context: Context) =>
	context.systemPrompt?.includes('The exchange is over.') ?? false;

export const seat = (name: string) => callTool('seat', { name });

/** Everything the model was shown below the system prompt, as one string. */
export function contextText(context: Context): string {
	return context.messages
		.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
		.join('\n');
}

export const toolNames = (context: Context) => (context.tools ?? []).map((tool) => tool.name);

/** Every tool result the model has been shown so far, as text, oldest first. */
export function toolResultTexts(context: Context): string[] {
	return context.messages.flatMap((message) =>
		message.role === 'toolResult'
			? [message.content.map((c) => (c.type === 'text' ? c.text : '')).join('')]
			: [],
	);
}

/**
 * The results of the model's say calls since the last user message, oldest
 * first: whether each was an error. A session that continues across the
 * activations of an exchange holds the says of the ones before.
 */
function sayResults(context: Context): boolean[] {
	const since = context.messages.slice(
		context.messages.findLastIndex((message) => message.role === 'user') + 1,
	);
	const says = new Set(
		since.flatMap((message) =>
			message.role === 'assistant'
				? message.content.flatMap((item) =>
						item.type === 'toolCall' && item.name === 'say' ? [item.id] : [],
					)
				: [],
		),
	);
	return since.flatMap((message) =>
		message.role === 'toolResult' && says.has(message.toolCallId) ? [message.isError] : [],
	);
}

/** How long the seat that waits for a steer waits between two looks, in milliseconds. */
const LOOK = 10;

/** How many looks the seat that waits for a steer takes before it gives up. */
const LOOKS = 500;

/**
 * The seat waits for the steered line. Each look calls a tool the model
 * does not hold: the harness answers with an error result, and the run takes
 * the next request, which holds any line steered since.
 */
async function awaitSteer(context: Context, text: string): Promise<AssistantMessage> {
	if (sayResults(context).length > 0) return quiet();
	if (contextText(context).includes('[new] ')) return speak(text);
	const looks = context.messages.filter((message) => message.role === 'toolResult').length;
	if (looks >= LOOKS) return quiet();
	await new Promise((resolve) => setTimeout(resolve, LOOK));
	return callTool('wait', {});
}

/** The error a failing provider reports, by cause. */
const FAILURES = {
	permanent: 'Your credit balance is too low',
	transient: 'overloaded 529',
} as const;

/** The script that performs one plan of the suite. */
export function scriptOf(plan: ExecutorPlan): Script {
	switch (plan.kind) {
		case 'sayOnce':
			return (context) => (sayResults(context).length === 0 ? speak(plan.text) : quiet());
		case 'holdSay':
		case 'missThenResay':
			// A `missed` answer is an error result, and it leaves the seat a second say.
			return (context) => {
				const results = sayResults(context);
				return results.length === 0 || (results.length === 1 && results[0] === true)
					? speak(plan.text)
					: quiet();
			};
		case 'sayEachPass':
			return (context) => (context.messages.at(-1)?.role === 'user' ? speak(plan.text) : quiet());
		case 'awaitSteer':
			return (context) => awaitSteer(context, plan.text);
		case 'usage':
			return (context) => {
				if (sayResults(context).length > 0) return quiet();
				const { input, output, cacheRead, cacheWrite } = plan.usage;
				const usage = {
					input,
					output,
					cacheRead,
					cacheWrite,
					totalTokens: input + output + cacheRead + cacheWrite,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};
				return { ...speak(plan.text), usage };
			};
		case 'fail':
			return () => {
				throw new Error(FAILURES[plan.cause]);
			};
	}
}

/**
 * The harness that runs the executor suite on the Pi executor, over a
 * scripted stream and sessions in memory. It declares steering, usage,
 * permanent failure and memory: the harness takes a line during a run,
 * reports its spend, names a refusal, and reopens a session by id.
 */
export function piExecutorHarness(): ExecutorHarness {
	return {
		open: (plan, definition) =>
			createPiExecutor({
				// The suite names a neutral executor. The seat runs on a Pi one.
				definition: {
					...definition,
					executor: pi({ instructions: '', model: `scripted/${definition.name}` }),
				},
				model: stubModel,
				stream: scripted(scriptOf(plan)),
				now: Date.now,
				sessions: memorySessions(),
			}),
		can: { steer: true, usage: true, permanentFailure: true, memory: true },
	};
}
