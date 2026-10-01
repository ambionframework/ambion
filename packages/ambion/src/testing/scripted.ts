import type { ToolContext, ToolResult } from '../bundle.ts';
import { localConnector } from '../execution/connector.ts';
import type {
	Executor,
	ExecutorActivation,
	ExecutorSession,
	Pass,
	PassResult,
} from '../execution/executor.ts';
import { failedPass } from '../execution/failure.ts';
import { answerOf } from '../execution/room-tools.ts';
import type { Execution } from '../host/runtime.ts';
import type { ActivationView, CommitResult } from '../protocol.ts';
import type { AgentDefinition, FailureCause, Usage } from '../types.ts';

/** One tool call of a scripted turn. */
export interface Call {
	readonly tool: string;
	readonly args: Record<string, unknown>;
}

/** What a seat does in one step of a pass: the calls it makes. No call ends the pass. */
export type Turn = readonly Call[];

/** What one call answered. `text` is `delivered` when the room took it. */
export interface Result {
	readonly tool: string;
	readonly text: string;
}

/** What a script reads to choose its next turn. */
export interface Step {
	/** The activation's latest view. The first pass reads it whole, a later pass rereads the record. */
	readonly view: ActivationView;
	/** Every result this activation has had, oldest first. */
	readonly results: readonly Result[];
}

/**
 * One activation's answer: the turn for this step, given the step, the seat,
 * and which step this is for that seat. It runs once per step, the way a
 * model runs once per request, and the pass ends on the first empty turn.
 */
export type Script = (step: Step, seat: string, call: number) => Turn | Promise<Turn>;

/** A turn with one call to a tool. */
export const callTool = (tool: string, args: Record<string, unknown> = {}): Turn => [
	{ tool, args },
];

/** A turn that calls `say`, to one seat or to the room. */
export const speak = (text: string, to?: string): Turn =>
	callTool('say', to ? { to, text } : { text });

/** A turn that calls `schedule`: the room wakes the seat with the say after `after` seconds. */
export const later = (text: string, after: number): Turn => callTool('schedule', { text, after });

/** A turn that records the usage of a model request as a `usage` step. */
export const spend = (usage: Usage): Turn => callTool('usage', { ...usage });

/**
 * An error a script throws to end the activation as a failure of a given
 * cause. Any other error ends it as transient.
 */
export class ScriptedFailure extends Error {
	readonly failure: FailureCause;

	constructor(failure: FailureCause, message: string) {
		super(message);
		this.name = 'ScriptedFailure';
		this.failure = failure;
	}
}

/** A turn with no call. The seat has nothing to add. */
export const quiet = (): Turn => [];

/** One script per seat. A seat with no entry answers `quiet()`. */
export const byAgent = (seats: Record<string, Script>): Script => {
	const table = new Map(Object.entries(seats));
	return (step, seat, call) => (table.get(seat) ?? (() => quiet()))(step, seat, call);
};

/** True when the view asks for the summary of a closed exchange. */
export const isClosing = (view: ActivationView): boolean => view.spec.purpose.kind === 'summarize';

/** The room tools a script calls by name. Every other call names a tool of the agent. */
const ROOM_CALLS: ReadonlySet<string> = new Set(['say', 'schedule', 'seat', 'unseat']);

const textOf = (result: string | ToolResult): string =>
	typeof result === 'string'
		? result
		: result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');

const count = (value: unknown): number => (typeof value === 'number' ? value : 0);

/** The usage a `spend` call carries. */
function usageOf(args: Record<string, unknown>): Usage {
	return {
		input: count(args.input),
		output: count(args.output),
		cacheRead: count(args.cacheRead),
		cacheWrite: count(args.cacheWrite),
		...(typeof args.cost === 'number' ? { cost: args.cost } : {}),
	};
}

/** What the seat learns from a commit, and whether the activation must stop. */
function answer(response: CommitResult): { text: string; over: boolean } {
	if ('committed' in response || 'unchanged' in response) return { text: 'delivered', over: false };
	if ('refused' in response) return { text: response.refused, over: false };
	if ('missed' in response) return { text: 'missed', over: false };
	if ('unknown' in response) return { text: 'unknown', over: true };
	return { text: `stale: ${response.stale}`, over: true };
}

/** What a script that throws ends the pass with: the cause a `ScriptedFailure` names, or transient. */
function failureOf(thrown: unknown): PassResult {
	const result = failedPass(thrown);
	return result.error instanceof ScriptedFailure
		? { ...result, cause: result.error.failure }
		: result;
}

/** One activation of the scripted executor. */
class ScriptedSession implements ExecutorSession {
	private readonly results: Result[] = [];
	/** Set when a closing say landed. The activation has nothing more to do. */
	private done = false;

	private readonly activation: ExecutorActivation;
	private readonly definition: AgentDefinition;
	private readonly script: Script;
	private readonly counts: Map<string, number>;

	constructor(
		activation: ExecutorActivation,
		definition: AgentDefinition,
		script: Script,
		counts: Map<string, number>,
	) {
		this.activation = activation;
		this.definition = definition;
		this.script = script;
		this.counts = counts;
	}

	/** Whether the activation ends: a closing say landed, or the activation was cut. */
	private get over(): boolean {
		return this.done || this.activation.signal.aborted;
	}

	async pass(pass: Pass): Promise<PassResult> {
		// The script reads the whole view, so the pass reads the record through it.
		const after = pass.kind === 'delta' ? pass.since : 0;
		this.activation.read({ after, through: pass.view.through });
		try {
			while (!this.over) {
				const step: Step = { view: pass.view, results: this.results };
				const turn = await this.script(step, this.definition.name, this.next());
				if (turn.length === 0) break;
				for (const call of turn) await this.run(call, pass);
			}
			return { failed: false };
		} catch (thrown) {
			return failureOf(thrown);
		}
	}

	/** The count of steps this seat has had in the room, across its activations. */
	private next(): number {
		const count = (this.counts.get(this.definition.name) ?? 0) + 1;
		this.counts.set(this.definition.name, count);
		return count;
	}

	private async run(call: Call, pass: Pass): Promise<void> {
		if (this.over) return;
		if (call.tool === 'usage') {
			this.activation.trace.record({ type: 'usage', ...usageOf(call.args) });
			this.results.push({ tool: call.tool, text: 'recorded' });
			return;
		}
		const text = ROOM_CALLS.has(call.tool)
			? await this.commit(call, pass)
			: await this.invoke(call, pass.view);
		this.results.push({ tool: call.tool, text });
	}

	/** A call of a room tool, keyed on its place in the activation. */
	private async commit(call: Call, pass: Pass): Promise<string> {
		const tool = pass.tools.find((one) => one.name === call.tool);
		if (tool === undefined) throw new Error(`The seat has no tool '${call.tool}'.`);
		const id = this.callId();
		const result = await tool.run(call.args, id);
		// The script reads each result, so the result reached the model.
		this.activation.delivered(id);
		// Each room tool a script calls commits, so the room answered it. The
		// result holds only the text a model reads, and a script reads the
		// answer itself, so the answer comes from beside the result.
		const response = answerOf(result) ?? { unknown: 'The room gave no answer.' };
		const outcome = answer(response);
		if (isClosing(pass.view) && outcome.text === 'delivered') this.done = true;
		return outcome.text;
	}

	/** The id of the next call: the activation and the place of the call in it. */
	private callId(): string {
		return `${this.activation.id}/${this.results.length}`;
	}

	/** An agent's own tool: record its steps, and give it the context a model loop would. */
	private async invoke(call: Call, view: ActivationView): Promise<string> {
		const tool = this.definition.executor.tools.find((candidate) => candidate.name === call.tool);
		if (tool === undefined) throw new Error(`The seat has no tool '${call.tool}'.`);
		const id = this.callId();
		const exchange = view.context.exchange;
		const context: ToolContext = Object.freeze({
			agent: { name: this.definition.name, identity: this.definition.identity },
			callId: id,
			room: view.context.name,
			activation: this.activation.id,
			...(exchange === undefined ? {} : { exchange: { ...exchange } }),
		});
		const { trace } = this.activation;
		trace.record({ type: 'tool_call', call: id, name: tool.name, input: call.args });
		try {
			const text = textOf(await tool.invoke(call.args, context));
			trace.record({ type: 'tool_result', call: id, output: text });
			return text;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			trace.record({ type: 'tool_result', call: id, output: null, error: message });
			throw error;
		}
	}
}

/**
 * A scripted executor for one seat. It implements the `Executor` contract
 * with no model: the script says what the seat does, and the session calls
 * the room tools of the pass the way a model loop does. The executor
 * conformance suite runs it.
 */
export function scriptedExecutor(script: Script, definition: AgentDefinition): Executor {
	const counts = new Map<string, number>();
	return (activation) => new ScriptedSession(activation, definition, script, counts);
}

/**
 * A room's execution over one script. It has no kind, so every seat runs a
 * scripted executor, and `byAgent` routes the script by seat. Pass it as `execution` to
 * `startRoom` or `createRuntime`. It needs no model library.
 */
export function scripted(script: Script): Execution {
	return {
		connector(host) {
			const counts = new Map<string, number>();
			return localConnector(
				host,
				(request) => (activation) =>
					new ScriptedSession(activation, request.definition, script, counts),
			);
		},
	};
}
