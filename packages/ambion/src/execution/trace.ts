/**
 * The trace: what one activation did, step by step.
 *
 * The driver opens one sink for each activation. The driver and the executor
 * record raw steps into it. The sink applies the trace policy and the
 * runtime limits, stamps each step, and gives it to the logger that the host
 * passes in. With no logger, the sink drops the steps. One counter per pass
 * gives every step its place, so the logger receives the steps in order.
 *
 * The trace is not part of the record. A logger that throws or rejects does
 * not change the outcome of the activation or its lease. The sink sums the
 * usage steps in memory, so the release keeps the usage with or without a
 * logger.
 */
import type { Limits } from '../host/runtime.ts';
import {
	addUsage,
	type Seq,
	type Step,
	type TraceLogger,
	type TracePolicy,
	type TraceStep,
	type Usage,
} from '../types.ts';

/** How many characters of a thinking block the `summary` policy keeps. */
const THINKING_SUMMARY_CHARS = 280;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null;

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
	/**
	 * The sum of every `usage` step recorded so far, or nothing when none came.
	 * The sum counts steps the pass cap dropped, and steps with no logger.
	 */
	usage(): Usage | undefined;
	/** Give the block in progress to the logger. */
	close(): Promise<void>;
}

/** Opens the sink of one activation. */
export interface TraceOpener {
	open(activation: string): TraceSink;
}

export interface TraceOptions {
	readonly room: string;
	readonly seat: string;
	/** Where the steps go. Absent, the sink drops them. */
	readonly logger?: TraceLogger;
	readonly limits: Limits['trace'];
	readonly policy: TracePolicy;
	readonly now: () => number;
}

/** A sink for one activation. */
export function openTrace(options: TraceOptions & { readonly activation: string }): TraceSink {
	return new Trace(options);
}

/** The opener a connector builds once for a seat. */
export function traceOpener(options: TraceOptions): TraceOpener {
	return { open: (activation) => openTrace({ ...options, activation }) };
}

/** A step value as plain JSON, so it survives the wire and the log. */
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

/** The bytes a base64 string decodes to, from its length alone. */
function base64Bytes(base64: string): number {
	const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
	return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/**
 * A tool result's image content, with each image's data replaced by its byte
 * count. A record that does not hold a `content` array passes through
 * unchanged, and so does every other content part.
 *
 * A tool result can carry an image inline as base64
 * (`ToolResult.content`, `types.ts`). Writing that image whole into the log
 * bloats every record for no reader: nothing here decodes an
 * image back into a picture. This keeps the shape and the size, and drops
 * the bytes.
 */
export function loggedToolResult(value: unknown): unknown {
	if (!isRecord(value) || !Array.isArray(value.content)) return value;
	return { ...value, content: value.content.map(loggedContentPart) };
}

function loggedContentPart(part: unknown): unknown {
	if (!isRecord(part) || part.type !== 'image' || typeof part.data !== 'string') return part;
	const { data, ...rest } = part;
	return { ...rest, bytes: base64Bytes(data) };
}

class Trace implements TraceSink {
	private readonly options: TraceOptions & { readonly activation: string };
	private pass = 0;
	private index = 0;
	/** The steps logged in this pass, against `stepsPerPass`. */
	private written = 0;
	private total: Usage | undefined;
	private pending: { type: 'thinking' | 'text'; text: string } | undefined;

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

	usage(): Usage | undefined {
		return this.total;
	}

	record(step: Step): void {
		if (step.type === 'usage') this.total = addUsage(this.total, step);
		if (this.options.logger === undefined) return;
		if (step.type === 'thinking' || step.type === 'text') {
			this.block(step);
			return;
		}
		this.flush();
		this.stamp(this.limited(step));
	}

	async close(): Promise<void> {
		this.flush();
	}

	/** Join a delta to the block in progress. A `final` step ends the block. */
	private block(step: Extract<Step, { type: 'thinking' | 'text' }>): void {
		if (step.type === 'thinking' && this.options.policy.thinking === 'omit') return;
		if (this.pending !== undefined && this.pending.type !== step.type) this.flush();
		this.pending = { type: step.type, text: (this.pending?.text ?? '') + step.text };
		if (step.final) this.flush();
	}

	/** Log the block in progress as one final step. */
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
						: bounded(loggedToolResult(plain(step.output)), this.options.limits.toolOutputBytes);
				return { ...step, output };
			}
			default:
				return step;
		}
	}

	/** Stamp a step and log it. A pass past its cap drops all but `end`. */
	private stamp(step: Step): void {
		const { logger, limits, room, seat, activation } = this.options;
		if (logger === undefined) return;
		if (this.written >= limits.stepsPerPass && step.type !== 'end') return;
		const traced: TraceStep = {
			...step,
			activation,
			pass: this.pass,
			at: new Date(this.options.now()).toISOString(),
			index: this.index,
		};
		this.index += 1;
		this.written += 1;
		try {
			const result: unknown = logger({ room, seat, step: traced });
			if (result instanceof Promise) result.catch(() => {});
		} catch {
			// The trace never fails an activation.
		}
	}
}
