import type { ToolContext, ToolResult } from '../bundle.ts';
import { composeConnector } from '../execution/connector.ts';
import type {
	Executor,
	ExecutorActivation,
	ExecutorSession,
	PassInput,
	PassResult,
} from '../execution/executor.ts';
import type { Execution, ExecutionConnector, ExecutionHost } from '../host/runtime.ts';
import type { ActivationView, CommitResult } from '../protocol.ts';
import type { AgentDefinition, FailureCause, Intent, Seq, Usage } from '../types.ts';

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

const trimmed = (value: unknown): string | undefined =>
	typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

/** The room intent a call makes, or nothing when the call names an agent's own tool. */
function intentOf(call: Call): Intent | undefined {
	if (call.tool === 'seat') return { kind: 'seated', name: trimmed(call.args.name) ?? '' };
	if (call.tool === 'unseat') return { kind: 'unseated', name: trimmed(call.args.name) ?? '' };
	if (call.tool !== 'say') return undefined;
	const to = trimmed(call.args.to);
	const refs = Array.isArray(call.args.refs) ? call.args.refs.map(String) : [];
	const after = call.args.after;
	return {
		kind: 'said',
		...(to === undefined ? {} : { to }),
		text: trimmed(call.args.text) ?? '',
		...(refs.length === 0 ? {} : { refs }),
		...(typeof after === 'number' ? { after } : {}),
	};
}

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

/** One activation of the scripted executor. */
class ScriptedSession implements ExecutorSession {
	private readonly results: Result[] = [];
	private through: Seq = 0;
	private stopped = false;
	private view: ActivationView | undefined;

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

	get readThrough(): Seq {
		return this.through;
	}

	get cancelled(): boolean {
		return this.stopped;
	}

	abort(): void {
		this.stopped = true;
	}

	shouldRefresh(lastSeq: Seq): boolean {
		return !this.stopped && lastSeq > this.through;
	}

	async pass(input: PassInput): Promise<PassResult> {
		if (this.stopped) return { failed: false };
		this.view = input.view;
		this.through = Math.max(this.through, input.view.through);
		try {
			while (!this.stopped) {
				const step: Step = { view: input.view, results: this.results };
				const turn = await this.script(step, this.definition.name, this.next());
				if (turn.length === 0) break;
				for (const call of turn) await this.run(call);
			}
			return { failed: false };
		} catch (error) {
			return this.broke(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private broke(error: Error): PassResult {
		const cause = error instanceof ScriptedFailure ? error.failure : 'transient';
		this.activation.emit({
			type: 'error',
			agent: this.definition.name,
			activation: this.activation.id,
			error,
			cause,
		});
		return { failed: true, cause, message: error.message };
	}

	/** The count of steps this seat has had in the room, across its activations. */
	private next(): number {
		const count = (this.counts.get(this.definition.name) ?? 0) + 1;
		this.counts.set(this.definition.name, count);
		return count;
	}

	private async run(call: Call): Promise<void> {
		if (this.stopped) return;
		if (call.tool === 'usage') {
			this.activation.trace.record({ type: 'usage', ...usageOf(call.args) });
			this.results.push({ tool: call.tool, text: 'recorded' });
			return;
		}
		const intent = intentOf(call);
		const text = intent === undefined ? await this.invoke(call) : await this.commit(intent);
		this.results.push({ tool: call.tool, text });
	}

	private async commit(intent: Intent): Promise<string> {
		const closing = this.view !== undefined && isClosing(this.view);
		const response = await this.activation.room.commit({
			activation: this.activation.id,
			key: `${this.activation.id}/${this.results.length}`,
			...(closing || intent.kind !== 'said' ? {} : { readThrough: this.through }),
			intent,
		});
		this.acknowledge(response);
		const outcome = answer(response);
		if (outcome.over || (closing && outcome.text === 'delivered')) this.stopped = true;
		return outcome.text;
	}

	/** An accepted say, or the messages a refused say missed, move the position this seat has read to. */
	private acknowledge(response: CommitResult): void {
		if ('committed' in response && response.committed.kind === 'said') {
			this.through = Math.max(this.through, response.committed.seq);
		}
		if ('missed' in response) {
			this.through = Math.max(this.through, response.missed.at(-1)?.seq ?? this.through);
		}
	}

	/** An agent's own tool: emit its events, and give it the context a model loop would. */
	private async invoke(call: Call): Promise<string> {
		const tool = this.definition.executor.tools.find((candidate) => candidate.name === call.tool);
		if (tool === undefined) throw new Error(`The seat has no tool '${call.tool}'.`);
		const emit = (type: 'tool_execution_start' | 'tool_execution_end') =>
			this.activation.emit({
				type,
				agent: this.definition.name,
				activation: this.activation.id,
				toolName: tool.name,
			});
		const exchange = this.view?.context.exchange;
		const context: ToolContext = Object.freeze({
			agent: { name: this.definition.name, identity: this.definition.identity },
			callId: `${this.activation.id}/${this.results.length}`,
			room: this.view?.context.name ?? '',
			activation: this.activation.id,
			...(exchange === undefined
				? {}
				: { exchange: { owner: exchange.owner, from: exchange.from } }),
		});
		emit('tool_execution_start');
		try {
			return textOf(await tool.invoke(call.args, context));
		} finally {
			emit('tool_execution_end');
		}
	}
}

/**
 * A scripted executor for one seat. It implements the `Executor` contract
 * with no model: the script says what the seat does, and the session drives
 * the room's three calls the way a model loop does. A conformance suite
 * passes it to any transport.
 */
export function scriptedExecutor(script: Script, definition: AgentDefinition): Executor {
	const counts = new Map<string, number>();
	return {
		open: (activation) => new ScriptedSession(activation, definition, script, counts),
	};
}

/**
 * A room's execution over one script. Every seat runs a scripted executor,
 * and `byAgent` routes the script by seat. Pass it as `execution` to
 * `startRoom` or `createRuntime`. It needs no model library.
 */
export function scripted(script: Script): Execution {
	return { connector: (host) => connectorFor(host, script) };
}

function connectorFor(host: ExecutionHost, script: Script): ExecutionConnector {
	const counts = new Map<string, number>();
	return composeConnector({
		host,
		traceLimits: host.limits.trace,
		buildExecutor: (request) => ({
			open: (activation) => new ScriptedSession(activation, request.definition, script, counts),
		}),
	});
}
