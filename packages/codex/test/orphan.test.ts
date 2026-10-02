/**
 * A host that dies must leave no `codex app-server` behind. The server reads
 * its requests from standard input and exits when the input ends, and the
 * end of a dead host closes the pipe. The test kills a real host with
 * SIGKILL in the middle of a turn, and proves that Codex goes away and stops
 * its request to the model.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { codexOn, hasBinary, holding, kill, MODEL, runningWith, seesProcesses } from './binary.ts';
import type { OnRequest, Reply } from './responses.ts';

/**
 * How long Codex may take to go away after the host dies. A server that did
 * not stop on the end of its input keeps the request open for ever, so any
 * bound tells the two apart.
 */
const GONE_MS = 30_000;

const TEST_MS = 120_000;

const host = fileURLToPath(new URL('./orphan-host.ts', import.meta.url));

const say: Reply = { call: 'say', args: { text: 'hello room' } };

/** Resolve when the child exits. */
const exited = (child: ChildProcess) =>
	new Promise<void>((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) resolve();
		else child.once('exit', () => resolve());
	});

/** Reject after `GONE_MS`, so that a Codex that stays alive fails the test and does not hang it. */
async function within<T>(wait: Promise<T>, what: string): Promise<T> {
	const late = Promise.withResolvers<never>();
	const timer = setTimeout(() => late.reject(new Error(what)), GONE_MS);
	return Promise.race([wait, late.promise]).finally(() => clearTimeout(timer));
}

/**
 * Start a host in its own process on a scripted binary. A failed test leaves no process:
 * the cleanup kills the host and every process of the run, and then closes the endpoint.
 */
async function startHost(script: readonly Reply[], onRequest?: OnRequest) {
	const on = await codexOn(script, onRequest);
	const child = spawn(
		process.execPath,
		[
			'--no-warnings',
			host,
			JSON.stringify({
				env: on.env,
				home: on.home,
				model: MODEL,
			}),
		],
		{ stdio: ['ignore', 'ignore', 'inherit'] },
	);
	onTestFinished(async () => {
		child.kill('SIGKILL');
		if (seesProcesses) for (const pid of runningWith(on.home)) kill(pid);
		await exited(child);
		await on.close();
	});
	return {
		on,
		/** The host dies with no chance to stop the room. */
		async die() {
			child.kill('SIGKILL');
			await exited(child);
		},
	};
}

describe.skipIf(!hasBinary && process.env.CI === undefined)('a host that dies', () => {
	it(
		'takes its codex process with it, and the request that is open closes',
		async () => {
			// The first model request stays open. The reply never comes.
			const held = holding(0);
			const { on, die } = await startHost([say, { text: 'done' }], held.onRequest);

			await held.open;
			if (seesProcesses) expect(runningWith(on.home).length).toBeGreaterThan(0);
			await die();

			// The connection of the open request closes, and no other request follows.
			await within(held.closed, 'codex kept its request open');
			expect(on.responses.requests).toHaveLength(1);
			// The app-server does not remain.
			if (seesProcesses) {
				await vi.waitFor(() => expect(runningWith(on.home)).toEqual([]), {
					timeout: GONE_MS,
				});
			}
		},
		TEST_MS,
	);
});
