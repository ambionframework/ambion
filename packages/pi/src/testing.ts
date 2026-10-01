/**
 * The deterministic tools for a room on Pi: a scripted `StreamFn` that
 * `piExecution({ stream })` takes, the helpers that read what the model was
 * shown, and the harness that runs the executor suite of
 * `@ambionframework/ambion/conformance` on the Pi executor. A script answers
 * with the verbs of `@ambionframework/ambion/testing`: `speak`, `callTool`,
 * `schedule`, `seat`, `quiet`, and `byAgent`. A test that needs no Pi imports
 * `scripted` from `@ambionframework/ambion/testing`, which runs a script with
 * no model.
 */

import { contentText } from '@ambionframework/ambion';
import type { ExecutorHarness, ExecutorPlan } from '@ambionframework/ambion/conformance';
import { callTool, quiet, type Reply, speak } from '@ambionframework/ambion/testing';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Context, JsonObject, JsonValue } from '@earendil-works/pi-ai';
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

/**
 * One activation's answer, given the context, the seat, and which call this
 * is. A `Reply` is the usual answer. A message passes through unchanged, for
 * a test that needs an error, a length stop, or a usage report.
 */
export type PiScript = (
	context: Context,
	seat: string,
	call: number,
) => Reply | AssistantMessage | Promise<Reply | AssistantMessage>;

/**
 * The value as JSON data. A value that JSON cannot hold, such as `undefined`
 * or an instance of a class, is an error.
 */
function jsonValue(value: unknown): JsonValue {
	if (value === null) return value;
	if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
		return value;
	}
	if (Array.isArray(value)) return value.map(jsonValue);
	if (typeof value === 'object' && isPlain(value)) return jsonObject(value);
	throw new Error(`A Pi script call carries a value that is not JSON: ${String(value)}.`);
}

/** Whether `value` is a plain object: its prototype is `Object.prototype` or none. */
function isPlain(value: object): boolean {
	const prototype: unknown = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function jsonObject(value: object): JsonObject {
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]));
}

/**
 * The message a reply stands for. A reply with calls is one message with one
 * tool call each. An empty reply is a message that ends the run with a text.
 * Pi has no step to record usage in, so a `spend` call is an error.
 */
function messageOf(output: Reply | AssistantMessage): AssistantMessage {
	if ('role' in output) return output;
	if (output.length === 0) return fauxAssistantMessage('nothing to add', { stopReason: 'stop' });
	if (output.some((call) => call.tool === 'usage')) {
		throw new Error('A Pi script cannot spend. Return a message with a `usage` field.');
	}
	return fauxAssistantMessage(
		output.map((call) => fauxToolCall(call.tool, jsonObject(call.args))),
		{ stopReason: 'toolUse' },
	);
}

/**
 * A deterministic stream. It routes on the seat that the stub model names
 * (`model.name`), so no script reads the prompt to find out who it is. It
 * counts calls per seat, answers an abort with an aborted message, and turns
 * a script that throws into an error on the stream. It turns a reply into a
 * message: one tool call for each call, or a text that ends the run.
 */
export function scripted(script: PiScript): StreamFn {
	const calls = new Map<string, number>();
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const seat = model.name;
		const call = (calls.get(seat) ?? 0) + 1;
		calls.set(seat, call);
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
			.then(async () => messageOf(await script(scriptContext(context), seat, call)))
			.catch((error: unknown) =>
				fauxAssistantMessage('', { stopReason: 'error', errorMessage: String(error) }),
			)
			.then(finish);
		return stream;
	};
}

/** True when the system prompt of the context asks for the summary of a closed exchange. */
export const isClosingContext = (context: Context) =>
	context.systemPrompt?.includes('The exchange is over.') ?? false;

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
		message.role === 'toolResult' ? [contentText(message.content)] : [],
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
async function awaitSteer(context: Context, text: string): Promise<Reply> {
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
export function scriptOf(plan: ExecutorPlan): PiScript {
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
				return { ...messageOf(speak(plan.text)), usage };
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
