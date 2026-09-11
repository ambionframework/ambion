/**
 * Reading a room's log, for the demo reports.
 *
 * Both reports read the same rows, and the rules for reading them belong to
 * the runtime and not to either page. A lease row carries no `heard` field,
 * and the run that wrote a row is a stamp the fence puts there: a report that
 * folds either one by hand goes stale the next time the shape moves, which is
 * how the first of these pages came to state a rule the room had stopped
 * following.
 *
 * The prose of a report belongs to the change its run was made for, and stays
 * in the script that writes it. Only what the log means lives here.
 */

/** Every row of one kind, in the order it landed. */
export const rowsOf = (log, kind) =>
	log.filter((row) => row.type === `ambion/${kind}`).map((row) => row.data);

/** The runs that took the name, in the order they took it. */
export const runsOf = (log) => rowsOf(log, 'run').map((row) => row.run);

/**
 * Which run wrote a row, counted from one, or nothing for a row written
 * before runs were fenced. Every entry a fenced run writes carries its id.
 */
export const writerOf = (runs, row) => {
	const at = runs.indexOf(row?.written);
	return at < 0 ? undefined : at + 1;
};

/**
 * What the rows for one activation fold to. The last row wins. The first says
 * when the lease was claimed, and the last running row says the seq the
 * activation had taken, which is that row's `after`.
 */
export function foldLeases(log) {
	const rows = rowsOf(log, 'lease');
	const runs = runsOf(log);
	const name = (row) => {
		const at = writerOf(runs, row);
		return at === undefined ? '—' : `run ${at}`;
	};
	return [...new Set(rows.map((row) => row.id))].map((id) => {
		const mine = rows.filter((row) => row.id === id);
		const first = mine[0];
		const last = mine[mine.length - 1];
		const running = [...mine].reverse().find((row) => row.phase === 'running');
		return {
			id,
			phase: last.phase,
			reason: last.reason,
			state: last.phase === 'ended' ? last.reason : 'running',
			at: last.at,
			claimedAt: first.at,
			heardThrough: running?.after ?? first.after,
			claimedBy: name(first),
			endedBy: name(last),
			/** The lease one run claimed and another ended: the crash fell inside it. */
			crossed: name(first) !== name(last),
		};
	});
}

/**
 * Which attempt an id names. Nothing mints an id: a wake is `<seq>:<seat>`
 * and a later attempt adds the number, a draft is `close:<through>:<attempt>`
 * and counts from one. So a trailing number is a retry for a wake, and only a
 * number above one is a retry for a draft.
 */
export function attemptOf(id) {
	const draft = /^close:\d+:(\d+)$/.exec(id);
	if (draft) return Number(draft[1]);
	const wake = /^\d+:.+:(\d+)$/.exec(id);
	return wake ? Number(wake[1]) : 1;
}

export const esc = (s) =>
	String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#x27;');

export const plural = (x, one, many) => `${x} ${x === 1 ? one : many}`;
