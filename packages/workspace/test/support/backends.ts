/**
 * The helpers the tests in this package share. `sqlBackends` are the two
 * SQLite harnesses, the harness type `sqlConformance` takes.
 *
 * The bash backends are the just-bash backends. This package's tests reach
 * their source and their test support by relative path, the way the core's
 * tests reach the Pi source: a package dependency on `@ambionframework/just-bash`
 * would close a cycle, since that package depends on this one.
 * `vitest.config.ts` and `tsconfig.check.json` send the
 * `@ambionframework/workspace` specifiers in that source to this package's
 * own source, so a test reads one workspace module.
 */
import { join } from 'node:path';
import type { AmbionTool, ToolContext } from '@ambionframework/ambion';
import { type MemoryBashBackend, memoryBackend } from '../../../just-bash/src/index.ts';
import { tempDir } from '../../../just-bash/test/support/backends.ts';
import { DEFAULT_AUDIT_LOG } from '../../src/audit.ts';
import type { BashBackend } from '../../src/backend.ts';
import type { SqlConformanceBackend } from '../../src/conformance.ts';
import type { Workspace } from '../../src/index.ts';
import { sqliteBackend } from '../../src/sqlite-entry.ts';

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
 * A bash backend that connects through a fresh memory backend, carries its
 * git transports, and names the just-bash layout. `make` replaces or adds
 * members, and gets the inner backend to connect through.
 */
export function wrapped(
	make: (inner: MemoryBashBackend) => Partial<BashBackend> = () => ({}),
): BashBackend {
	const inner = memoryBackend();
	return {
		connect: (agent, signal, services) => inner.connect(agent, signal, services),
		gitTransports: inner.gitTransports,
		layout: { audit: DEFAULT_AUDIT_LOG, rooms: '/rooms' },
		...make(inner),
	};
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
