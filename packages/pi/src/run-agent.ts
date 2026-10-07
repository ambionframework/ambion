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
 *   keeps no record of it. When a batch holds another call before the end,
 *   the harness sends one more request, and the model can only end the run.
 * - **Context.** Each call receives the agent, the call id, the signal, and
 *   the update callback. A run has no room, no activation, and no exchange,
 *   so it resolves no reminder.
 * - **Session.** The run opens one session in memory, submits one input to
 *   it, and closes it. It has no steer and no resume. It compacts with the
 *   default policy.
 * - **Bound.** `signal` aborts the conversation, and the request in flight
 *   with it. A run whose signal aborted rejects, even when an end landed
 *   first.
 */
import {
	type AgentDefinition,
	type AmbionTool,
	addUsage,
	defineAgent,
	type Step,
	type ToolBundle,
	type ToolContext,
	type Usage,
} from '@ambionframework/ambion';
import { describeExecutor } from '@ambionframework/ambion/hosting';
import { BACKGROUND_CONTEXT as CONTEXT } from '@earendil-works/chord/context';
import type {
	AgentEvent,
	AgentEventStream,
	SettledSubmissionRecord,
	ToolExecutionResult,
} from '@earendil-works/pi-durable';
import { checkThinking, type ThinkingLevel, thinkingOf } from './define.ts';
import { passOutcome } from './failure.ts';
import { openHarness, shutdown } from './harness.ts';
import { streamModels } from './models.ts';
import { PiSteps } from './pi-trace.ts';
import type { ExecutionServices } from './services.ts';
import { memoryStorage } from './sessions.ts';
import { type ContextOf, fromAmbionTool, type PiTool } from './tools.ts';

/** One tool call of a run. */
export interface RunAgentCall {
	readonly tool: string;
	readonly args: unknown;
}

export interface RunAgentRequest {
	/** A `provider/model-id`. */
	readonly model: string;
	/** The routing name. A scripted stream routes on it. */
	readonly name: string;
	/** Who the tools see in `ctx.agent`. */
	readonly agent: { readonly name: string; readonly identity: string };
	readonly system: string;
	readonly prompt: string;
	readonly tools?: readonly AmbionTool[];
	readonly bundles?: readonly ToolBundle[];
	/** The names of the tools that end the run. Each one names a tool of the run. */
	readonly ends: readonly string[];
	/** How much the model reasons before it answers. Absent, `off`. */
	readonly thinking?: ThinkingLevel;
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
 * Run one agent on the pi-durable harness until it calls a tool in `ends`.
 * Rejects when the run fails, when the signal aborts it, and when the agent
 * stops with no call to a tool in `ends`.
 */
export async function runAgent(
	services: ExecutionServices,
	request: RunAgentRequest,
): Promise<RunAgentResult> {
	checkThinking(request.thinking);
	const definition = defineAgent({
		name: request.agent.name,
		identity: request.agent.identity,
		executor: {
			...describeExecutor({
				kind: 'pi',
				instructions: request.system,
				...(request.tools === undefined ? {} : { tools: request.tools }),
				...(request.bundles === undefined ? {} : { bundles: request.bundles }),
			}),
			...(request.thinking === undefined ? {} : { thinking: request.thinking }),
		},
	});
	const run = new Run(definition, endsOf(definition, request.ends));
	request.signal?.throwIfAborted();
	const model = await services.model(request.model, request.name);
	const opened = await openHarness({
		storage: memoryStorage(),
		models: streamModels(model, services.stream),
		model,
		tools: definition.executor.tools.map((tool) => run.tool(tool)),
		systemPrompt: () => systemOf(definition),
		compaction: {},
		thinking: thinkingOf(definition.executor, definition.name),
		resume: false,
		beforeRequest: noop,
	});
	run.watch(opened.events);
	const abort = () => void opened.root.abort(CONTEXT).catch(noop);
	request.signal?.addEventListener('abort', abort, { once: true });
	try {
		// An abort that landed while the run opened ends it here.
		request.signal?.throwIfAborted();
		const input = await opened.root.submit({ type: 'input', content: request.prompt }, CONTEXT);
		// An abort that landed while the input went in finds the run now.
		if (request.signal?.aborted) await opened.root.abort(CONTEXT);
		const settled = await opened.trap.race(input.wait(CONTEXT));
		await run.drain();
		return run.result(settled, request.signal);
	} catch (error) {
		// A run that the signal cut rejects with the signal's reason, whatever the conversation threw.
		request.signal?.throwIfAborted();
		throw error;
	} finally {
		request.signal?.removeEventListener('abort', abort);
		await shutdown(opened).catch(noop);
	}
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
const ended = (text: string): ToolExecutionResult => ({
	content: [{ type: 'text', text }],
	control: { terminate: true },
});

/** The calls, the end, and the spend of one run. */
class Run {
	private steps: PiSteps | undefined;
	private readonly calls: RunAgentCall[] = [];
	private end: RunAgentCall | undefined;
	private usage: Usage = ZERO;
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

	/** A tool registration that records its call, and ends the run when `ends` names it. */
	tool(tool: AmbionTool): PiTool {
		const inner = fromAmbionTool(tool, this.contextOf);
		const ending = this.ends.has(tool.name);
		return {
			...inner,
			execute: async (args, api, context) => {
				if (this.end !== undefined) return ended('The run already ended. Call no other tool.');
				const call: RunAgentCall = { tool: tool.name, args };
				if (!ending) {
					this.calls.push(call);
					return inner.execute(args, api, context);
				}
				const result = await inner.execute(args, api, context);
				if (result.isError === true) {
					this.calls.push(call);
					return result;
				}
				// Two ending calls in one batch can run at once. The first to succeed ends the run.
				this.end ??= call;
				return { ...result, control: { ...result.control, terminate: true } };
			},
		};
	}

	/** Follow the events of the conversation: the spend of each request. */
	watch(events: AgentEventStream): void {
		const steps = new PiSteps(events.snapshot.usage);
		this.steps = steps;
		events.start(async (batch) => {
			for (const event of batch) this.note(steps, event);
		});
	}

	/** Wait for the events of the last messages. */
	async drain(): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, 0));
		for (const step of this.steps?.flush() ?? []) this.spend(step);
	}

	private note(steps: PiSteps, event: AgentEvent): void {
		for (const step of steps.steps(event)) this.spend(step);
	}

	private spend(step: Step): void {
		if (step.type === 'usage') this.usage = addUsage(this.usage, step);
	}

	/** What the run returns, or why it rejects. */
	result(settled: SettledSubmissionRecord, signal: AbortSignal | undefined): RunAgentResult {
		// A run whose signal aborted rejects, even when an end landed first.
		signal?.throwIfAborted();
		const end = this.end;
		if (end !== undefined) return { end, calls: [...this.calls], usage: this.usage };
		const outcome = passOutcome(settled, this.steps?.last);
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
