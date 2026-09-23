/**
 * The neutral layer's default tools: read, write, edit, bash and sql.
 *
 * Every workspace gets these five tools before any tool a backend adds of
 * its own. A bash backend with no tools of its own still offers all five.
 * The tools run over Pi's `ExecutionEnv` alone, so this module names no
 * just-bash type.
 *
 * `sql` has two forms. With no SQL backend, the shell `sql` tool of
 * `./sql.ts` opens the bash backend's own shared database, at the path
 * its `layout` names. With a SQL backend, `./sql-tool.ts` runs the
 * statements on that backend. The guidance states the form the workspace
 * has, so an agent reads one true fact about where its data lives.
 */

import {
	type AgentHarnessTool,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type ExecutionToolContext,
} from '@earendil-works/pi-agent-core';
import { createSqlTool } from './sql.ts';

/** Guidance for the four file tools. */
const FILE_TOOL_GUIDANCE = [
	`Your workspace gives you five tools: read, write, edit, bash and sql. read, write, edit`,
	`and bash work on shared files. Other agents connected to this workspace read and write the`,
	`same files.`,
].join('\n');

/** Guidance for the five default tools, with the shell `sql` tool opening `database`. */
export function defaultToolGuidance(database: string): string {
	return fileToolGuidance(shellSqlGuidance(database));
}

/** Guidance for the four file tools, and a `sql` tool whose own guidance is `sqlGuidance`. */
export function fileToolGuidance(sqlGuidance: string): string {
	return `${FILE_TOOL_GUIDANCE}\n\n${sqlGuidance}`;
}

/** Guidance for the shell `sql` tool and the shared database at `database`. */
function shellSqlGuidance(database: string): string {
	return [
		`sql runs SQLite statements on one shared database at ${database}. Every agent`,
		`queries this database, so a table or a view you create is data another agent reads at`,
		`once. Share through a view or a table; this needs no copy. Attach a private scratch`,
		`database with ATTACH ':memory:' inside one call. The tool shows the last result as a`,
		`table and keeps the data in the database. Set export to write the full result as a CSV`,
		`file for another tool or script. This is SQLite: dates are functions, || joins text,`,
		`and a column type is an affinity.`,
	].join('\n');
}

/** Build the four file tools every workspace gets. */
export function createFileTools(): readonly AgentHarnessTool<ExecutionToolContext>[] {
	return [createReadTool(), createWriteTool(), createEditTool(), createBashTool()];
}

/** Build the five default tools of a workspace with no SQL backend, with `sql` opening `database`. */
export function createDefaultTools(
	database: string,
): readonly AgentHarnessTool<ExecutionToolContext>[] {
	return [...createFileTools(), createSqlTool(database)];
}
