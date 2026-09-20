/**
 * Measure the room's fold at 100, 1,000 and 4,000 closed exchanges.
 *
 * It prints the cost of a full replay and the cost of one new question, for
 * the reference fold path and the incremental projection. It is a manual
 * bench: timing is too noisy for the gate. Run it with
 * `node scripts/projection-envelope.mjs [sizes...]`.
 */
import { foldRoom } from '../packages/ambion/src/room/fold.ts';
import { advance, projectState, replay } from '../packages/ambion/src/room/projection.ts';
import { evolve } from '../packages/ambion/src/room/transition.ts';

const retry = { backoff: (attempt) => attempt * 30_000 };
const start = Date.parse('2026-01-01T09:00:00.000Z');
const stamp = (seq) => new Date(start + seq * 1000).toISOString();

/** The entries of one closed exchange, from `seq`: question, answer, close, summary. */
function exchange(first) {
	let seq = first;
	const at = () => stamp(seq);
	const out = [];
	const add = (kind, body, key) => out.push({ kind, seq: seq++, ...(key ? { key } : {}), body });
	const question = seq;
	const wake = `message:${question}:product:1`;
	add(
		'message',
		{ kind: 'said', at: at(), from: 'priya', text: 'Question.', wakes: ['product'] },
		`q${question}`,
	);
	add('lease', { id: wake, phase: 'running', expiresAt: start + 1e9, at: at(), readThrough: 0 });
	add(
		'message',
		{ kind: 'said', at: at(), from: 'product', text: 'Answer.', activationId: wake },
		`a${question}`,
	);
	add('lease', { id: wake, phase: 'ended', reason: 'released', at: at(), readThrough: seq - 1 });
	const through = seq - 1;
	add('close', { owner: 'priya', from: question, through, at: at(), summary: 'writer' });
	const draft = `closed:${through}:writer:1`;
	add('lease', { id: draft, phase: 'running', expiresAt: start + 1e9, at: at(), readThrough: 0 });
	add(
		'message',
		{
			kind: 'summary',
			at: at(),
			from: 'writer',
			to: 'priya',
			text: 'Summary.',
			covers: { from: question, through },
			activationId: draft,
		},
		`s${question}`,
	);
	add('lease', { id: draft, phase: 'ended', reason: 'released', at: at(), readThrough: seq - 1 });
	return out;
}

function history(count) {
	const composition = {
		version: 2,
		seq: 0,
		at: stamp(2),
		agents: [
			{ name: 'product', identity: 'Product.', attention: 'broadcast' },
			{ name: 'writer', identity: 'Writer.', attention: 'named' },
		],
		available: [],
		summary: 'writer',
	};
	const entries = [
		{ kind: 'composition', seq: 1, body: composition },
		{
			kind: 'message',
			seq: 2,
			key: 'arrival',
			body: { kind: 'arrived', at: stamp(2), from: 'priya', subject: 'priya', identity: 'Priya.' },
		},
	];
	while (entries.length < 2 + count * 8) entries.push(...exchange(entries.length + 1));
	return entries;
}

const time = (run) => {
	const began = performance.now();
	run();
	return performance.now() - began;
};

console.log(
	'closed exchanges | fold ms | replay ms | question, reference ms | question, incremental ms',
);
for (const size of process.argv
	.slice(2)
	.map(Number)
	.filter(Boolean)
	.concat(process.argv.length > 2 ? [] : [100, 1000, 4000])) {
	const entries = history(size);
	const next = exchange(entries.length + 1);
	const fold = time(() => foldRoom(entries, retry));
	const replayed = time(() => replay(entries, retry));
	// A copy of the state has no projection, so `evolve` runs the reference path.
	const base = foldRoom(entries, retry);
	const reference = time(() => {
		let state = { ...base };
		for (const entry of next) state = evolve({ ...state }, entry, retry);
	});
	const held = replay(entries, retry);
	const incremental = time(() => {
		let projection = held;
		for (const entry of next) projection = advance(projection, entry, retry);
		projectState(projection);
	});
	console.log(
		`${size} | ${fold.toFixed(0)} | ${replayed.toFixed(0)} | ${reference.toFixed(1)} | ${incremental.toFixed(1)}`,
	);
}
