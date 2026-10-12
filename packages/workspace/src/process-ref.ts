/**
 * The one resolver of a process reference: a handle, or the name of one
 * process. `fetch`, `wait`, and `cancel` resolve their `process` value
 * through it, each over the processes it may reach.
 *
 * `docs/processes.md` is the design contract.
 */

import type { Process } from './process-files.ts';

/** The text that names the processes of a refused name: `<handle> of <agent>`, in order. */
const named = (found: readonly Process[]): string =>
	found.map((one) => `${one.handle} of ${one.agent}`).join(', ');

/** `Two` for two, and the number for more, so a sentence can start with it. */
const countOf = (count: number): string => (count === 2 ? 'Two' : String(count));

/**
 * The one process of `candidates` that `ref` names. A process with the
 * handle `ref` is the match. Otherwise the match is the process with the
 * name `ref`. When more than one process holds the name and some of them
 * run, only the running ones count. `absent` is the message when nothing
 * matches. A name that more than one process holds is refused, and the
 * message lists the handles.
 */
export function resolveProcess(
	ref: string,
	candidates: readonly Process[],
	absent: string,
): Process {
	const handled = candidates.find((one) => one.handle === ref);
	if (handled !== undefined) return handled;
	const found = candidates.filter((one) => one.name === ref);
	const running = found.filter((one) => one.state === 'running');
	const chosen = running.length > 0 ? running : found;
	const [only, ...more] = chosen;
	if (only === undefined) throw new Error(absent);
	if (more.length > 0) {
		const which = running.length > 0 ? 'running processes' : 'processes';
		throw new Error(
			`${countOf(chosen.length)} ${which} are named '${ref}': ${named(chosen)}. Give the handle.`,
		);
	}
	return only;
}
