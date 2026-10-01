/**
 * A debug aid for the live executor suite. With `AMBION_LIVE_DUMP=<dir>`,
 * each case writes one JSON file to `<dir>`: the room calls with their
 * answers, every step the logger received, and, for each activation, the
 * prompt of each pass and each call that the executor made to the core.
 * Without the variable, the harness runs as it is.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecutorCaseReport } from '@ambionframework/ambion/conformance';
import type {
	Executor,
	ExecutorActivation,
	ExecutorSession,
	Pass,
} from '@ambionframework/ambion/hosting';
import { Codex, type CodexOptions, type ThreadOptions, type TurnOptions } from '@openai/codex-sdk';
import type { CodexExecutorOptions } from '../../src/executor.ts';

/** The variable that names the directory of the dump. */
const DUMP_VAR = 'AMBION_LIVE_DUMP';

/** What one activation did, as the executor saw it. */
interface Seen {
	readonly id: string;
	/** The executor's calls to the core, and what each one answered, in order. */
	readonly core: unknown[];
	/** Each pass: its input, the record the core rendered, and the result. */
	readonly passes: unknown[];
	/** Each thread the client opened, and each prompt it ran, in order. */
	readonly codex: unknown[];
}

/** The directory of the dump, or nothing when the variable is not set. */
export function dumpDirectory(): string | undefined {
	const dir = process.env[DUMP_VAR];
	return dir === undefined || dir === '' ? undefined : dir;
}

/** The activation the executor sees, with each call to the core written to `seen`. */
function watched(activation: ExecutorActivation, seen: Seen): ExecutorActivation {
	return {
		id: activation.id,
		signal: activation.signal,
		get readThrough() {
			return activation.readThrough;
		},
		trace: activation.trace,
		read: (range) => {
			activation.read(range);
			seen.core.push({ read: range, readThrough: activation.readThrough });
		},
		delivered: (call) => {
			activation.delivered(call);
			seen.core.push({ delivered: call, readThrough: activation.readThrough });
		},
		callId: (tool) => {
			const call = activation.callId(tool);
			seen.core.push({ callId: tool, call, readThrough: activation.readThrough });
			return call;
		},
	};
}

/** A pass whose record is written to `entry` when the executor reads it. */
function recorded(pass: Pass, entry: Record<string, unknown>): Pass {
	return {
		...pass,
		record: async (after) => {
			const record = await pass.record(after);
			entry.record = { after, ...record };
			return record;
		},
	};
}

/** The session the executor opened, with each pass written to `seen`. */
function session(inner: ExecutorSession, seen: Seen): ExecutorSession {
	return {
		get session() {
			return inner.session;
		},
		...(inner.roomTools === undefined ? {} : { roomTools: inner.roomTools }),
		pass: async (pass) => {
			const { spec, through } = pass.view;
			const entry: Record<string, unknown> = {
				kind: pass.kind,
				...(pass.kind === 'delta' ? { after: pass.after } : {}),
				spec,
				through,
				resume: pass.resumeId,
				tools: pass.tools.map((tool) => tool.name),
			};
			seen.passes.push(entry);
			const result = await inner.pass(recorded(pass, entry));
			entry.result = { ...result, error: result.error?.message };
			entry.session = inner.session;
			return result;
		},
		close: () => inner.close?.(),
	};
}

/**
 * The dump of one harness. `wrap` watches one executor. `write` writes the
 * file of a case and forgets what the case saw.
 */
export function liveDump(dir: string) {
	mkdirSync(dir, { recursive: true });
	let activations: Seen[] = [];
	/** The Codex client of the activation that opened last. The suite runs one at a time. */
	const client = (options: CodexOptions) => {
		const real = new Codex(options);
		const log = () => activations.at(-1)?.codex;
		const thread = (made: ReturnType<Codex['startThread']>) => ({
			runStreamed: (input: string, turn?: TurnOptions) => {
				log()?.push({ prompt: input });
				return made.runStreamed(input, turn);
			},
		});
		return {
			startThread: (threadOptions?: ThreadOptions) => {
				log()?.push({ startThread: true });
				return thread(real.startThread(threadOptions));
			},
			resumeThread: (id: string, threadOptions?: ThreadOptions) => {
				log()?.push({ resumeThread: id });
				return thread(real.resumeThread(id, threadOptions));
			},
		};
	};
	return {
		/** The options that route the Codex client of `options` through the dump. */
		options: (options: CodexExecutorOptions): CodexExecutorOptions => ({ ...options, client }),
		wrap:
			(executor: Executor): Executor =>
			(activation) => {
				const seen: Seen = { id: activation.id, core: [], passes: [], codex: [] };
				activations.push(seen);
				return session(executor(watched(activation, seen)), seen);
			},
		write: (report: ExecutorCaseReport) => {
			const name = report.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
			const file = join(dir, `${name}.json`);
			const steps = report.records.map((record) => record.step);
			const body = { ...report, records: undefined, steps, activations };
			writeFileSync(file, `${JSON.stringify(body, null, '\t')}\n`);
			activations = [];
		},
	};
}
