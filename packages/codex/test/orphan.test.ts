/**
 * A host that dies leaves the real `codex exec` running. The SDK closes the
 * input of `codex exec` at once, so the process would run its turn to the end
 * and keep calling the model. The room tools server sees the host socket
 * close and stops its parent. Each test kills a real host with SIGKILL in
 * the middle of a turn, and proves that Codex goes away.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { codexOn, hasBinary, MODEL } from './binary.ts';
import type { OnRequest, Reply } from './responses.ts';

/**
 * How long Codex may take to go away after the host dies. On a loaded CI
 * runner, the room tools server can still be starting when the host dies,
 * and it signals Codex only once it fails to connect. Without the fix,
 * Codex keeps the request open for ever, so any bound tells the two apart.
 */
const GONE_MS = 30_000;

const TEST_MS = 120_000;

const host = fileURLToPath(new URL('./orphan-host.ts', import.meta.url));

const say: Reply = { call: 'say', namespace: 'mcp__ambion', args: { text: 'hello room' } };

/** The processes that run with `home` as their `HOME`: the binary and the servers it spawned. */
function runningWith(home: string): number[] {
	return readdirSync('/proc')
		.filter((name) => /^\d+$/.test(name))
		.filter((pid) => {
			try {
				return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`HOME=${home}`);
			} catch {
				return false;
			}
		})
		.map(Number);
}

function kill(pid: number): void {
	try {
		process.kill(pid, 'SIGKILL');
	} catch {
		// The process is gone already.
	}
}

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

/** An endpoint hook that holds the request `index` open until the client goes away. */
function holding(index: number) {
	const open = Promise.withResolvers<void>();
	const closed = Promise.withResolvers<void>();
	const onRequest: OnRequest = async (at, response) => {
		if (at !== index) return;
		response.on('close', () => closed.resolve());
		open.resolve();
		await closed.promise;
	};
	return { onRequest, open: open.promise, closed: closed.promise };
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
		if (process.platform === 'linux') for (const pid of runningWith(on.hostHome)) kill(pid);
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

// The check of the processes reads /proc, so it runs on Linux only.
const onLinux = process.platform === 'linux';

describe.skipIf(!hasBinary && process.env.CI === undefined)('a host that dies', () => {
	it(
		'takes its codex process with it, and the request that is open closes',
		async () => {
			// The first model request stays open. The reply never comes.
			const held = holding(0);
			const { on, die } = await startHost([say, { text: 'done' }], held.onRequest);

			await held.open;
			if (onLinux) expect(runningWith(on.hostHome).length).toBeGreaterThan(0);
			await die();

			// The connection of the open request closes, and no other request follows.
			await within(held.closed, 'codex kept its request open');
			expect(on.responses.requests).toHaveLength(1);
			// Neither `codex exec` nor the room tools server remains.
			if (onLinux) {
				await vi.waitFor(() => expect(runningWith(on.hostHome)).toEqual([]), {
					timeout: GONE_MS,
				});
			}
		},
		TEST_MS,
	);
});
