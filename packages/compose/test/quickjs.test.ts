import { composeRuntimeConformance } from '@ambionframework/ambion/conformance';
import { DEBUG_SYNC, RELEASE_SYNC } from 'quickjs-emscripten';
import { describe, expect, it, vi } from 'vitest';
import { quickjsRuntime } from '../src/runtime.ts';

const limits = { memoryLimit: 16 * 1024 * 1024, cpuLimit: 500 };

describe('quickjsRuntime', () => {
	for (const c of composeRuntimeConformance(() => quickjsRuntime(limits))) it(c.name, c.run);
});

describe('quickjsRuntime on the debug build', () => {
	/**
	 * The debug build prints each leaked handle when it frees a runtime, and aborts on a leaked
	 * object. The test runs 38 cases, and each case takes about 0.7 s on an idle core. The busy
	 * loop takes 5 s, because a cut cannot reach code that blocks the thread. A busy CI runner
	 * slows every case by the same ratio, so the limit is ten times the idle time.
	 */
	it('frees a clean runtime after a return, an error, a cut, and a limit', async () => {
		const printed: string[] = [];
		const log = vi
			.spyOn(console, 'log')
			.mockImplementation((text) => void printed.push(String(text)));
		const warn = vi
			.spyOn(console, 'error')
			.mockImplementation((text) => void printed.push(String(text)));
		try {
			// The runtime of the case that catches an out-of-memory error cannot be freed, by design.
			const cases = composeRuntimeConformance(() =>
				// The debug build is slow, so its CPU limit is longer than the limit of the release build.
				quickjsRuntime({ ...limits, cpuLimit: 5000, variant: DEBUG_SYNC }),
			);
			for (const c of cases.filter((one) => !one.name.includes('catches an out-of-memory')))
				await c.run();
		} finally {
			log.mockRestore();
			warn.mockRestore();
		}
		expect(printed.filter((text) => /leak/i.test(text))).toEqual([]);
	}, 300_000);
});

describe('the limits of quickjsRuntime', () => {
	it('returns the value of code that catches an out-of-memory error, and serves the next evaluation', async () => {
		const runtime = quickjsRuntime({ memoryLimit: 4 * 1024 * 1024 });
		const call = async () => null;
		const code = `await tools.keep({}); try { const a = []; for (;;) a.push(new Array(1e4).fill(1)); } catch (e) { return 'caught ' + e.message; }`;
		const value = await runtime.evaluate(
			{ code, bindings: ['keep'], call },
			new AbortController().signal,
		);
		expect(value).toBe('caught out of memory');
		const next = await runtime.evaluate(
			{ code: 'return 1;', bindings: [], call },
			new AbortController().signal,
		);
		expect(next).toBe(1);
	});

	it('names the memory limit and the CPU limit in the error', async () => {
		const runtime = quickjsRuntime({ memoryLimit: 4 * 1024 * 1024, cpuLimit: 200 });
		const input = { bindings: [], call: async () => null };
		const signal = new AbortController().signal;
		await expect(
			runtime.evaluate(
				{ ...input, code: 'const a = []; for (;;) a.push(new Array(1e4).fill(1));' },
				signal,
			),
		).rejects.toThrow('memory limit of 4194304 bytes');
		await expect(runtime.evaluate({ ...input, code: 'for (;;) {}' }, signal)).rejects.toThrow(
			'CPU limit of 200 ms',
		);
	});

	it('counts only the time of the code, not the wait for a call', async () => {
		const runtime = quickjsRuntime({ cpuLimit: 150 });
		const call = () => new Promise<null>((resolve) => setTimeout(() => resolve(null), 400));
		const value = await runtime.evaluate(
			{ code: 'await tools.wait({}); return 1;', bindings: ['wait'], call },
			new AbortController().signal,
		);
		expect(value).toBe(1);
	});
});

describe('a runtime that cannot load the WebAssembly', () => {
	it('fails the evaluation with an error that names the module and the way out', async () => {
		const variant = {
			...RELEASE_SYNC,
			importModuleLoader: () => Promise.reject(new Error('Wasm code generation disallowed')),
		};
		const runtime = quickjsRuntime({ variant });
		const failed = runtime.evaluate(
			{ code: 'return 1;', bindings: [], call: async () => null },
			new AbortController().signal,
		);
		await expect(failed).rejects.toThrow(
			'QuickJS could not load its WebAssembly in this runtime (Wasm code generation disallowed). Pass compose: { runtime } with a runtime that this runtime can run.',
		);
	});
});
