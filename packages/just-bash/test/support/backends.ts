/**
 * The two just-bash backends as conformance harnesses, and a helper that runs
 * one command. `memory` holds the files for as long as the handle lives, and
 * `directory` writes them through to a temporary directory and removes it
 * after.
 *
 * The workspace package's tests reach this file by relative path, the way the
 * core's tests reach the Pi source. Its `vitest.config.ts` sends the
 * `@ambionframework/workspace` specifiers to the workspace source, so a test
 * there reads one workspace module.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConformanceBackend } from '@ambionframework/workspace/conformance';
import { BACKGROUND_CONTEXT, type ExecutionEnv } from '@earendil-works/pi-agent-core';
import { directoryBackend, memoryBackend } from '../../src/index.ts';

/** A temporary directory, and a function that removes it. */
export async function tempDir(prefix: string) {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	return { dir, dispose: () => rm(dir, { recursive: true, force: true }) };
}

export const backends: readonly ConformanceBackend[] = [
	{
		name: 'memory',
		async open() {
			return { backend: memoryBackend(), dispose: async () => {} };
		},
	},
	{
		name: 'directory',
		async open() {
			const { dir, dispose } = await tempDir('ambion-drive-');
			return { backend: directoryBackend(dir), dispose };
		},
	},
];

/** Run one command and return its exit code or error code, and its combined output. */
export async function sh(
	env: ExecutionEnv,
	command: string,
	options: { cwd?: string; timeout?: number } = {},
): Promise<{ ok: boolean; exitCode?: number; code?: string; output: string }> {
	let output = '';
	const result = await env.exec(
		command,
		{
			...options,
			capture: { limits: { maxBytes: 1_000_000, maxLines: 100_000 } },
			onUpdate: (update) => {
				if (update.kind === 'replace') output = update.output.text;
			},
		},
		BACKGROUND_CONTEXT,
	);
	return result.ok
		? { ok: true, exitCode: result.value.exitCode, output }
		: { ok: false, code: result.error.code, output };
}
