/**
 * The neutral layer's file tools, read, write and edit, and the tool line
 * of the guidance.
 *
 * Every workspace gets these three tools, the five process tools
 * (`./process-tools.ts`: bash, ps, status, wait and cancel), and `snapshot`
 * and `restore` (`./snapshots.ts`) before any tool its bash backend adds of
 * its own. A workspace with a SQL backend also gets
 * `sql` (`./sql-tool.ts`), and one with a git backend gets `repos`, `clone`
 * and `fork` (`./git-tools.ts`). The file tools run over the port of the bash
 * backend alone, so this module names no just-bash type.
 */

import type { WorkspaceEnv } from './backend.ts';
import type { Capability } from './capability.ts';
import { fileTools } from './file-tools.ts';
import type { WorkspaceResource } from './resource.ts';

/** The number words of the tool line, by the number of tools, from ten. */
const COUNT_WORDS: Readonly<Record<number, string>> = {
	10: 'ten',
	11: 'eleven',
	12: 'twelve',
	13: 'thirteen',
	14: 'fourteen',
	15: 'fifteen',
	16: 'sixteen',
};

/** `a, b and c`. */
function listOf(names: readonly string[]): string {
	return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * The tool line of the guidance. `names` holds the name of each tool of the
 * bundle, in order. The count is a word from ten to sixteen, and digits
 * outside that range.
 */
export function defaultToolGuidance(names: readonly string[]): string {
	return `Your workspace gives you ${COUNT_WORDS[names.length] ?? names.length} tools: ${listOf(names)}.`;
}

/** The note on the file tools and the bash tool. */
const FILES_NOTE = [
	`read, write, edit and bash work on shared files. Other agents connected to this`,
	`workspace read and write the same files.`,
].join('\n');

/** The file capability: the three file tools on the bash resource, and their note. */
export function fileCapability(bash: WorkspaceResource<WorkspaceEnv>['use']): Capability {
	return { tools: fileTools(bash), notes: [FILES_NOTE] };
}
