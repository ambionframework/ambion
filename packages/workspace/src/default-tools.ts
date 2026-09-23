/**
 * The neutral layer's five default tools: read, write, edit, bash and sql.
 *
 * Every workspace gets these five tools before any tool a backend adds of
 * its own. A backend with no tools of its own still offers all five. The
 * tools run over Pi's `ExecutionEnv` alone, so this module names no
 * just-bash type.
 *
 * `sql` opens the backend's own shared database by default. A backend
 * states this database's path in its `layout`, and `openWorkspace` passes
 * it here. The guidance below states the same path, so an agent reads one
 * true fact about where its data lives.
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

/** Guidance for the five default tools and the shared database at `database`. */
export function defaultToolGuidance(database: string): string {
	return [
		`Your workspace gives you five tools: read, write, edit, bash and sql, over shared`,
		`files. Other agents connected to this workspace read and write the same files.`,
		``,
		`sql runs SQLite statements on one shared database at ${database}. Every agent`,
		`queries this database, so a table or a view you create is data another agent reads at`,
		`once. Share through a view or a table; this needs no copy. Attach a private scratch`,
		`database with ATTACH ':memory:' inside one call. The tool shows the last result as a`,
		`table and keeps the data in the database. Set export to write the full result as a CSV`,
		`file for another tool or script. This is SQLite: dates are functions, || joins text,`,
		`and a column type is an affinity.`,
	].join('\n');
}

/** Build the five default tools every workspace gets, with `sql` opening `database` by default. */
export function createDefaultTools(
	database: string,
): readonly AgentHarnessTool<ExecutionToolContext>[] {
	return [
		createReadTool(),
		createWriteTool(),
		createEditTool(),
		createBashTool(),
		createSqlTool(database),
	];
}
