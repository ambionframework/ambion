/**
 * One Pi agent run outside a room: a system prompt, one prompt, and tools,
 * until the agent calls a tool that ends the run.
 *
 * - **Tools.** `describeExecutor` flattens the tools and the bundles, and
 *   joins the guidance of the bundles. `defineAgent` refuses a duplicate
 *   name, and a name the room keeps for itself.
 * - **The end.** A tool that `ends` names ends the run when it succeeds. The
 *   run returns that call, and every call before it. A tool that the model
 *   calls after the end gets a result that ends the run too, and the run
 *   keeps no record of it. When a sequential batch holds another call
 *   before the end, the harness sends one more request, and the model can
 *   only end the run.
 * - **Context.** Each call receives the agent, the call id, the signal, and
 *   the update callback. A run has no room, no activation, and no exchange,
 *   so it resolves no reminder.
 * - **Session.** The run opens one session under the name `name`, prompts it
 *   once, and closes it. It has no steer and no resume.
 * - **Bound.** `signal` aborts the run, and every provider request with it.
 *   A run whose signal aborted rejects, even when an end landed first.
 */
import {
	type AgentDefinition,
	type AmbionTool,
	defineAgent,
	type ToolBundle,
	type ToolContext,
	type Usage,
} from '@ambionframework/ambion';
import { describeExecutor } from '@ambionframework/ambion/hosting';
import type { HarnessEvent, RunResult, StreamFn } from '@earendil-works/pi-agent-core';
import { BACKGROUND_CONTEXT, DEFAULT_COMPACTION_SETTINGS } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { passOutcome } from './failure.ts';
import { providerMessages } from './freshness.ts';
import { openHarness } from './harness.ts';
import { streamModels } from './models.ts';
import { PiSteps } from './pi-trace.ts';
import type { ExecutionServices } from './services.ts';
import { type ContextOf, fromAmbionTool, type PiTool } from './tools.ts';

const CONTEXT = BACKGROUND_CONTEXT;

/**
 * The room name of every session a run opens. A room name holds no `#`, so
 * the session store keeps runs apart from rooms.
 */
const RUN_SCOPE = '#run-agent';

/** One tool call of a run. */
export interface RunAgentCall {
	readonly tool: string;
	readonly args: unknown;
}

export interface RunAgentRequest {
	/** A `provider/model-id`. */
	readonly model: string;
	/** The routing name. A scripted stream routes on it, and the session store keeps the run under it. */
	readonly name: string;
	/** Who the tools see in `ctx.agent`. */
	readonly agent: { readonly name: string; readonly identity: string };
	readonly system: string;
	readonly prompt: string;
	readonly tools?: readonly AmbionTool[];
	readonly bundles?: readonly ToolBundle[];
	/** The names of the tools that end the run. Each one names a tool of the run. */
	readonly ends: readonly string[];
	readonly signal?: AbortSignal;
}

export interface RunAgentResult {
	/** The call that ended the run. */
	readonly end: RunAgentCall;
	/** Every call before the end, in the order the tools started. */
	readonly calls: readonly RunAgentCall[];
	/** The sum of every provider request of the run. */
	readonly usage: Usage;
}

const noop = () => {};

const ZERO: Usage = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/**
 * Run one agent on Pi's `AgentHarness` until it calls a tool in `ends`.
 * Rejects when the run fails, when the signal aborts it, and when the agent
 * stops with no call to a tool in `ends`.
 */
export async function runAgent(
	services: ExecutionServices,
	request: RunAgentRequest,
): Promise<RunAgentResult> {
	const definition = defineAgent({
		name: request.agent.name,
		identity: request.agent.identity,
		executor: describeExecutor({
			kind: 'pi',
			instructions: request.system,
			...(request.tools === undefined ? {} : { tools: request.tools }),
			...(request.bundles === undefined ? {} : { bundles: request.bundles }),
		}),
	});
	const run = new Run(definition, endsOf(definition, request.ends));
	request.signal?.throwIfAborted();
	const model = await services.model(request.model, request.name);
	const session = await services.sessions.create(
		{ room: RUN_SCOPE, seat: request.name },
		crypto.randomUUID(),
		CONTEXT,
	);
	const opened = await openHarness({
		session,
		models: streamModels(model, bounded(services.stream, request.signal)),
		model,
		tools: definition.executor.tools.map((tool) => run.tool(tool)),
		systemPrompt: () => systemOf(definition),
		compaction: DEFAULT_COMPACTION_SETTINGS,
		toProviderMessages: providerMessages,
		onEvent: (event) => run.note(event),
	}).catch(async (error: unknown) => {
		await session.close(CONTEXT).catch(noop);
		throw error;
	});
	const abort = () => void opened.lane.abort(CONTEXT).catch(noop);
	request.signal?.addEventListener('abort', abort, { once: true });
	try {
		// An abort that landed while the run opened ends it here. No await stands between this and the prompt.
		request.signal?.throwIfAborted();
		const result = await opened.lane.prompt(request.prompt, undefined, CONTEXT);
		return run.result(result, request.signal);
	} catch (error) {
		// A run that the signal cut rejects with the signal's reason, whatever the lane threw.
		request.signal?.throwIfAborted();
		throw error;
	} finally {
		request.signal?.removeEventListener('abort', abort);
		await opened.harness.close(CONTEXT).catch(noop);
	}
}

/**
 * A stream whose every request also ends when `signal` aborts. The lane
 * ignores an abort that lands before it admits the prompt, so the signal
 * cuts the request itself.
 */
function bounded(stream: StreamFn, signal: AbortSignal | undefined): StreamFn {
	if (signal === undefined) return stream;
	return (model, context, options) =>
		stream(model, context, {
			...options,
			signal: options?.signal === undefined ? signal : AbortSignal.any([options.signal, signal]),
		});
}

/** The names in `ends`, once each names a tool of the run. */
function endsOf(definition: AgentDefinition, ends: readonly string[]): ReadonlySet<string> {
	if (ends.length === 0) throw new Error('A run needs at least one tool in `ends`.');
	const names = new Set(definition.executor.tools.map((tool) => tool.name));
	for (const end of ends) {
		if (!names.has(end)) throw new Error(`The tool '${end}' in \`ends\` is not a tool of the run.`);
	}
	return new Set(ends);
}

/** The system prompt: the instructions, then the guidance of the bundles. */
function systemOf(definition: AgentDefinition): string {
	const { instructions, guidance } = definition.executor;
	return guidance === undefined ? instructions : `${instructions}\n\n${guidance}`;
}

/** A result that ends the run with no other effect. */
const ended = (text: string) => ({
	content: [{ type: 'text' as const, text }],
	details: {},
	terminate: true,
});

/** The calls, the end, and the spend of one run. */
class Run {
	private readonly steps = new PiSteps();
	private readonly calls: RunAgentCall[] = [];
	private end: RunAgentCall | undefined;
	private usage: Usage = ZERO;
	private last: AssistantMessage | undefined;
	private readonly contextOf: ContextOf;
	private readonly definition: AgentDefinition;
	private readonly ends: ReadonlySet<string>;

	constructor(definition: AgentDefinition, ends: ReadonlySet<string>) {
		this.definition = definition;
		this.ends = ends;
		const agent = Object.freeze({ name: definition.name, identity: definition.identity });
		this.contextOf = (call, signal, onUpdate): ToolContext =>
			Object.freeze({
				agent,
				signal,
				callId: call,
				...(onUpdate === undefined ? {} : { onUpdate }),
			});
	}

	/** A harness tool that records its call, and ends the run when `ends` names it. */
	tool(tool: AmbionTool): PiTool {
		const inner = fromAmbionTool(tool, this.contextOf);
		const ending = this.ends.has(tool.name);
		return {
			...inner,
			execute: async (...args) => {
				if (this.end !== undefined) return ended('The run already ended. Call no other tool.');
				const call: RunAgentCall = { tool: tool.name, args: args[1] };
				if (!ending) {
					this.calls.push(call);
					return inner.execute(...args);
				}
				try {
					const result = await inner.execute(...args);
					// Two ending calls in one batch can run at once. The first to succeed ends the run.
					this.end ??= call;
					return { ...result, terminate: true };
				} catch (error) {
					this.calls.push(call);
					throw error;
				}
			},
		};
	}

	/** One harness event: the spend of a request, and the last assistant message. */
	note(event: HarnessEvent): void {
		for (const step of this.steps.steps(event)) {
			if (step.type === 'usage') this.usage = sum(this.usage, step);
		}
		if (event.type === 'message_end' && event.message.role === 'assistant') {
			this.last = event.message;
		}
	}

	/** What the run returns, or why it rejects. */
	result(result: RunResult, signal: AbortSignal | undefined): RunAgentResult {
		// A run whose signal aborted rejects, even when an end landed first.
		signal?.throwIfAborted();
		const end = this.end;
		if (end !== undefined) return { end, calls: [...this.calls], usage: this.usage };
		const outcome = passOutcome(result, this.last);
		if (outcome.failed) throw outcome.error;
		const names = [...this.ends].join("', '");
		if (outcome.stop === 'length') {
			throw new Error(
				`The agent '${this.definition.name}' reached the output limit with no call to '${names}'.`,
			);
		}
		throw new Error(`The agent '${this.definition.name}' stopped with no call to '${names}'.`);
	}
}

/** Two totals added. `cost` stays absent until a request carries it. */
function sum(total: Usage, step: Usage): Usage {
	const cost =
		total.cost === undefined && step.cost === undefined
			? undefined
			: (total.cost ?? 0) + (step.cost ?? 0);
	return {
		input: total.input + step.input,
		output: total.output + step.output,
		cacheRead: total.cacheRead + step.cacheRead,
		cacheWrite: total.cacheWrite + step.cacheWrite,
		...(cost === undefined ? {} : { cost }),
	};
}
