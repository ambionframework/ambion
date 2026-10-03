/**
 * The run of one compose call: the nested calls of its code, the ledger, the
 * limits, and the end of the call by an error, a cut, or a limit
 * (`docs/compose.md`). A run gives each nested call the ordinary tool
 * path of `tool-call.ts`: preparation, the schema check, `invoke`, and the
 * steps of the trace. It adds a context with the provenance of the compose
 * call and the declared output check.
 */
import { Check } from 'typebox/value';
import type { AmbionTool, ToolContext, ToolResult } from './bundle.ts';
import {
	type ComposeLimits,
	type ComposeResult,
	type ComposeRuntime,
	type JsonValue,
	type LedgerEntry,
	mismatchOf,
	plainJson,
} from './compose.ts';
import { callChecked, checkedArguments, messageOf } from './tool-call.ts';
import type { Step } from './types.ts';

/** What a rejected binding carries across the runtime: the message and the details of the error. */
interface CallError {
	readonly message: string;
	readonly details?: JsonValue;
}

/** One compose call, as the run reports it. `late` holds the calls that outlived the code. */
export interface ComposeOutcome {
	readonly result: ComposeResult;
	/**
	 * The binding value of each completed call, by call id, for a compose call
	 * that did not complete. A room tool has none: its result reaches the model
	 * through the room notes. The ledger holds none.
	 */
	readonly values: ReadonlyMap<string, JsonValue>;
	readonly late: readonly LedgerEntry[];
}

export interface ComposeRunInput {
	/** The tools that the compose call binds, by name. */
	readonly tools: ReadonlyMap<string, AmbionTool>;
	/** The names of the tools that the seat has and the call does not bind. */
	readonly unlisted?: readonly string[];
	readonly code: string;
	/** The checked arguments of a macro. The runtime gives them to the code as `args`. */
	readonly args?: JsonValue;
	readonly runtime: ComposeRuntime;
	readonly limits: ComposeLimits;
	/** The context of the compose call. */
	readonly ctx: ToolContext;
	/** Where the steps of the nested calls go. Absent, the run records no step. */
	readonly record?: (step: Step) => void;
	/**
	 * Whether a call of the tool cannot be cancelled and answers with record
	 * lines. The run waits for such a call to settle before it reports.
	 */
	readonly commits?: (tool: AmbionTool) => boolean;
}

type CallState = 'queued' | 'running' | 'completed' | 'failed' | 'dropped';

interface Call {
	readonly id: string;
	readonly tool: AmbionTool;
	readonly input: JsonValue;
	readonly params: unknown;
	state: CallState;
	error?: string;
	/** The binding value, once the call completed. */
	value?: JsonValue;
	resolve(value: JsonValue): void;
	reject(error: CallError): void;
}

type Ending =
	| { readonly status: 'completed'; readonly value?: JsonValue }
	| {
			readonly status: 'failed' | 'cancelled';
			readonly message: string;
			readonly call?: string;
	  };

/** The fields that a nested call inherits from the compose call. */
const INHERITED = ['agent', 'signal', 'room', 'activation', 'exchange', 'deadline'] as const;

/** The longest delay that a timer holds. */
const MAX_TIMER = 2 ** 31 - 1;

const UTF8 = new TextEncoder();

/** The details of a failure that carries JSON details, such as a `ToolFailure`. */
function detailsOf(error: unknown): JsonValue | undefined {
	if (!(error instanceof Error) || !('details' in error) || error.details === undefined)
		return undefined;
	try {
		return plainJson(error.details);
	} catch {
		return undefined;
	}
}

/** An error, as it crosses to the runtime. */
function crossing(error: unknown): CallError {
	const details = detailsOf(error);
	return details === undefined
		? { message: messageOf(error) }
		: { message: messageOf(error), details };
}

const unsettled = (call: Call): boolean => call.state === 'queued' || call.state === 'running';

/** The id of nested call `index` of the compose call `parent`. */
function nestedCallId(parent: string, index: number): string {
	return `${parent}.${index}`;
}

/** The text parts of a result, joined by a line. */
function textOf(result: string | ToolResult): string {
	if (typeof result === 'string') return result;
	return result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
}

/** The run of one compose call. */
export class ComposeRun {
	private readonly calls: Call[] = [];
	private readonly queue: Call[] = [];
	private readonly late = new Set<Call>();
	private readonly busy = new Set<string>();
	private readonly waiters: (() => void)[] = [];
	/** The running calls that commit to the room. A commit has no cancel. */
	private readonly committing = new Set<Promise<void>>();
	private readonly stop = new AbortController();
	private running = 0;
	/** The run starts no further call that the code makes. */
	private refusing = false;
	/** The run starts no queued call. */
	private closed = false;
	/** The deadline of the activation comes before the time limit. */
	private byDeadline = false;

	private readonly input: ComposeRunInput;

	constructor(input: ComposeRunInput) {
		this.input = input;
	}

	/** Run the code, and report how the compose call ended. */
	async run(): Promise<ComposeOutcome> {
		const { ctx, limits } = this.input;
		if (ctx.signal?.aborted) return this.outcome(this.cut());
		const untilDeadline = (ctx.deadline ?? Number.POSITIVE_INFINITY) - Date.now();
		this.byDeadline = untilDeadline < limits.time;
		const left = Math.min(limits.time, untilDeadline);
		if (left <= 0) return this.outcome(this.timeout());
		const gate = this.watch(left);
		let ending: Ending;
		try {
			ending = await Promise.race([this.body(), gate.stopped]);
		} finally {
			gate.clear();
			this.close();
		}
		// A commit that the end of the call cannot cancel still answers, and its answer can carry record.
		await Promise.all([...this.committing]);
		return this.outcome(ending);
	}

	private cut(): Ending {
		return { status: 'cancelled', message: 'The compose call was cut.' };
	}

	private timeout(): Ending {
		return {
			status: 'failed',
			message: this.byDeadline
				? 'The compose call reached the deadline of the activation.'
				: `The compose call passed compose.limits.time (${this.input.limits.time} ms).`,
		};
	}

	/** The cut of the activation, and the time bound. Each ends the compose call at once. */
	private watch(left: number): { stopped: Promise<Ending>; clear(): void } {
		const { signal } = this.input.ctx;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let listener: (() => void) | undefined;
		const stopped = new Promise<Ending>((resolve) => {
			const trip = (ending: Ending) => {
				this.close();
				resolve(ending);
			};
			listener = () => trip(this.cut());
			signal?.addEventListener('abort', listener, { once: true });
			timer = setTimeout(() => trip(this.timeout()), Math.min(left, MAX_TIMER));
		});
		return {
			stopped,
			clear: () => {
				clearTimeout(timer);
				if (listener !== undefined) signal?.removeEventListener('abort', listener);
			},
		};
	}

	/** Evaluate the code, then wait for each call that started to settle. */
	private async body(): Promise<Ending> {
		const ending = await this.evaluate();
		// Code that ended starts no call, so the content can name each late call.
		this.refusing = true;
		for (const call of this.calls) if (unsettled(call)) this.late.add(call);
		await this.drain();
		return ending;
	}

	private async evaluate(): Promise<Ending> {
		const { runtime, code, tools, args, unlisted } = this.input;
		try {
			const input = {
				code,
				bindings: [...tools.keys()],
				...(unlisted === undefined ? {} : { unlisted }),
				...(args === undefined ? {} : { args }),
				call: (name: string, args: JsonValue) => this.call(name, args),
			};
			return this.returned(await runtime.evaluate(input, this.stop.signal));
		} catch (error) {
			const message = messageOf(error);
			const raised = this.calls.findLast((call) => call.error === message);
			return {
				status: 'failed',
				message,
				...(raised === undefined ? {} : { call: raised.id }),
			};
		}
	}

	/** The ending for a returned value: JSON, within the byte limit. */
	private returned(raw: JsonValue | undefined): Ending {
		if (raw === undefined) return { status: 'completed' };
		try {
			const value = plainJson(raw, 'The returned value');
			const bytes = UTF8.encode(JSON.stringify(value)).length;
			const { bytes: limit } = this.input.limits;
			if (bytes <= limit) return { status: 'completed', value };
			return {
				status: 'failed',
				message: `The returned value is ${bytes} bytes, over compose.limits.bytes (${limit}). Return less.`,
			};
		} catch (error) {
			return { status: 'failed', message: messageOf(error) };
		}
	}

	/** Wait until no call is queued or running. */
	private async drain(): Promise<void> {
		while (this.calls.some(unsettled)) {
			await new Promise<void>((resolve) => this.waiters.push(resolve));
		}
	}

	/** End the run: no call starts, and each queued call is dropped. */
	private close(): void {
		this.refusing = true;
		this.closed = true;
		for (const call of this.queue.splice(0)) {
			call.state = 'dropped';
			call.reject({ message: 'The compose call ended before this call started.' });
		}
		this.stop.abort();
		this.wake();
	}

	private wake(): void {
		for (const waiter of this.waiters.splice(0)) waiter();
	}

	private ledger(): LedgerEntry[] {
		return this.calls.filter((call) => call.state !== 'dropped').map((call) => entryOf(call));
	}

	private outcome(ending: Ending): ComposeOutcome {
		const calls = this.ledger();
		const late = [...this.late].map((call) => entryOf(call));
		const settled = ending.status === 'completed' ? [] : this.calls;
		const values = new Map(
			settled.flatMap((call) => (call.value === undefined ? [] : [[call.id, call.value] as const])),
		);
		if (ending.status === 'completed') {
			const value = ending.value === undefined ? {} : { value: ending.value };
			return { result: { status: 'completed', ...value, calls }, values, late };
		}
		const error = {
			message: ending.message,
			...(ending.call === undefined ? {} : { call: ending.call }),
		};
		return { result: { status: ending.status, error, calls }, values, late };
	}

	/** One binding call of the code. It returns a promise at once, and rejects with a `CallError`. */
	private call(name: string, args: JsonValue): Promise<JsonValue> {
		const promise = new Promise<JsonValue>((resolve, reject) => {
			try {
				this.queue.push(this.admit(name, args, resolve, reject));
				this.pump();
			} catch (error) {
				reject(crossing(error));
			}
		});
		// The code may drop the promise. The rejection then goes unobserved.
		promise.catch(() => {});
		return promise;
	}

	/** Steps 1 and 2 of a nested call: the name, the limits, the preparation, and the schema. */
	private admit(
		name: string,
		args: JsonValue,
		resolve: Call['resolve'],
		reject: Call['reject'],
	): Call {
		const { tools, limits } = this.input;
		if (this.refusing) throw new Error('The compose call has ended: it starts no further call.');
		const tool = tools.get(name);
		// A runtime that conforms throws before it reaches this line. The line guards one that does not.
		if (tool === undefined) throw new Error(`The compose call binds no tool '${name}'.`);
		if (this.calls.length >= limits.calls)
			throw new Error(`The compose call passed compose.limits.calls (${limits.calls}).`);
		const input = plainJson(args, `The arguments of tools.${name}`);
		// A call that fails here has no id, no ledger entry, and no step.
		const params = checkedArguments(tool, input);
		const call: Call = {
			id: nestedCallId(this.input.ctx.callId, this.calls.length + 1),
			tool,
			input,
			params,
			state: 'queued',
			resolve,
			reject,
		};
		this.calls.push(call);
		return call;
	}

	/** Start the queued calls that the cap and the sequential tools allow, in the order made. */
	private pump(): void {
		for (const call of [...this.queue]) {
			if (this.closed || this.running >= this.input.limits.concurrent) return;
			if (call.tool.executionMode === 'sequential' && this.busy.has(call.tool.name)) continue;
			this.queue.splice(this.queue.indexOf(call), 1);
			this.start(call);
		}
	}

	private start(call: Call): void {
		call.state = 'running';
		this.running += 1;
		if (call.tool.executionMode === 'sequential') this.busy.add(call.tool.name);
		const done = this.execute(call).then(() => {
			this.running -= 1;
			this.busy.delete(call.tool.name);
			this.pump();
			this.wake();
		});
		if (this.input.commits?.(call.tool)) {
			this.committing.add(done);
			void done.then(() => this.committing.delete(done));
		}
	}

	/** Steps 3 to 5: the context, `invoke` with its steps, the declared output, and the binding value. It never rejects. */
	private async execute(call: Call): Promise<void> {
		const { ctx, record } = this.input;
		const nest = record === undefined ? undefined : { parent: ctx.callId, record };
		let result: string | ToolResult;
		try {
			result = await callChecked(call.tool, call.input, call.params, this.contextOf(call), nest);
		} catch (error) {
			this.fail(call, error);
			return;
		}
		call.state = 'completed';
		try {
			const value = this.valueOf(call, result);
			// The result of a room tool reaches the model through the room notes, once.
			if (!this.input.commits?.(call.tool)) call.value = value;
			call.resolve(value);
		} catch (error) {
			call.error = messageOf(error);
			call.reject(crossing(error));
		}
	}

	private fail(call: Call, error: unknown): void {
		call.state = 'failed';
		call.error = messageOf(error);
		call.reject(crossing(error));
	}

	/** The context of a nested call: the provenance of the compose call, and a call id of its own. */
	private contextOf(call: Call): ToolContext {
		const { ctx } = this.input;
		const inherited = Object.fromEntries(
			INHERITED.flatMap((key) => (ctx[key] === undefined ? [] : [[key, ctx[key]]])),
		);
		return Object.freeze({
			...inherited,
			callId: call.id,
			composeCall: ctx.callId,
		}) as ToolContext;
	}

	/** The binding value: the checked `details` of a declared tool, or the text of the others. */
	private valueOf(call: Call, result: string | ToolResult): JsonValue {
		const declared = call.tool.compose;
		if (!declared) return textOf(result);
		const details = typeof result === 'string' ? undefined : result.details;
		if (!Check(declared.output, details)) {
			throw new Error(
				`The details of call ${call.id} of tool '${call.tool.name}' break its declared output: ${mismatchOf(declared.output, details)}. The call completed, and its effect stands.`,
			);
		}
		return plainJson(details, `The details of call ${call.id} of tool '${call.tool.name}'`);
	}
}

/** The ledger entry of a call. A call that has not settled is `pending`. */
function entryOf(call: Call): LedgerEntry {
	const status = call.state === 'completed' || call.state === 'failed' ? call.state : 'pending';
	return { call: call.id, tool: call.tool.name, status };
}
