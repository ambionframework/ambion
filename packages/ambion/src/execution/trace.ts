/**
 * The trace: what one activation did, step by step.
 *
 * The driver opens one sink for each activation. The driver and the executor
 * record raw steps into it. The sink applies the trace policy and the
 * runtime limits, stamps each step, writes it to the trace journal, and
 * emits it on the event stream. One counter per pass gives every step its
 * place, so the journal and the live stream hold the same steps in the same
 * order.
 *
 * The trace journal is a second journal beside the record. Its write is
 * best effort: a failed write surfaces as a `trace_error` event and never
 * changes the outcome of the activation or its lease. One journal holds one
 * activation, so each attempt has its own trace.
 */
import { Journal, type JournalOpener } from '@ambionframework/journal';
import type { Limits } from '../host/runtime.ts';
import type { ExecutionEvent, Seq, Step, TracePolicy, TraceStep } from '../types.ts';

/** The entry kinds of a trace journal. */
type TraceKind = 'run' | 'step';

interface TraceBodies {
	run: { at: string };
	step: TraceStep;
}

/** How many characters of a thinking block the `summary` policy keeps. */
const THINKING_SUMMARY_CHARS = 280;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null;

/** The trace journal reads a step by its stamps, and a run entry by its time. */
const WORDS = {
	run: 'run' as const,
	accepts(kind: string, body: unknown): kind is TraceKind {
		if (!isRecord(body)) return false;
		if (kind === 'run') return typeof body.at === 'string';
		return (
			kind === 'step' &&
			typeof body.type === 'string' &&
			typeof body.activation === 'string' &&
			Number.isSafeInteger(body.pass) &&
			Number.isSafeInteger(body.index)
		);
	},
};

type TraceJournal = Journal<TraceKind, TraceBodies>;

/** The name of the trace journal for one activation. */
const nameOf = (room: string, activation: string): string => JSON.stringify([room, activation]);

/** What the driver and the executor write to. One sink serves one activation. */
export interface TraceSink {
	/** Open a pass. The sink stamps this pass on every step until the next one. */
	startPass(input: 'view' | 'delta', through: Seq): void;
	/**
	 * Record one raw step. The sink joins consecutive `thinking` and `text`
	 * deltas into one block. A block ends at a `final` step or at a step of
	 * another type.
	 */
	record(step: Step): void;
	/** Write the block in progress, wait for every write, and close the trace journal. */
	close(): Promise<void>;
}

/** Opens the sink of one activation. */
export interface TraceOpener {
	open(activation: string): TraceSink;
}

export interface TraceOptions {
	readonly room: string;
	readonly agent: string;
	readonly traces: JournalOpener;
	readonly limits: Limits['trace'];
	readonly policy: TracePolicy;
	readonly emit: (event: ExecutionEvent) => void;
	readonly now: () => number;
}

/** A sink for one activation. It opens the trace journal on the first write. */
export function openTrace(options: TraceOptions & { readonly activation: string }): TraceSink {
	return new Trace(options);
}

/** The opener a connector builds once for a seat. */
export function traceOpener(options: TraceOptions): TraceOpener {
	return { open: (activation) => openTrace({ ...options, activation }) };
}

/** A step value as plain JSON, so it survives the wire and the journal. */
function plain(value: unknown): unknown {
	if (value === undefined) return null;
	try {
		return JSON.parse(JSON.stringify(value)) as unknown;
	} catch {
		return String(value);
	}
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The output cut to the byte limit, with a note of what it lost. */
function bounded(output: unknown, limit: number): unknown {
	const text = typeof output === 'string' ? output : (JSON.stringify(output) ?? '');
	const bytes = encoder.encode(text);
	if (bytes.length <= limit) return output;
	return `${decoder.decode(bytes.slice(0, limit))}\n[truncated: ${bytes.length} bytes]`;
}

class Trace implements TraceSink {
	private readonly options: TraceOptions & { readonly activation: string };
	private pass = 0;
	private index = 0;
	/** The steps written in this pass, against `stepsPerPass`. */
	private written = 0;
	private pending: { type: 'thinking' | 'text'; text: string } | undefined;
	private journal: TraceJournal | undefined;
	private fence: Promise<unknown> | undefined;
	private tail: Promise<void> = Promise.resolve();

	constructor(options: TraceOptions & { readonly activation: string }) {
		this.options = options;
	}

	startPass(input: 'view' | 'delta', through: Seq): void {
		this.flush();
		this.pass += 1;
		this.index = 0;
		this.written = 0;
		this.stamp({ type: 'pass', pass: this.pass, input, through });
	}

	record(step: Step): void {
		if (step.type === 'thinking' || step.type === 'text') {
			this.block(step);
			return;
		}
		this.flush();
		this.stamp(this.limited(step));
	}

	async close(): Promise<void> {
		this.flush();
		await this.tail;
		this.journal?.close();
	}

	/** Join a delta to the block in progress. A `final` step ends the block. */
	private block(step: Extract<Step, { type: 'thinking' | 'text' }>): void {
		if (step.type === 'thinking' && this.options.policy.thinking === 'omit') return;
		if (this.pending !== undefined && this.pending.type !== step.type) this.flush();
		this.pending = { type: step.type, text: (this.pending?.text ?? '') + step.text };
		if (step.final) this.flush();
	}

	/** Write the block in progress as one final step. */
	private flush(): void {
		const block = this.pending;
		this.pending = undefined;
		if (block === undefined || block.text === '') return;
		const summary = block.type === 'thinking' && this.options.policy.thinking === 'summary';
		const text = summary ? block.text.slice(0, THINKING_SUMMARY_CHARS) : block.text;
		this.stamp({ type: block.type, text, final: true });
	}

	/** The policy and the byte limit applied to a step. */
	private limited(step: Step): Step {
		switch (step.type) {
			case 'tool_call':
				return { ...step, input: plain(step.input) };
			case 'tool_result': {
				const output =
					this.options.policy.toolOutput === 'omit'
						? null
						: bounded(plain(step.output), this.options.limits.toolOutputBytes);
				return { ...step, output };
			}
			default:
				return step;
		}
	}

	/** Stamp a step, emit it, and queue its write. A pass past its cap drops all but `end`. */
	private stamp(step: Step): void {
		if (this.written >= this.options.limits.stepsPerPass && step.type !== 'end') return;
		const traced: TraceStep = {
			...step,
			activation: this.options.activation,
			pass: this.pass,
			at: new Date(this.options.now()).toISOString(),
			index: this.index,
		};
		this.index += 1;
		this.written += 1;
		this.emit({
			type: 'step',
			agent: this.options.agent,
			activation: this.options.activation,
			step: traced,
		});
		this.tail = this.tail.then(() => this.append(traced)).catch((error) => this.fail(error));
	}

	private open(): TraceJournal {
		if (this.journal === undefined) {
			const { traces, room, activation } = this.options;
			this.journal = new Journal<TraceKind, TraceBodies>(
				traces.open(nameOf(room, activation)),
				WORDS,
				undefined,
				crypto.randomUUID(),
			);
		}
		return this.journal;
	}

	/** One step into the journal, once: the key names the pass and the place. */
	private async append(step: TraceStep): Promise<void> {
		const journal = this.open();
		this.fence ??= journal.append('run', {
			decide: () => ({ body: { at: new Date(this.options.now()).toISOString() } }),
		});
		try {
			await this.fence;
		} catch (error) {
			this.fence = undefined;
			throw error;
		}
		await journal.append('step', {
			key: `${step.pass}:${step.index}`,
			decide: () => ({ body: step }),
		});
	}

	private fail(error: unknown): void {
		this.emit({
			type: 'trace_error',
			agent: this.options.agent,
			activation: this.options.activation,
			error: error instanceof Error ? error : new Error(String(error)),
		});
	}

	/** A diagnostic listener cannot strand a write. */
	private emit(event: ExecutionEvent): void {
		try {
			this.options.emit(event);
		} catch {
			// The trace never fails an activation.
		}
	}
}

/** The steps of one activation, in the order of pass and then index. */
export async function readTrace(
	traces: JournalOpener,
	room: string,
	activation: string,
): Promise<TraceStep[]> {
	const journal = new Journal<TraceKind, TraceBodies>(traces.open(nameOf(room, activation)), WORDS);
	await journal.ready;
	return journal.entries
		.flatMap((entry) => (entry.kind === 'step' ? [entry.body] : []))
		.sort((a, b) => a.pass - b.pass || a.index - b.index);
}
