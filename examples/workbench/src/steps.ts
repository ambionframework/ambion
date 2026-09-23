import type { ExchangeActivation, TraceLogger, TraceStep, Usage } from '@ambionframework/ambion';

/** One pass of an activation: what it read and the steps it took. */
interface ActivationPass {
	readonly pass: number;
	/** Whether the pass read the whole view or only what changed. */
	readonly input: 'view' | 'delta';
	/** The last seq the pass read. */
	readonly through: number;
	readonly steps: readonly TraceStep[];
}

/** The steps of one activation that the logger received, grouped by pass. */
export interface ActivationSteps {
	readonly activation: string;
	readonly passes: readonly ActivationPass[];
}

/** One step of an activation, ready to draw. */
interface StepLine {
	readonly kind: string;
	readonly text: string;
}

/** One pass of an activation with its step lines. */
export interface PassView {
	readonly pass: number;
	readonly input: 'view' | 'delta';
	readonly through: number;
	readonly lines: StepLine[];
}

const WIDTH = 100;

/** The first line of a text, cut to a fixed width. */
function brief(text: string): string {
	const line = (text.split('\n')[0] ?? '').trim();
	return line.length > WIDTH ? `${line.slice(0, WIDTH - 1)}…` : line;
}

function render(value: unknown): string {
	if (typeof value === 'string') return brief(value);
	const json = JSON.stringify(value);
	return brief(json ?? '');
}

/** Format a token count, as in `12.3k`. */
function tokens(count: number): string {
	return count < 1000 ? String(count) : `${(count / 1000).toFixed(1)}k`;
}

/**
 * What an activation or an exchange spent. The cost in dollars comes first. A
 * run with no cost shows its tokens. A run with no usage shows nothing.
 */
export function formatUsage(usage: Usage | undefined): string {
	if (!usage) return '';
	if (usage.cost !== undefined) return `$${usage.cost.toFixed(4)}`;
	const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	return total > 0 ? `${tokens(total)} tokens` : '';
}

/** One activation as a line: seat, purpose, attempt, state, and cost. */
export function activationLine(activation: ExchangeActivation): string {
	const cost = formatUsage(activation.usage);
	const parts = [
		activation.seat,
		activation.purpose,
		`attempt ${activation.attempt}`,
		...(activation.outcome.status === 'running' ? ['running'] : []),
		...(cost ? [cost] : []),
	];
	return parts.join(' · ');
}

function decisionOf(step: Extract<TraceStep, { type: 'approval' }>): string {
	if (step.decision === undefined) return 'waiting for the harness permission';
	return step.decision === 'allow' ? 'harness permission allowed' : 'harness permission denied';
}

function lineOf(step: TraceStep): StepLine {
	switch (step.type) {
		case 'pass':
			return { kind: 'pass', text: `pass ${step.pass}` };
		case 'thinking':
			return { kind: 'thinking', text: brief(step.text) };
		case 'text':
			return { kind: 'text', text: brief(step.text) };
		case 'tool_call':
			return { kind: 'tool', text: `${step.name} ${render(step.input)}`.trim() };
		case 'tool_result':
			return step.error
				? { kind: 'error', text: `failed: ${brief(step.error)}` }
				: { kind: 'result', text: render(step.output) };
		case 'room':
			return { kind: 'room', text: `room ${step.result}${step.seq ? ` at ${step.seq}` : ''}` };
		case 'steer':
			return { kind: 'steer', text: `steer ${step.seq} ${step.consumed ? 'read' : 'queued'}` };
		case 'approval':
			return { kind: 'approval', text: `${step.name}: ${decisionOf(step)}` };
		case 'usage':
			return { kind: 'usage', text: formatUsage(step) };
		case 'end':
			return step.failure
				? { kind: 'error', text: `ended: ${step.failure.message}` }
				: { kind: 'end', text: `ended: ${step.stop}` };
	}
}

/**
 * Group a trace into passes, each with its step lines. The `pass` step opens a
 * pass and shows in its header, so it makes no line. A trace with no `end` step
 * is a running or a crashed activation, and it shows as far as it goes.
 */
export function stepsView(read: ActivationSteps): PassView[] {
	return read.passes.map((pass) => ({
		pass: pass.pass,
		input: pass.input,
		through: pass.through,
		lines: pass.steps.filter((step) => step.type !== 'pass').map(lineOf),
	}));
}

/** True when the trace has an `end` step. */
export function ended(read: ActivationSteps): boolean {
	return read.passes.some((pass) => pass.steps.some((step) => step.type === 'end'));
}

/** Group steps, in pass and index order, into passes. A `pass` step opens each one. */
function activationSteps(activation: string, steps: readonly TraceStep[]): ActivationSteps {
	const passes: { pass: number; input: 'view' | 'delta'; through: number; steps: TraceStep[] }[] =
		[];
	for (const step of steps) {
		if (step.type === 'pass')
			passes.push({ pass: step.pass, input: step.input, through: step.through, steps: [] });
		passes.at(-1)?.steps.push(step);
	}
	return { activation, passes };
}

/**
 * The steps this process logged, in memory, by room and activation. It keeps
 * the latest `limit` activations and drops the oldest. A restart loses them.
 */
export function stepLog(limit = 200) {
	const kept = new Map<string, TraceStep[]>();
	const key = (room: string, activation: string) => `${room}\n${activation}`;
	const logger: TraceLogger = ({ room, step }) => {
		const at = key(room, step.activation);
		const steps = kept.get(at);
		if (steps !== undefined) {
			steps.push(step);
			return;
		}
		kept.set(at, [step]);
		for (const oldest of kept.keys()) {
			if (kept.size <= limit) break;
			kept.delete(oldest);
		}
	};
	return {
		logger,
		/** The steps of one activation, or nothing when this process logged none. */
		read(room: string, activation: string): ActivationSteps | undefined {
			const steps = kept.get(key(room, activation));
			return steps === undefined ? undefined : activationSteps(activation, steps);
		},
	};
}
