import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeRuntimeConformance } from '@ambionframework/ambion/conformance';
import { describe, expect, it, vi } from 'vitest';
import { startChild } from '../src/process.ts';
import { processRuntime } from '../src/runtime.ts';

/** Node 22 has no `--allow-net`, so `processRuntime` refuses it. */
const permitted = process.allowedNodeEnvironmentFlags.has('--allow-net');

const limits = { memoryLimit: 64 * 1024 * 1024 };
const input = (code: string) => ({ code, bindings: [], call: async () => null });

describe('processRuntime', () => {
	it.runIf(!permitted)('refuses a Node that lacks --allow-net, at construction', () => {
		expect(() => processRuntime()).toThrow('--allow-net');
	});

	it('refuses a Node whose flags lack --allow-net, at construction', () => {
		const flags = vi
			.spyOn(process, 'allowedNodeEnvironmentFlags', 'get')
			.mockReturnValue(new Set(['--permission']));
		try {
			expect(() => processRuntime()).toThrow(
				/needs the permission flag --allow-net.*quickjsRuntime/,
			);
		} finally {
			flags.mockRestore();
		}
	});
});

describe.runIf(permitted)('processRuntime on a Node with --allow-net', () => {
	for (const c of composeRuntimeConformance(() => processRuntime(limits))) it(c.name, c.run);

	it('kills the child at the signal, and at the end of the code', async () => {
		const children: ChildProcessWithoutNullStreams[] = [];
		const runtime = processRuntime({
			spawn: (command, args, options) => {
				const child = spawn(command, args, options);
				children.push(child);
				return child;
			},
		});
		const cut = new AbortController();
		const busy = runtime.evaluate(input('for (;;) {}'), cut.signal);
		const refused = expect(busy).rejects.toThrow('The runtime was cut.');
		await vi.waitFor(() => expect(children).toHaveLength(1));
		cut.abort();
		await refused;
		const [cutChild] = children;
		expect(cutChild?.pid).toBeTypeOf('number');
		if (cutChild?.exitCode === null && cutChild.signalCode === null) await once(cutChild, 'exit');
		expect(cutChild?.signalCode).toBe('SIGKILL');
		await runtime.evaluate(input('return 1;'), new AbortController().signal);
		const [, doneChild] = children;
		if (doneChild?.exitCode === null && doneChild.signalCode === null)
			await once(doneChild, 'exit');
		expect(doneChild?.signalCode).toBe('SIGKILL');
	});

	it('names the memory limit when the child runs out of memory', async () => {
		const runtime = processRuntime({ memoryLimit: 32 * 1024 * 1024 });
		await expect(
			runtime.evaluate(
				input('const a = []; for (;;) a.push(new Array(1e4).fill(1));'),
				new AbortController().signal,
			),
		).rejects.toThrow('memory limit of 33554432 bytes');
	});
});

/** What a child that Node starts under `--permission`, with no allow flag, cannot do. */
const DENIED = [
	['import a file beside it', "await import('./other.mjs');"],
	['read a file', "(await import('node:fs')).readFileSync('/etc/hostname');"],
	['open a socket', "(await import('node:net')).connect(80, '127.0.0.1');"],
	['start a process', "(await import('node:child_process')).spawnSync('true');"],
	['start a worker', "new (await import('node:worker_threads')).Worker('0', { eval: true });"],
] as const;

describe.runIf(permitted)('the permissions of the child', () => {
	it.each(DENIED)('refuses to %s', async (_what, body) => {
		const folder = await mkdtemp(join(tmpdir(), 'ambion-child-'));
		try {
			await writeFile(join(folder, 'other.mjs'), 'export default 1;\n');
			const entry = join(folder, 'entry.mjs');
			await writeFile(
				entry,
				`process.on('uncaughtException', (e) => console.log(e.code));\ntry { ${body} } catch (e) { console.log(e.code); }\n`,
			);
			const child = startChild(entry, limits.memoryLimit);
			let output = '';
			child.stdout.on('data', (chunk) => {
				output += String(chunk);
			});
			await once(child, 'close');
			expect(output.trim()).toBe('ERR_ACCESS_DENIED');
		} finally {
			await rm(folder, { recursive: true, force: true });
		}
	});

	it('starts the built entry under the permission model, and ends it when its input closes', async () => {
		const entry = fileURLToPath(new URL('../dist/child.mjs', import.meta.url));
		const child = startChild(entry, limits.memoryLimit);
		child.stdin.end();
		const [code] = (await once(child, 'close')) as [number | null];
		expect(code).toBe(0);
	});
});
