import type { RoomView, Workbench } from './workbench.ts';

/**
 * Dismiss one say of the open room that waits to return. The handle must
 * name a say that the view lists, so a typo reaches no other say.
 */
export async function dismissCommand(
	host: Workbench,
	view: RoomView | undefined,
	argument: string,
): Promise<{ notice: string } | { error: unknown }> {
	if (!view) return { notice: 'No room is open.' };
	if (view.status !== 'running')
		return { notice: `${view.name} is not running. Use /resume first.` };
	const say = view.scheduled.find((candidate) => String(candidate.seq) === argument.trim());
	if (!say)
		return {
			notice:
				'Use /dismiss <n>, where n is a say that waits. Type /dismiss and a space to list them.',
		};
	try {
		const done = await host.dismiss(view.name, say.seq);
		return {
			notice: done
				? `Dismissed say ${say.seq}. ${say.seat} does not come back to it.`
				: `Say ${say.seq} no longer waits.`,
		};
	} catch (error) {
		return { error };
	}
}
