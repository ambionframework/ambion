/**
 * The backends and helpers the tests in this package share. `backends` are
 * the two bash backends every scenario runs on: `memory` holds the files for
 * as long as the handle lives, and `directory` writes them through to a
 * temporary directory and disposes of it after. `sqlBackends` are the two
 * SQLite harnesses. Each one is the harness type its conformance suite takes.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AmbionTool, ToolContext } from '@ambionframework/ambion';
import { BACKGROUND_CONTEXT, type ExecutionEnv } from '@earendil-works/pi-agent-core';
import { DEFAULT_AUDIT_LOG } from '../../src/audit.ts';
import type { BashBackend } from '../../src/backend.ts';
import type { ConformanceBackend, SqlConformanceBackend } from '../../src/conformance.ts';
import type { Workspace } from '../../src/index.ts';
import { directoryBackend, type MemoryBashBackend, memoryBackend } from '../../src/just-bash.ts';
import { sqliteBackend } from '../../src/sqlite-entry.ts';

/** A temporary directory, and a function that removes it. */
async function tempDir(prefix: string) {
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

export const sqlBackends: readonly SqlConformanceBackend[] = [
	{
		name: 'sqlite in memory',
		open: async () => ({ backend: sqliteBackend(':memory:'), dispose: async () => {} }),
	},
	{
		name: 'sqlite on a file',
		open: async () => {
			const { dir, dispose } = await tempDir('ambion-sqlite-');
			return { backend: sqliteBackend(join(dir, 'nested', 'lab.db')), dispose };
		},
	},
];

/**
 * A bash backend that connects through a fresh memory backend and names the
 * just-bash layout. `make` replaces or adds members, and gets the inner
 * backend to connect through.
 */
export function wrapped(
	make: (inner: MemoryBashBackend) => Partial<BashBackend> = () => ({}),
): BashBackend {
	const inner = memoryBackend();
	return {
		connect: (agent, signal) => inner.connect(agent, signal),
		layout: { audit: DEFAULT_AUDIT_LOG, rooms: '/rooms' },
		...make(inner),
	};
}

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

/** The tool `name` in the workspace bundle. */
export function toolOf(site: Pick<Workspace, 'tools'>, name: string): AmbionTool {
	const tool = site.tools().tools.find((candidate) => candidate.name === name);
	if (tool === undefined) throw new Error(`No tool named ${name}.`);
	return tool;
}

/** A tool context for `agent`, with an identity as the core type needs. */
export const callAs = (agent: string, rest: Partial<ToolContext> = {}): ToolContext => ({
	agent: { name: agent, identity: `${agent} identity` },
	callId: 'call-1',
	...rest,
});

/** Invoke `tool` and return the text of its result. */
export async function invokeText(
	tool: AmbionTool,
	params: unknown,
	context: ToolContext,
): Promise<string> {
	const result = await tool.invoke(params, context);
	if (typeof result === 'string') return result;
	return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}
