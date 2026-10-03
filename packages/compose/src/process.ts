/**
 * `processRuntime`: the code of a compose call runs in a `node:vm` context
 * in a child Node process. The child runs under `--permission` with no allow
 * flag: no file, network, child process, worker, or addon. `--max-old-space-size`
 * bounds the old space of its heap. An ArrayBuffer lives outside that bound.
 * The host kills it at the signal and at the end of the
 * evaluation. The two sides speak JSON lines over stdio (`child.ts`).
 */
import {
	type ChildProcessWithoutNullStreams,
	type SpawnOptionsWithoutStdio,
	spawn,
} from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createInterface, type Interface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { ComposeRuntime, ComposeRuntimeInput, JsonValue } from '@ambionframework/ambion';
import { configText, failureOf } from './crossing.ts';

/** Starts the child process. The default is `spawn` of `node:child_process`. */
export type SpawnChild = (
	command: string,
	args: string[],
	options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

/** The limits of one evaluation. A field that is absent keeps its default. */
export interface ProcessOptions {
	/** The bytes of the old space of the child heap. The default is 64 MiB. */
	readonly memoryLimit?: number;
	/** Starts the child. A test passes a function that records the child. */
	readonly spawn?: SpawnChild;
}

const DEFAULT_MEMORY = 64 * 1024 * 1024;
const STDERR_TAIL = 2_000;

/** The text that V8 prints to stderr when the heap reaches its limit. */
const OUT_OF_MEMORY = 'heap out of memory';

/** The report of the code, as `child.ts` sends it. */
interface Report {
	readonly ok: boolean;
	readonly value?: JsonValue;
	readonly message?: string;
}

/** One line from the child. */
type Line =
	| { readonly type: 'call'; readonly id: number; readonly name: string; readonly args: JsonValue }
	| { readonly type: 'done'; readonly report: Report };

const cutError = () => new Error('The runtime was cut.');

/** The children that run now. The host kills them when it exits. */
const alive = new Set<ChildProcessWithoutNullStreams>();
let watching = false;

function watchExit(): void {
	if (watching) return;
	watching = true;
	process.once('exit', () => {
		for (const child of alive) child.kill('SIGKILL');
	});
}

/**
 * Start the child on `entry`: Node with the permission model and no allow
 * flag, an empty environment, and a bound on the old space of its heap.
 * Node lets the child read its entry. It resolves the entry through each
 * folder of the path, so a symbolic link in the path needs a read that the
 * child does not have. On macOS, `/var` is such a link. The child starts on
 * the resolved path.
 */
export function startChild(
	entry: string,
	memoryLimit: number,
	start: SpawnChild = spawn,
): ChildProcessWithoutNullStreams {
	const megabytes = Math.ceil(memoryLimit / (1024 * 1024));
	const args = ['--permission', `--max-old-space-size=${megabytes}`, realpathSync(entry)];
	const child = start(process.execPath, args, { env: {}, windowsHide: true });
	alive.add(child);
	watchExit();
	return child;
}

/** The child entry. The library, built, sits beside it. A test reads the built entry. */
const ENTRY = new URL(
	import.meta.url.endsWith('.ts') ? '../dist/child.mjs' : './child.mjs',
	import.meta.url,
);

/** One evaluation: a child process, and the nested calls that it has in flight. */
class ProcessRun {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly lines: Interface;
	private readonly outcome = Promise.withResolvers<JsonValue | undefined>();
	private readonly listener = () => this.fail(cutError());
	private readonly input: ComposeRuntimeInput;
	private readonly signal: AbortSignal;
	private readonly memoryLimit: number;
	private ended = false;
	private tail = '';

	constructor(input: ComposeRuntimeInput, signal: AbortSignal, options: Required<ProcessOptions>) {
		this.input = input;
		this.signal = signal;
		this.memoryLimit = options.memoryLimit;
		this.child = startChild(fileURLToPath(ENTRY), options.memoryLimit, options.spawn);
		this.lines = createInterface({ input: this.child.stdout });
		this.lines.on('line', (text) => this.receive(text));
		this.child.stdin.on('error', () => {});
		this.child.stderr.setEncoding('utf8');
		this.child.stderr.on('data', (chunk: string) => {
			this.tail = (this.tail + chunk).slice(-STDERR_TAIL);
			// V8 prints this line before it aborts. The abort can write a core dump
			// for seconds, so the evaluation fails at the line.
			if (this.tail.includes(OUT_OF_MEMORY)) this.fail(this.memoryError());
		});
		this.child.on('error', (error) => this.fail(error));
		this.child.on('close', (code, by) => this.fail(this.closed(code, by)));
		signal.addEventListener('abort', this.listener, { once: true });
	}

	/** Send the code to the child, and wait for its report. */
	result(): Promise<JsonValue | undefined> {
		this.send({ type: 'run', config: configText(this.input) });
		return this.outcome.promise;
	}

	/** Kill the child. A late line or a late settle then finds nothing to do. */
	dispose(): void {
		this.ended = true;
		this.signal.removeEventListener('abort', this.listener);
		this.lines.close();
		this.child.kill('SIGKILL');
		alive.delete(this.child);
	}

	private send(message: object): void {
		if (!this.ended && this.child.stdin.writable)
			this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private receive(text: string): void {
		try {
			const line = JSON.parse(text) as Line;
			if (line.type === 'call') this.call(line);
			else if (line.type === 'done') this.report(line.report);
			else throw new Error('The child sent a line of an unknown type.');
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
		}
	}

	/** Run one nested call, and send its result to the child. */
	private call(line: Extract<Line, { type: 'call' }>): void {
		const { id } = line;
		void this.input.call(line.name, line.args).then(
			(value) => this.send({ type: 'result', id, ok: true, value }),
			(failure: unknown) =>
				this.send({ type: 'result', id, ok: false, failure: failureOf(failure) }),
		);
	}

	private report(report: Report): void {
		if (report.ok) this.end(() => this.outcome.resolve(report.value));
		else this.fail(new Error(report.message));
	}

	private fail(error: Error): void {
		this.end(() => this.outcome.reject(error));
	}

	private end(settle: () => void): void {
		if (this.ended) return;
		this.ended = true;
		settle();
	}

	private memoryError(): Error {
		return new Error(`The code passed the memory limit of ${this.memoryLimit} bytes.`);
	}

	/**
	 * The error of a child that ends before the code returns. V8 aborts the
	 * child when the heap reaches its limit. Under load the abort can come
	 * before V8 prints its line, so SIGABRT alone also names the limit.
	 */
	private closed(code: number | null, by: NodeJS.Signals | null): Error {
		if (this.tail.includes(OUT_OF_MEMORY) || by === 'SIGABRT') return this.memoryError();
		const how = by === null ? `exit code ${code}` : `signal ${by}`;
		return new Error(`The runtime process ended before the code returned (${how}).`, {
			cause: this.tail,
		});
	}
}

/**
 * A runtime that runs the code in a child Node process, under the
 * permission model of Node with no allow flag. It needs a Node that has
 * `--allow-net`, so it refuses to start on Node 22.
 */
export function processRuntime(options: ProcessOptions = {}): ComposeRuntime {
	if (!process.allowedNodeEnvironmentFlags.has('--allow-net')) {
		throw new Error(
			`processRuntime needs the permission flag --allow-net, which Node ${process.version} lacks. Use quickjsRuntime, or run Node 26 or newer.`,
		);
	}
	const settings = {
		memoryLimit: options.memoryLimit ?? DEFAULT_MEMORY,
		spawn: options.spawn ?? spawn,
	};
	return {
		async evaluate(input, signal) {
			if (signal.aborted) throw cutError();
			const run = new ProcessRun(input, signal, settings);
			try {
				return await run.result();
			} finally {
				run.dispose();
			}
		},
	};
}
