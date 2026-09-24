/**
 * The neutral layer's file tools, read, write and edit, and the tool line
 * of the guidance.
 *
 * Every workspace gets these three tools and the four job tools
 * (`./job-tools.ts`: bash, status, wait and cancel) before any tool its
 * bash backend adds of its own. A workspace with a SQL backend also gets
 * `sql` (`./sql-tool.ts`), and one with a git backend gets `repos` and
 * `fork` (`./git-tools.ts`). The file tools run over Pi's `ExecutionEnv`
 * alone, so this module names no just-bash type.
 */

import {
	type AgentHarnessTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type ExecutionToolContext,
} from '@earendil-works/pi-agent-core';
import { JOB_TOOL_NAMES } from './job-tools.ts';

const COUNTS = ['seven', 'eight', 'nine', 'ten'];

/** The tools every workspace has, in the order the tool line names them. */
const BASE_TOOLS = ['read', 'write', 'edit', ...JOB_TOOL_NAMES];

/** `a, b and c`. */
function listOf(names: readonly string[]): string {
	return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * The tool line of the guidance. `extra` names the tools that the other
 * backends add, in order: `sql`, then `repos` and `fork`. Absent, the
 * workspace has seven tools.
 */
export function defaultToolGuidance(extra: readonly string[] = []): string {
	const names = [...BASE_TOOLS, ...extra];
	return [
		`Your workspace gives you ${COUNTS[names.length - BASE_TOOLS.length]} tools: ${listOf(names)}.`,
		`read, write, edit and bash work on shared files. Other agents connected to this`,
		`workspace read and write the same files.`,
	].join('\n');
}

/** Build the three file tools every workspace gets. */
export function createFileTools(): readonly AgentHarnessTool<ExecutionToolContext>[] {
	return [createReadTool(), createWriteTool(), createEditTool()];
}
