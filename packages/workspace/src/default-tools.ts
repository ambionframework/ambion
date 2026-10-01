/**
 * The neutral layer's file tools, read, write and edit, and the tool line
 * of the guidance.
 *
 * Every workspace gets these three tools, the five process tools
 * (`./process-tools.ts`: bash, ps, status, wait and cancel), and `snapshot`
 * and `restore` (`./snapshots.ts`) before any tool its bash backend adds of
 * its own. A workspace with a SQL backend also gets
 * `sql` (`./sql-tool.ts`), and one with a git backend gets `repos`, `clone`
 * and `fork` (`./git-tools.ts`). The file tools run over Pi's `ExecutionEnv`
 * alone, so this module names no just-bash type.
 */

import {
	type AgentHarnessTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type ExecutionToolContext,
} from '@earendil-works/pi-agent-core';
import type { WorkspaceEnv } from './backend.ts';
import type { Capability } from './capability.ts';
import type { WorkspaceResource } from './resource.ts';
import { bindTools } from './tools.ts';

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
	return { tools: bindTools(createFileTools(), bash), notes: [FILES_NOTE] };
}

/** The first line of a `read` result for an image, with the image part or without it. */
const IMAGE_READ = 'Read image file [';

/**
 * Build the three file tools every workspace gets. A `read` of an image
 * returns a text part that names the path of the file, beside the image part
 * or in place of it for a format with no image part, such as BMP.
 */
function createFileTools(): readonly AgentHarnessTool<ExecutionToolContext>[] {
	const nativeRead = createReadTool();
	const read = {
		...nativeRead,
		description: nativeRead.description.replace(
			'Images are sent as attachments.',
			'Images are sent as attachments, with the path of the file.',
		),
		execute: async (...args: Parameters<typeof nativeRead.execute>) => {
			const result = await nativeRead.execute(...args);
			const image = result.content.some(
				(item) => item.type === 'text' && item.text.startsWith(IMAGE_READ),
			);
			if (!image) return result;
			const params = args[1] as { readonly path: string };
			const env = (args[3] as ExecutionToolContext).env;
			const resolved = await env.absolutePath(params.path, args[5]);
			const path = resolved.ok ? resolved.value : params.path;
			return {
				...result,
				content: [...result.content, { type: 'text' as const, text: `Image path: ${path}` }],
			};
		},
	};
	return [read, createWriteTool(), createEditTool()];
}
