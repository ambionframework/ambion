/**
 * `quickjsEvaluator`: the code of a compose call runs in QuickJS, compiled to
 * WebAssembly, in the host process. It uses the synchronous build. Each
 * binding is a host function that returns a promise, and the host settles
 * that promise when the nested call settles, so several nested calls run
 * together. A fresh runtime serves each evaluation, and the evaluation
 * disposes every handle before it frees the runtime.
 */
import type { Evaluator, EvaluatorInput, JsonValue } from '@ambionframework/ambion';
import {
	newQuickJSWASMModule,
	newVariant,
	type QuickJSContext,
	type QuickJSDeferredPromise,
	type QuickJSHandle,
	type QuickJSRuntime,
	type QuickJSSyncVariant,
	type QuickJSWASMModule,
	RELEASE_SYNC,
	Scope,
} from 'quickjs-emscripten';
import { configText, failureOf, valueText } from './crossing.ts';
import { GUEST } from './guest.ts';

/** The limits of one evaluation. A field that is absent keeps its default. */
export interface QuickjsOptions {
	/** The bytes of the QuickJS heap. The default is 64 MiB. */
	readonly memoryLimit?: number;
	/**
	 * The milliseconds that the code runs, summed over every stretch between
	 * two settled calls. The host thread cannot see a signal while code runs,
	 * so this limit ends a loop. The default is 10,000.
	 */
	readonly cpuLimit?: number;
	/**
	 * The QuickJS build. The default is the release build of the synchronous
	 * variant, with a WebAssembly memory that `memoryLimit` bounds. A test
	 * passes the debug build, which reports a leaked handle.
	 */
	readonly variant?: QuickJSSyncVariant;
}

/** The part of the global `WebAssembly` that this file uses. The build has no DOM types. */
declare namespace WebAssembly {
	class Memory {
		constructor(descriptor: { initial: number; maximum: number });
	}
}

const DEFAULT_MEMORY = 64 * 1024 * 1024;
/** The size of a WebAssembly page. */
const PAGE = 65_536;
/** The pages that the QuickJS module needs before its heap grows: 16 MiB. */
const BASE_PAGES = 256;
/** The pages that a variant of the option needs: 128 MiB, for the debug build. */
const DEBUG_BASE_PAGES = 2048;
const DEFAULT_CPU = 10_000;

/** How a nested call ended, as the text that crosses into the code. */
interface Settled {
	readonly ok: boolean;
	readonly text: string;
}

/** The report of the code, as `GUEST` writes it. */
interface Report {
	readonly ok: boolean;
	readonly value?: JsonValue;
	readonly message?: string;
}

const cutError = () => new Error('The evaluator was cut.');

/** One evaluation: a runtime, a context, and the nested calls that the code has in flight. */
class QuickjsRun {
	private readonly context: QuickJSContext;
	private readonly deferreds: QuickJSDeferredPromise[] = [];
	private readonly outcome = Promise.withResolvers<JsonValue | undefined>();
	private readonly listener = () => this.fail(cutError());
	private readonly runtime: QuickJSRuntime;
	private readonly input: EvaluatorInput;
	private readonly signal: AbortSignal;
	private readonly memoryLimit: number;
	private readonly cpuLimit: number;
	private ended = false;
	/** The time that earlier stretches of code took. */
	private used = 0;
	/** When the running stretch began. Absent, no code runs. */
	private since: number | undefined;
	private interruptedBy: 'cut' | 'cpu' | undefined;
	/** The engine stopped a job, so `dispose` frees nothing. */
	private abandoned = false;

	constructor(
		runtime: QuickJSRuntime,
		input: EvaluatorInput,
		signal: AbortSignal,
		limits: { memoryLimit: number; cpuLimit: number },
	) {
		this.runtime = runtime;
		this.input = input;
		this.signal = signal;
		this.memoryLimit = limits.memoryLimit;
		this.cpuLimit = limits.cpuLimit;
		runtime.setMemoryLimit(limits.memoryLimit);
		runtime.setInterruptHandler(() => this.interrupted());
		this.context = runtime.newContext();
		signal.addEventListener('abort', this.listener, { once: true });
	}

	/** Start the code, and wait for its report. */
	result(): Promise<JsonValue | undefined> {
		try {
			this.stretch(() => this.boot());
			this.pump();
		} catch (error) {
			this.engineFailure(error);
		}
		return this.outcome.promise;
	}

	/** Dispose every handle, the context, and the runtime. A late settle then finds nothing to do. */
	dispose(): void {
		this.ended = true;
		this.signal.removeEventListener('abort', this.listener);
		// The engine cannot free a runtime that it stopped in the middle of a job.
		// QuickJS then aborts on the objects that the job left. The module of the
		// evaluation is its own, so the garbage collector reclaims it.
		if (this.abandoned) return;
		try {
			for (const deferred of this.deferreds) deferred.dispose();
			this.context.dispose();
			this.runtime.dispose();
		} catch {
			// QuickJS cannot free a runtime after an out-of-memory error inside a job, even
			// when the code caught that error and returned a value. The free aborts the
			// module. The module belongs to this evaluation, so the outcome stays as it
			// settled, and the garbage collector reclaims the module. Emscripten can
			// print an Aborted line to stderr here.
		}
	}

	/** The interrupt handler. QuickJS asks it while code runs, and an answer of true ends the code. */
	private interrupted(): boolean {
		if (this.since === undefined) return false;
		if (this.signal.aborted) this.interruptedBy = 'cut';
		else if (this.used + (performance.now() - this.since) > this.cpuLimit)
			this.interruptedBy = 'cpu';
		return this.interruptedBy !== undefined;
	}

	/** Run `work`, which enters the code, and count its time against the CPU limit. */
	private stretch<T>(work: () => T): T {
		this.since = performance.now();
		try {
			return work();
		} finally {
			this.used += performance.now() - this.since;
			this.since = undefined;
		}
	}

	/** Run the setup script, and start the code. */
	private boot(): void {
		const context = this.context;
		Scope.withScope((scope) => {
			const call = scope.manage(
				context.newFunction('call', (name, json) =>
					this.start(context.getString(name), context.getString(json)),
				),
			);
			const done = scope.manage(
				context.newFunction('done', (text) => this.report(context.getString(text))),
			);
			const config = scope.manage(context.newString(configText(this.input)));
			const script = scope.manage(context.unwrapResult(context.evalCode(GUEST, 'guest.js')));
			scope.manage(
				context.unwrapResult(context.callFunction(script, context.undefined, call, done, config)),
			);
		});
	}

	/** Start one nested call. The promise that this returns settles when the call does. */
	private start(name: string, json: string): QuickJSHandle {
		const deferred = this.context.newPromise();
		this.deferreds.push(deferred);
		void this.invoke(name, json).then((settled) => this.settle(deferred, settled));
		return deferred.handle;
	}

	private async invoke(name: string, json: string): Promise<Settled> {
		try {
			const value = await this.input.call(name, JSON.parse(json) as JsonValue);
			return { ok: true, text: valueText(value) };
		} catch (failure) {
			return { ok: false, text: JSON.stringify(failureOf(failure)) };
		}
	}

	/** Settle the promise of a nested call, and run the code that waits for it. */
	private settle(deferred: QuickJSDeferredPromise, settled: Settled): void {
		if (this.ended) return;
		const text = this.context.newString(settled.text);
		if (settled.ok) deferred.resolve(text);
		else deferred.reject(text);
		text.dispose();
		try {
			this.pump();
		} catch (error) {
			this.engineFailure(error);
		}
	}

	/** Run the jobs that a settled promise queued. */
	private pump(): void {
		if (this.ended) return;
		const jobs = this.stretch(() => this.runtime.executePendingJobs());
		if (jobs.error === undefined) return;
		const error = this.context.dump(jobs.error);
		jobs.error.dispose();
		this.engineFailure(error);
	}

	/** The report of the code: the value that it returned, or the error that it threw. */
	private report(text: string): void {
		let report: Report;
		try {
			report = JSON.parse(text) as Report;
		} catch {
			this.fail(new Error('The code made a report that is not JSON.'));
			return;
		}
		if (report.ok) this.end(() => this.outcome.resolve(report.value));
		else this.fail(this.explain(new Error(report.message)));
	}

	/** A failure that the engine raised, outside the report of the code. */
	private engineFailure(error: unknown): void {
		// A job that the engine stopped, by a limit or a cut, leaves objects that no handle names.
		this.abandoned = true;
		this.fail(this.explain(error));
	}

	private fail(error: Error): void {
		this.end(() => this.outcome.reject(error));
	}

	private end(settle: () => void): void {
		if (this.ended) return;
		this.ended = true;
		settle();
	}

	/** The error of a stop, named by its cause: the cut, a limit, or the code. */
	private explain(error: unknown): Error {
		if (this.interruptedBy !== undefined) this.abandoned = true;
		if (this.interruptedBy === 'cut') return cutError();
		if (this.interruptedBy === 'cpu')
			return new Error(`The code passed the CPU limit of ${this.cpuLimit} ms.`);
		const message = error instanceof Error ? error.message : String((error as Error).message);
		// An Error('out of memory') that the code throws also abandons the module. That is harmless.
		if (message === 'out of memory') {
			this.abandoned = true;
			return new Error(`The code passed the memory limit of ${this.memoryLimit} bytes.`);
		}
		return new Error(message);
	}
}

/**
 * A module of its own, whose WebAssembly memory cannot grow past the limit.
 * `setMemoryLimit` counts the QuickJS heap, and a loop that allocates large
 * blocks passes it, so the memory of the module is the bound that holds. A
 * failed growth is an `out of memory` error in the code. The runtime of an
 * evaluation then shares nothing with another evaluation.
 */
function boundedModule(
	variant: QuickJSSyncVariant | undefined,
	memoryLimit: number,
): Promise<QuickJSWASMModule> {
	// The debug build needs more room than the release build before its heap grows.
	const initial = variant === undefined ? BASE_PAGES : DEBUG_BASE_PAGES;
	const maximum = initial + Math.ceil(memoryLimit / PAGE);
	const wasmMemory = new WebAssembly.Memory({ initial, maximum });
	return newQuickJSWASMModule(newVariant(variant ?? RELEASE_SYNC, { wasmMemory }));
}

/**
 * An evaluator that runs the code in QuickJS, in the process of the host.
 * Each evaluation has a fresh runtime, so no state outlives a compose call.
 * The code reaches no module, file, network, process, or timer, and a
 * memory limit and a CPU limit bound it. It shares the process of the host,
 * so it is no defense against hostile code.
 */
export function quickjsEvaluator(options: QuickjsOptions = {}): Evaluator {
	const limits = {
		memoryLimit: options.memoryLimit ?? DEFAULT_MEMORY,
		cpuLimit: options.cpuLimit ?? DEFAULT_CPU,
	};
	return {
		async evaluate(input, signal) {
			if (signal.aborted) throw cutError();
			const module = await boundedModule(options.variant, limits.memoryLimit);
			// The load of the module can outlast a cut.
			if (signal.aborted) throw cutError();
			const run = new QuickjsRun(module.newRuntime(), input, signal, limits);
			try {
				return await run.result();
			} finally {
				run.dispose();
			}
		},
	};
}
