/**
 * The neutral layer's file tools: read, write, edit and bash.
 *
 * Every workspace gets these four tools before any tool its bash backend
 * adds of its own. A workspace with a SQL backend also gets `sql`
 * (`./sql-tool.ts`). A workspace with no SQL backend has no `sql` tool. The
 * file tools run over Pi's `ExecutionEnv` alone, so this module names no
 * just-bash type.
 */

import {
	type AgentHarnessTool,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type ExecutionToolContext,
} from '@earendil-works/pi-agent-core';

/** Guidance for a workspace with no SQL backend: the four file tools. */
const FILE_TOOLS = [
	`Your workspace gives you four tools: read, write, edit and bash, over shared files.`,
	`Other agents connected to this workspace read and write the same files.`,
].join('\n');

/** Guidance for a workspace with a SQL backend: the four file tools and sql. */
const FILE_AND_SQL_TOOLS = [
	`Your workspace gives you five tools: read, write, edit, bash and sql. read, write,`,
	`edit and bash work on shared files. Other agents connected to this workspace read and`,
	`write the same files.`,
].join('\n');

/**
 * Guidance for the default tools. `sqlGuidance` describes the `sql` tool
 * when the workspace has one. Absent, the workspace has four tools.
 */
export function defaultToolGuidance(sqlGuidance?: string): string {
	return sqlGuidance === undefined ? FILE_TOOLS : `${FILE_AND_SQL_TOOLS}\n\n${sqlGuidance}`;
}

/** Build the four file tools every workspace gets. */
export function createFileTools(): readonly AgentHarnessTool<ExecutionToolContext>[] {
	return [createReadTool(), createWriteTool(), createEditTool(), createBashTool()];
}
