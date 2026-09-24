import { BACKGROUND_CONTEXT, type ProcessStatus, type Workspace } from '@ambionframework/workspace';

/** One background process, as the workspace reports it. */
export type ProcessView = ProcessStatus;

/** The end of one output file, as the processes panel shows it. */
export interface ProcessOutput {
	handle: string;
	text: string;
	/** The size of the whole output file, in bytes. */
	size: number;
	/** True when `text` holds only the end of the output. */
	truncated: boolean;
}

/** The panel reads an output file whole up to this size. */
const MAX_READ = 1_048_576;

/** The panel shows the last bytes of an output, up to this size. */
const SHOWN = 65_536;

/** The order of the panel: the running processes first, then the newest start first. */
export function byRecency(processes: readonly ProcessView[]): ProcessView[] {
	const running = (process: ProcessView) => (process.state === 'running' ? 0 : 1);
	return [...processes].sort(
		(a, b) => running(a) - running(b) || b.startedAt.localeCompare(a.startedAt),
	);
}

/** The end of a text, cut at a line break, so the first shown line is whole. */
function lastPart(text: string): { text: string; truncated: boolean } {
	if (text.length <= SHOWN) return { text, truncated: false };
	const end = text.slice(-SHOWN);
	const cut = end.indexOf('\n');
	return { text: cut === -1 ? end : end.slice(cut + 1), truncated: true };
}

/**
 * Read the end of the output of one process, as its owner agent. A file that
 * does not exist yet reads as empty. A file larger than 1 MiB gives no text,
 * so a large output does not reach the host whole.
 */
export async function readOutput(
	workspace: Workspace,
	process: ProcessView,
): Promise<ProcessOutput> {
	return workspace.use({ name: process.agent }, async (env) => {
		const info = await env.fileInfo(process.output, BACKGROUND_CONTEXT);
		const size = info.ok ? info.value.size : 0;
		const empty = { handle: process.handle, text: '', size, truncated: size > 0 };
		if (size === 0 || size > MAX_READ) return empty;
		const read = await env.readTextFile(process.output, BACKGROUND_CONTEXT);
		if (!read.ok) return empty;
		return { handle: process.handle, size, ...lastPart(read.value) };
	});
}
