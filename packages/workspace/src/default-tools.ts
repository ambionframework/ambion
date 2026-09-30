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
import { PROCESS_TOOL_NAMES } from './process-tools.ts';

const COUNTS = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen'];

/** The tools every workspace has, in the order the tool line names them. */
const BASE_TOOLS = ['read', 'write', 'edit', ...PROCESS_TOOL_NAMES, 'snapshot', 'restore'];

/** `a, b and c`. */
function listOf(names: readonly string[]): string {
	return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * The tool line of the guidance. `extra` names the tools that the other
 * backends add, in order: `sql`, `repos`, `clone`, `fork`, `connect`, and
 * `observe`. Absent, the workspace has ten tools.
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
export function createFileTools(images = true): readonly AgentHarnessTool<ExecutionToolContext>[] {
	const nativeRead = createReadTool(
		images
			? undefined
			: {
					imageProcessor: async (_bytes, mimeType) => ({
						ok: false,
						message: `[Image attachment omitted for this tool bundle: ${mimeType}]`,
					}),
				},
	);
	const read = images
		? nativeRead
		: {
				...nativeRead,
				description: nativeRead.description.replace(
					'Images are sent as attachments.',
					'Images are omitted and their paths are returned.',
				),
				execute: async (...args: Parameters<typeof nativeRead.execute>) => {
					const result = await nativeRead.execute(...args);
					if (
						!result.content.some(
							(item) =>
								item.type === 'text' &&
								item.text.includes('[Image attachment omitted for this tool bundle:'),
						)
					)
						return result;
					const params = args[1] as { readonly path: string };
					const env = (args[3] as ExecutionToolContext).env;
					const context = args[5];
					const resolved = await env.absolutePath(params.path, context);
					const path = resolved.ok ? resolved.value : params.path;
					return {
						...result,
						content: result.content.map((item) =>
							item.type === 'text' ? { ...item, text: `${item.text}\nImage path: ${path}` } : item,
						),
					};
				},
			};
	return [read, createWriteTool(), createEditTool()];
}
