/**
 * One run of the room on Cloudflare, captured as JSON for a demo report.
 *
 * This demo proves what `demo.ts` cannot. There, one process holds the room
 * and every seat, so a crash takes them all. Here the room is one Durable
 * Object and each seat is another, so the platform can take the room alone.
 * The demo does exactly that: it waits until the seats hold leases, drops the
 * room object, and lets the seats finish. The room that comes back folds the
 * same leases off the journal and takes the commits the dead run never saw.
 *
 * Run it in two terminals, from `examples/site`:
 *
 *   ANTHROPIC_API_KEY=… pnpm dev:cloudflare
 *   pnpm demo:cloudflare
 */
import { writeFileSync } from 'node:fs';
import { MODEL, ROOM_NAME } from './room.ts';

const WORKER = process.env.AMBION_WORKER ?? 'http://localhost:8787';
const OUT = process.env.DEMO_OUT ?? 'demo-cloudflare-run.json';

interface LogRow {
	type: string;
	data: Record<string, unknown>;
}
/** One event a seat raised inside its own object, read back from the logs. */
interface SeatEvent {
	room: string;
	seat: string;
	activation: string;
	event: string;
	tool?: string;
	error?: string;
	at: string;
}
interface LeaseData {
	id: string;
	phase: 'running' | 'ended';
	/** The run that wrote this row. The fence stamps every entry with it. */
	written?: string;
}
interface Say {
	seq: number;
	kind: string;
	from: string;
	to?: string;
	text?: string;
}

const steps: { at: string; step: string }[] = [];
const step = (s: string) => {
	process.stderr.write(`\n=== ${s} ===\n`);
	steps.push({ at: new Date().toISOString(), step: s });
};

async function call<T>(path: string, body?: unknown): Promise<T> {
	const response = await fetch(`${WORKER}${path}`, {
		method: body === undefined ? 'GET' : 'POST',
		...(body === undefined
			? {}
			: { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
	});
	if (!response.ok) throw new Error(`${path} answered ${response.status}`);
	return (await response.json()) as T;
}

/** Resolves once `read` returns something, or fails after `ms`. */
async function until<T>(read: () => Promise<T | undefined>, ms = 180_000): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = await read().catch(() => undefined);
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error('Nothing came in time.');
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

const journal = () => call<LogRow[]>('/journal');

/**
 * What the seats did inside their own objects, out of Cloudflare's logs.
 *
 * An activation runs in the seat's object and raises its events there, so the
 * room's journal holds no tool call. The seat writes each one as a structured journal
 * line instead, and wrangler keeps them where a query can reach: this is the
 * local explorer, and a deployed worker answers the same question through the
 * Workers Logs API.
 */
async function seatEvents(): Promise<SeatEvent[]> {
	const response = await fetch(`${WORKER}/cdn-cgi/local/explorer/api/local/observability/query`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			sql: `SELECT message FROM logs WHERE message LIKE '%"ambion":"seat"%' ORDER BY ts_ms`,
		}),
	});
	if (!response.ok) return [];
	const answer = (await response.json()) as { result?: { rows?: [string][] } };
	// Each row holds what one `console.log` was given, as the array it was called with.
	return (answer.result?.rows ?? []).flatMap((row) => {
		try {
			return JSON.parse(row[0]) as SeatEvent[];
		} catch {
			return [];
		}
	});
}
const messages = () => call<Say[]>('/messages');
/** Every row of one kind, read as the shape that kind carries on the wire. */
const rowsOf = <T>(rows: LogRow[], kind: string): T[] =>
	rows.filter((row) => row.type === `ambion/${kind}`).map((row) => row.data as T);

// The worker answers before the room starts, so any response says it is up.
const up = await fetch(WORKER).then(
	() => true,
	() => false,
);
if (!up) {
	process.stderr.write(
		`\nNo worker at ${WORKER}. Run 'pnpm dev:cloudflare' in another terminal first.\n`,
	);
	process.exit(2);
}

step('the room starts as Durable Objects: one for the record, one for each seat');
await call('/start', {});
await call('/visit', { person: 'priya' });

step('priya asks the question she has to answer today');
await call('/deliver', {
	from: 'priya',
	text: 'Can I tell the client Thursday for the Level 3 pour, or not?',
	key: 'priya-1',
});

step('the seats take their leases, and the room writes a row for each');
const claimed = await until(async () => {
	const held = rowsOf<LeaseData>(await journal(), 'lease');
	return held.length >= 2 ? held : undefined;
});
process.stderr.write(`  ${claimed.length} leases running\n`);
const crashedAtTime = new Date().toISOString();

step('the platform takes the room object; every seat object keeps working');
await call('/crash', {}).catch(() => {});

step('the seats commit into the room that came back, under the leases the dead run wrote');
const answers = await until(async () => {
	const said = (await messages()).filter((m) => m.kind === 'said' && m.from !== 'priya');
	return said.length > 0 ? said : undefined;
});
process.stderr.write(`  ${answers.length} agent answers on the record\n`);

step('the exchange closes, and the assistant writes priya the one message');
const summary = await until(async () => (await messages()).find((m) => m.kind === 'summary'));
process.stderr.write(
	`\n∎ ${summary.from} → ${summary.to}\n  ${(summary.text ?? '').slice(0, 240)}\n`,
);

// Every lease ends before the journal is read, so the capture holds the release
// of the draft the summary came from and not the row before it.
const rows = await until(async () => {
	const held = rowsOf<LeaseData>(await journal(), 'lease');
	const ids = [...new Set(held.map((row) => row.id))];
	const ended = ids.every((id) => held.filter((row) => row.id === id).at(-1)?.phase === 'ended');
	return ended ? await journal() : undefined;
});
const seats = await call<{ kind: string; name: string }[]>('/seats');
const events = await seatEvents();
process.stderr.write(`  ${events.length} seat events read back from the logs\n`);

/**
 * A lease one run claimed and another ended is the crossing this demo is for.
 * A run where none crossed proves nothing, and the report says so; the
 * operator hears it here, where running it again is still cheap.
 */
const finalLeases = rowsOf<LeaseData>(rows, 'lease');
const crossed = [...new Set(finalLeases.map((row) => row.id))].filter((id) => {
	const mine = finalLeases.filter((row) => row.id === id);
	return mine[0]?.written !== mine[mine.length - 1]?.written;
});
process.stderr.write(`  ${crossed.length} activations crossed the crash\n`);
if (crossed.length === 0) {
	process.stderr.write(
		'\nNo activation crossed the crash. This run proves nothing; run it again.\n',
	);
}
writeFileSync(
	OUT,
	JSON.stringify(
		{
			model: MODEL,
			name: ROOM_NAME,
			host: 'cloudflare',
			ranAt: new Date().toISOString(),
			steps,
			crash: { time: crashedAtTime, leases: claimed.length },
			journal: rows,
			runs: rowsOf<{ run: string }>(rows, 'run'),
			record: await messages(),
			seats,
			events,
		},
		null,
		2,
	),
);
process.stderr.write(`\nwrote ${OUT}\n`);
