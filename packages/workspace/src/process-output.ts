/**
 * The output of a process as a handle tool gives it: the part after the
 * cursor, bounded to Pi's default view of 2000 lines or 50 KB.
 *
 * The `cursor` file of a process holds the byte offset up to which the
 * results of its owner agent already showed the output. Each read gives the
 * output after that offset, and moves the cursor to the end it read. The
 * whole output stays in `out`, and `read` reaches any part of it. The files
 * hold the cursor, so a new run of the host reads on from the same offset.
 */

import {
	applyShellOutputUpdate,
	BACKGROUND_CONTEXT,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ShellOutputTruncation,
	type ShellOutputView,
	truncateTail,
} from '@earendil-works/pi-agent-core';
import type { WorkspaceEnv } from './backend.ts';
import { quoted } from './process-files.ts';

/** The most bytes one read takes from the file. Pi's view then keeps at most 50 KB of them. */
const READ_BYTES = 4 * DEFAULT_MAX_BYTES;

/** What one read of the output gives. */
export interface OutputRead {
	/** The new output, bounded to Pi's default view. */
	readonly text: string;
	readonly truncation: ShellOutputTruncation;
	/** The byte offset where the read started: the cursor before the read. */
	readonly from: number;
	/** The byte offset where the read ended: the size of the file when the read began. */
	readonly to: number;
}

/**
 * Read the output of the process in `dir` after its cursor, and move the
 * cursor to the end of what it read. A cursor past the end of the file, or
 * one that does not parse, reads from the start.
 */
export async function readOutput(env: WorkspaceEnv, dir: string): Promise<OutputRead> {
	const path = `${dir}/out`;
	const info = await env.fileInfo(path, BACKGROUND_CONTEXT);
	const size = info.ok ? info.value.size : 0;
	const cursor = await readCursor(env, dir);
	const from = cursor > size ? 0 : cursor;
	const count = Math.min(size - from, READ_BYTES);
	const raw = count > 0 ? await bytesOf(env, path, size, count) : '';
	const { content, ...truncation } = truncateTail(raw, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	await writeCursor(env, dir, size);
	return {
		text: content,
		truncation: {
			...truncation,
			truncated: truncation.truncated || size - from > READ_BYTES,
			totalBytes: Math.max(truncation.totalBytes, size - from),
		},
		from,
		to: size,
	};
}

/** The byte offset in `cursor`, or 0 when the file is absent or does not parse. */
async function readCursor(env: WorkspaceEnv, dir: string): Promise<number> {
	const read = await env.readTextFile(`${dir}/cursor`, BACKGROUND_CONTEXT);
	if (!read.ok) return 0;
	const offset = Number.parseInt(read.value, 10);
	return Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
}

/** Write the cursor. Best-effort: a failed write makes the next read give the same bytes again. */
async function writeCursor(env: WorkspaceEnv, dir: string, offset: number): Promise<void> {
	await env.writeFile(`${dir}/cursor`, `${offset}\n`, BACKGROUND_CONTEXT).catch(() => undefined);
}

/**
 * The last `count` bytes of the first `size` bytes of the file. `head`
 * fixes the end at the size the read saw, so output that the process
 * writes during the read waits for the next read. just-bash's `tail`
 * refuses `--` and reads `-c +N` as `-c N`, so the command uses neither.
 * The path is absolute, so it cannot read as an option.
 */
async function bytesOf(
	env: WorkspaceEnv,
	path: string,
	size: number,
	count: number,
): Promise<string> {
	let view: ShellOutputView | undefined;
	await env.exec(
		`head -c ${size} ${quoted(path)} | tail -c ${count}`,
		{
			capture: {
				limits: { maxBytes: READ_BYTES, maxLines: Number.MAX_SAFE_INTEGER, retain: 'tail' },
			},
			onUpdate: (update) => {
				view = applyShellOutputUpdate(view, update);
			},
		},
		BACKGROUND_CONTEXT,
	);
	return view?.text ?? '';
}
