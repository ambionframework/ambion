import type { ParticipantInfo, PendingSay } from '@ambionframework/ambion';
import type { Block } from './timeline.ts';
import type { RoomAction, RoomView } from './workbench.ts';

export const HELP = [
	'Commands',
	'  /room <name>      switch to another room. Ctrl+R lists the rooms.',
	'  /new <name> [goal]  create a room. Without a goal, the next line is the goal.',
	'  /user <name>      switch to another person',
	'  /files            search the workspace files and read one in a side panel',
	'  /open <path>      open the files panel on one file',
	'  /ps               show the background processes of the agents, their output,',
	'                    and cancel one with x, twice',
	'  /attach <path>    copy a local file into the workspace and cite it in your next message',
	'  /try              fill the composer with the room’s suggested question',
	'  /abort            cancel the open exchange in this room',
	'  /stop             stop the room. /resume starts it again.',
	'  /steps [n]        show the steps of the newest activation of exchange n, oldest first.',
	'                    Without n, the latest exchange. /steps off hides them.',
	'  /expand           open every discussion. /collapse closes them.',
	'  /quit             leave the terminal. The rooms stop with it.',
	'Keys',
	'  Enter sends. Ctrl+J, Alt+Enter, and Shift+Enter add a line.',
	'  Tab browses the discussions. Up and Down choose, Enter opens or closes,',
	'  e opens all, c closes all, s shows the steps of the exchange, and Esc goes back',
	'  to the composer.',
	'  r, while browsing, chooses a ref of a shown message. Enter opens a file or a table',
	'  in the files panel, or jumps to a message. Esc goes back.',
	'  PageUp and PageDown scroll. Start a message with // to send a leading slash.',
].join('\n');

export const DONE: Record<RoomAction, (room: string) => string> = {
	abort: (room) => `Aborted the open exchange in ${room}.`,
	stop: (room) => `Stopped ${room}. Use /resume to start it again.`,
	resume: (room) => `Resumed ${room}.`,
};

export const errorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/** The reason an action does not apply to the room, or undefined when it does. */
export function refusal(action: RoomAction, view: RoomView | undefined): string | undefined {
	if (!view) return 'No room is open.';
	if (action === 'abort') {
		if (view.status !== 'running') return `${view.name} is not running. Use /resume first.`;
		return view.exchange ? undefined : `Nothing to abort. ${view.name} has no open exchange.`;
	}
	if (action === 'stop')
		return view.status === 'stopped' ? `${view.name} is already stopped.` : undefined;
	return view.status === 'running' ? `${view.name} is already running.` : undefined;
}

/** The agents that are at work in a room now. */
export const workingAgents = (view: RoomView | undefined): string[] =>
	(view?.participants ?? []).flatMap((participant: ParticipantInfo) =>
		participant.kind === 'agent' && participant.status === 'active' ? [participant.name] : [],
	);

/** What an empty room shows, with the room's suggested first question. */
export function emptyText(view: RoomView): string {
	const start = 'Nothing here yet. Ask a question below, or type / for commands.';
	return view.prompt ? `${start}\nTry: ${view.prompt}  (type /try to use it)` : start;
}

/** The notes after the closed exchanges: what waits on the person, then each say that waits. */
export function notesOf(attention: readonly string[], view: RoomView): Block[] {
	const notes = [...attention, ...view.scheduled.map(pendingLine)];
	return notes.map((text) => ({ type: 'note', text }));
}

/** One say that waits to return, as the conversation notes it. */
function pendingLine(say: PendingSay): string {
	const due = new Date(say.due);
	const later = due.valueOf() - Date.now() > 86_400_000;
	const time = Number.isNaN(due.valueOf())
		? say.due
		: due.toLocaleString([], {
				...(later ? { month: 'short', day: 'numeric' } : {}),
				hour: '2-digit',
				minute: '2-digit',
			});
	return `${say.seat} comes back at ${time} for ${say.owner}: ${say.text}`;
}
