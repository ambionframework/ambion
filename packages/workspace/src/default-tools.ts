/**
 * The neutral layer's file tools: read, write, edit and bash.
 *
 * Every workspace gets these four tools before any tool its bash backend
 * adds of its own. A workspace with a SQL backend also gets `sql`
 * (`./sql-tool.ts`), and one with a git backend gets `repos` and `fork`
 * (`./git-tools.ts`). The file tools run over Pi's `ExecutionEnv` alone,
 * so this module names no just-bash type.
 */

import {
	type AgentHarnessTool,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type ExecutionToolContext,
} from '@earendil-works/pi-agent-core';

/** Guidance for a workspace with no other backend: the four file tools. */
const FILE_TOOLS = [
	`Your workspace gives you four tools: read, write, edit and bash, over shared files.`,
	`Other agents connected to this workspace read and write the same files.`,
].join('\n');

const COUNTS = ['four', 'five', 'six', 'seven'];

/** `a, b and c`. */
function listOf(names: readonly string[]): string {
	return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * The tool line of the guidance. `extra` names the tools that the other
 * backends add, in order: `sql`, then `repos` and `fork`. Absent, the
 * workspace has four tools.
 */
export function defaultToolGuidance(extra: readonly string[] = []): string {
	if (extra.length === 0) return FILE_TOOLS;
	const names = ['read', 'write', 'edit', 'bash', ...extra];
	return [
		`Your workspace gives you ${COUNTS[names.length - 4]} tools: ${listOf(names)}.`,
		`read, write, edit and bash work on shared files. Other agents connected to this`,
		`workspace read and write the same files.`,
	].join('\n');
}

/** Build the four file tools every workspace gets. */
export function createFileTools(): readonly AgentHarnessTool<ExecutionToolContext>[] {
	return [createReadTool(), createWriteTool(), createEditTool(), createBashTool()];
}
