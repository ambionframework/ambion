/**
 * The two checks that every ref of a workspace passes: its length, and the
 * workspace it names. Snapshot refs and commit refs share them, so each
 * check has one home and one message.
 */

import { REF_LIMITS } from '@ambionframework/ambion';

/** Throw when `ref` is longer than a message carries. `of` names what the ref is of. */
export function assertRefLength(ref: string, of: string): void {
	if (ref.length > REF_LIMITS.length)
		throw new Error(
			`The ref of ${of} has ${ref.length} characters, and a ref has at most ${REF_LIMITS.length}.`,
		);
}

/** Throw when `ref` names a workspace other than `workspace`. */
export function assertRefWorkspace(ref: string, named: string, workspace: string): void {
	if (named !== workspace)
		throw new Error(`${ref} names the workspace '${named}', not '${workspace}'.`);
}
