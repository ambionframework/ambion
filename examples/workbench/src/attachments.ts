import { fileUri } from './refs.ts';
import type { Workbench } from './workbench.ts';

/** One local file `/attach` copied into the workspace, staged as a ref of the next message. */
export interface StagedAttachment {
	path: string;
	ref: string;
}

async function attach(host: Workbench, localPath: string): Promise<StagedAttachment> {
	const entry = await host.attach(localPath);
	return { path: entry.path, ref: fileUri(entry.path) };
}

/** What `/attach` tells the terminal: a notice to say, or an error to show. */
export type AttachResult = { readonly notice: string } | { readonly error: unknown };

/**
 * Whatever the session's current `pendingRefs` is. `target.pendingRefs` reads
 * live, at the moment the copy lands — not a captured array — so a room
 * switch that replaces the array while `/attach` copies a file in the
 * background loses nothing: the staged file lands in whichever array
 * `pendingRefs` names by then.
 */
export interface AttachTarget {
	pendingRefs: StagedAttachment[];
}

/** Run `/attach`: copy a local file into the workspace, and stage it as a ref. */
export async function attachCommand(
	host: Workbench,
	target: AttachTarget,
	localPath: string,
): Promise<AttachResult> {
	if (!localPath.trim()) return { notice: 'Use /attach <local file path>.' };
	try {
		const staged = await attach(host, localPath.trim());
		target.pendingRefs.push(staged);
		return { notice: `Attached ${staged.path}. It goes with your next message.` };
	} catch (error) {
		return { error };
	}
}
