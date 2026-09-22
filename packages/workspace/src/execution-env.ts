/**
 * The rules every `ExecutionEnv` backend needs, independent of the
 * filesystem behind it.
 *
 * Four rules live here: `resolvePath`, the `~` and relative path rule that
 * every backend resolves a path with; `Deadline`, which tells an abort
 * apart from a timeout; `boundedView`, the bounded output view that a shell
 * command's caller reads before `exec` resolves; and the temporary names
 * and paths under `/tmp` that a spill file, a temp file, and a temp
 * directory share.
 *
 * `spill` takes a `MinimalWriter`, one `mkdir` plus one `writeFile`, so a
 * backend supplies its own filesystem here without this module reaching
 * into a specific one. This module imports no `just-bash`.
 */

import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import type { ShellOutputLimits, ShellOutputView } from '@earendil-works/pi-agent-core';
import { ExecutionError, truncateHead, truncateTail } from '@earendil-works/pi-agent-core';

/** The directory every backend's temporary names and paths sit under. */
export const TMP = '/tmp';

/** A short random component that keeps two temporary names apart. */
export function randomName(): string {
	return randomBytes(6).toString('hex');
}

/** `~` and `~/` are the agent's home, and a relative path is under `cwd`. */
export function resolvePath(home: string, cwd: string, path: string): string {
	if (path === '~') return home;
	const expanded = path.startsWith('~/') ? posix.join(home, path.slice(2)) : path;
	return posix.resolve(cwd, expanded);
}

/** A path for a new temporary directory. Neither filesystem starts with `/tmp`. */
export function tempDirPath(prefix: string | undefined): string {
	return posix.join(TMP, `${prefix ?? 'tmp-'}${randomName()}`);
}

/** A path for a new temporary file. */
export function tempFilePath(options: { prefix?: string; suffix?: string } | undefined): string {
	return posix.join(TMP, `${options?.prefix ?? ''}${randomName()}${options?.suffix ?? ''}`);
}

/** A path for a new spill file, the whole output a bounded view cut. */
export function spillPath(): string {
	return posix.join(TMP, `shell-${randomName()}.out`);
}

/** The filesystem `spill` needs: one call to create `/tmp`, one to write the file. */
export interface MinimalWriter {
	mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
	writeFile(path: string, content: string): Promise<unknown>;
}

/** Keep the whole output in a file so a reader can reach what a bounded view cut. */
export async function spill(writer: MinimalWriter, content: string): Promise<string | undefined> {
	const path = spillPath();
	try {
		await writer.mkdir(TMP, { recursive: true });
		await writer.writeFile(path, content);
		return path;
	} catch {
		return undefined; // Spill is best-effort; a failed write leaves the view alone.
	}
}

/**
 * Bound the combined command output to the caller's limits, tail by default.
 * Absent limits leave the output whole: the caller named no bound.
 */
export function boundedView(
	output: string,
	limits: ShellOutputLimits | undefined,
): ShellOutputView {
	const options = {
		maxLines: limits?.maxLines ?? Number.POSITIVE_INFINITY,
		maxBytes: limits?.maxBytes ?? Number.POSITIVE_INFINITY,
	};
	const result =
		limits?.retain === 'head' ? truncateHead(output, options) : truncateTail(output, options);
	const { content, ...truncation } = result;
	return { text: content, truncation };
}

/**
 * One signal for a command, fired by the caller's abort or by a per-call
 * timeout, and which of the two it was. A backend that reports the same
 * exit code for both still tells them apart here.
 */
export class Deadline {
	private readonly controller = new AbortController();
	private readonly timer: NodeJS.Timeout | undefined;
	private timedOut = false;
	private readonly abort = () => this.controller.abort();

	constructor(
		private readonly caller: AbortSignal | undefined,
		private readonly timeout: number | undefined,
	) {
		caller?.addEventListener('abort', this.abort, { once: true });
		if (caller?.aborted) this.abort();
		if (timeout !== undefined) {
			this.timer = setTimeout(() => {
				this.timedOut = true;
				this.abort();
			}, timeout * 1000);
		}
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	/** Why the command stopped early, or undefined when it ran to its end. */
	error(): ExecutionError | undefined {
		if (this.caller?.aborted) return new ExecutionError('aborted', 'Command aborted');
		if (this.timedOut) {
			return new ExecutionError('timeout', `Command timed out after ${this.timeout} seconds`);
		}
		return undefined;
	}

	clear(): void {
		clearTimeout(this.timer);
		this.caller?.removeEventListener('abort', this.abort);
	}
}
