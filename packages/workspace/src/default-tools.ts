/**
 * The neutral layer's file tools, read, write and edit, and the tool line
 * of the guidance.
 *
 * Every workspace gets these three tools, the four process tools
 * (`./process-tools.ts`: bash, ps, wait and cancel), and `snapshot`
 * and `restore` (`./snapshots.ts`) before any tool its bash backend adds of
 * its own. A workspace with a SQL backend also gets
 * `sql` (`./sql-tool.ts`), and one with a git backend gets `repos`
 * and `fork` (`./git-tools.ts`). The file tools run over the port of the bash
 * backend alone, so this module names no just-bash type.
 */

import type { WorkspaceEnv } from './backend.ts';
import type { Capability } from './capability.ts';
import { fileTools } from './file-tools.ts';
import type { WorkspaceResource } from './resource.ts';

/** The note on the file tools and the bash tool. */
const FILES_NOTE = [
	`read, write, edit and bash work on shared files. Other agents connected to this`,
	`workspace read and write the same files.`,
].join('\n');

/** The file capability: the three file tools on the bash resource, and their note. */
export function fileCapability(bash: WorkspaceResource<WorkspaceEnv>['use']): Capability {
	return { tools: fileTools(bash), notes: [FILES_NOTE] };
}
