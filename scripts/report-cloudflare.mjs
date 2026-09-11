#!/usr/bin/env node
/**
 * Writes the demo report for a run on Cloudflare, from the JSON that
 * `examples/site`'s `pnpm demo:cloudflare` captured.
 *
 *   node scripts/report-cloudflare.mjs demo-cloudflare-run.json demos/<file>.html
 *
 * This report answers one question: what happens to a seat that is at work
 * when the room it commits to goes away. Every figure is read off the run's
 * log, and the log is the whole evidence: each row names the run that wrote
 * it, so a lease one run claimed and another released is a fact on the page.
 *
 * `report.mjs` writes the other report, for the run on Node. It shows far
 * more of the room, because one process holds every seat there and an event
 * stream reaches it. Here the seats are objects of their own, so the log is
 * what a reader outside them can have.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
	console.error('usage: node scripts/report-cloudflare.mjs <run.json> <out.html>');
	process.exit(2);
}
const run = JSON.parse(readFileSync(inPath, 'utf8'));
const css = readFileSync(new URL('./report.css', import.meta.url), 'utf8');

import { attemptOf, esc, foldLeases, plural, rowsOf, runsOf, writerOf } from './report-log.mjs';

const log = run.log;
const runs = runsOf(log);
/** Which run wrote a row, as the page names it. */
const wroteIt = (row) => {
	const at = writerOf(runs, row);
	return at === undefined ? '—' : `run ${at}`;
};
const leaseRows = rowsOf(log, 'lease');
const leases = foldLeases(log);
const crossed = leases.filter((lease) => lease.crossed);
/** The activations that crossed the crash and still put their work on the record. */
const survived = crossed.filter((lease) => lease.state === 'released');
const retried = leases.filter((lease) => attemptOf(lease.id) > 1);
/** Every lease that ended any way but released: the room got nothing from it. */
const lost = leases.filter((lease) => lease.phase === 'ended' && lease.state !== 'released');
const messageRows = rowsOf(log, 'message');
const summary = run.record.find((m) => m.kind === 'summary');
const answered = run.record.filter((m) => m.kind === 'said' && m.from !== 'priya');

/**
 * What each seat did inside its own object, out of Cloudflare's logs. The
 * room's log cannot hold this: a tool call is raised in the seat's object and
 * reaches no other, so the seat writes each event as a structured log line
 * and the demo reads them back.
 */
const events = run.events ?? [];
const byActivation = new Map();
for (const event of events) {
	byActivation.set(event.activation, [...(byActivation.get(event.activation) ?? []), event]);
}
const toolCalls = events.filter((event) => event.event === 'tool_execution_start');
const errors = events.filter((event) => event.event === 'error');

const ranAt = new Date(run.ranAt).toLocaleDateString('en-GB', {
	day: 'numeric',
	month: 'long',
	year: 'numeric',
});
const stat = (value, label) => `<div class="stat"><b>${esc(value)}</b><span>${label}</span></div>`;

function leaseTable() {
	const rows = leases
		.map(
			(lease) =>
				`<tr><td class="tid">${esc(lease.id)}</td><td>${esc(lease.claimedBy)}</td><td>[${lease.heardThrough}]</td><td>${esc(lease.state)}</td><td>${esc(lease.endedBy)}</td><td>${lease.crossed ? '<b>yes</b>' : 'no'}</td></tr>`,
		)
		.join('');
	return `<div class="tw"><table><thead><tr><th>Activation</th><th>Lease claimed by</th><th>Heard through</th><th>How it ended</th><th>Ended by</th><th>Crossed the crash</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function seatTable() {
	const rows = [...byActivation.entries()]
		.map(([activation, raised]) => {
			const tools = raised
				.filter((event) => event.event === 'tool_execution_start')
				.map((event) => event.tool);
			const failed = raised.filter((event) => event.event === 'error').map((event) => event.error);
			const seat = raised[0]?.seat ?? '';
			return `<tr><td class="tid">${esc(activation)}</td><td class="tid">${esc(seat)}</td><td>${tools.length ? tools.map((tool) => `<code>${esc(tool)}</code>`).join(' ') : '<span style="opacity:.55">no tool</span>'}</td><td>${esc(failed.join('; '))}</td></tr>`;
		})
		.join('');
	return `<div class="tw"><table><thead><tr><th>Activation</th><th>Seat</th><th>Tools it called</th><th>What failed</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function recordTable() {
	const rows = messageRows
		.map(
			(row) =>
				`<tr><td>[${row.seq}]</td><td class="tid">${esc(row.kind)}</td><td class="tid">${esc(row.from)}</td><td>${esc(wroteIt(row))}</td><td>${esc((row.text ?? '').slice(0, 150))}</td></tr>`,
		)
		.join('');
	return `<div class="tw"><table><thead><tr><th>Seq</th><th>Kind</th><th>From</th><th>Written by</th><th>Text</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

const html = `<meta charset="utf-8">
<title>The Room Goes, The Seats Stay</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Spectral:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>${css}</style>
<main>
<p class="meta">Ambion demo &middot; ${esc(ranAt)} &middot; ${esc(run.model)} &middot; room &lsquo;${esc(run.name)}&rsquo; &middot; on Cloudflare Durable Objects, in workerd</p>
<h1>The Room Goes, The Seats Stay</h1>
<p class="lede">A room on Cloudflare is one Durable Object for the record and one for each seat, so the platform can take the room and leave the seats running. This run does exactly that. ${plural(run.crash.leases, 'lease was', 'leases were')} running when the room object was dropped, and the seats holding them never noticed: they were waiting on a model. ${survived.length ? `${plural(survived.length, 'activation', 'activations')} claimed a lease from one run and released it to the next` : 'No activation crossed the crash and lived'} — their work went onto the record of the room that came back, under the id the dead run had written. ${lost.length ? `${plural(lost.length, 'lease', 'leases')} ended another way: ${esc(lost.map((l) => `${l.id} ${l.state}`).join(', '))}.` : 'Every lease ended released, so the room lost no activation to the crash.'}</p>
<div class="stats">${stat(runs.length, 'runs took the name')}${stat(run.crash.leases, 'leases live at the crash')}${stat(survived.length, 'activations crossed it')}${stat(answered.length, 'agent answers')}${stat(leaseRows.length, 'lease rows')}${stat(messageRows.length, 'messages')}${stat(toolCalls.length, 'tool calls, from the logs')}</div>
<p class="note">Every line is read off one live run. The people were scripted only in what they asked; the crash was scripted to land once the seats held their leases, and nothing else about it was.</p>

<section>
<h2>What the run did</h2>
<ol class="steps">${run.steps.map((s, i) => `<li><span class="n">${i + 1}</span><span>${esc(s.step)}</span></li>`).join('')}</ol>
</section>

<section>
<h2>Every activation, and which run served it</h2>
<p class="note">A seat's credential is its lease row on the log, not a session with the process that wrote it. The room reads the fold and asks nothing about which run issued the lease, so a room that comes back over the same storage serves the activation the dead run started. <b>Crossed the crash</b> marks an activation whose lease one run claimed and another released.</p>
${leaseTable()}
<p class="note" style="margin-top:1.4rem">${retried.length ? `${plural(retried.length, 'activation', 'activations')} ran as a second attempt: ${retried.map((l) => `<code>${esc(l.id)}</code>`).join(', ')}.` : 'No id carries an attempt number, so every wake was answered on its first attempt. Nothing was said twice, and nobody waited out a lease expiry.'}</p>
</section>

${
	events.length
		? `<section>
<h2>Inside the seats, out of the logs</h2>
<p class="note">A tool call happens inside the seat's own object and reaches no other, so the room's log cannot hold it. Each seat writes its events as structured log lines instead, and this run read ${plural(events.length, 'line', 'lines')} back through the query wrangler serves over them. ${plural(toolCalls.length, 'tool call', 'tool calls')} and ${plural(errors.length, 'failure', 'failures')} are below, by the activation that raised them. A deployed worker answers the same question through the Workers Logs API.</p>
${seatTable()}
</section>`
		: ''
}

<section>
<h2>The record, and the run that wrote each line</h2>
<p class="note">Every run writes an <code>ambion/run</code> row before anything else and stamps each later entry with its own id. ${plural(runs.length, 'run', 'runs')} took this name, so the stamp says on which side of the crash a message landed.</p>
${recordTable()}
${summary ? `<p class="note" style="margin-top:1.4rem">The exchange closed into one message. <b>${esc(summary.from)}</b> wrote it for <b>${esc(summary.to)}</b>, covering the whole question, and the crash is inside the range it stands for:</p><blockquote class="answer">${esc(summary.text)}</blockquote>` : ''}
</section>

<section>
<h2>What this run proves, and what it does not</h2>
<p class="note"><b>It proves the partial failure.</b> One process going down does not take the work of the processes around it. That is the failure a platform of small objects makes ordinary, and the one a single-process demo cannot stage: there, a crash takes the room and every seat together.</p>
<p class="note"><b>A stub held too long broke it.</b> The seat object built one stub for the room and kept it for the whole activation. A stub dies with the object it names, so the commit threw, the release threw after it, and the seat wrote nothing: the lease sat live until it expired, and the room sent the wake again a minute later. The seat takes a stub per call now, and <code>packages/cloudflare/test/restart.test.ts</code> holds it there.</p>
<p class="note"><b>It shows less of the room than the run on Node.</b> A seat's tool calls, its own transcript and what it spent are inside its object, and no call carries them out yet. The report for the run on Node has them, and cannot have this. The two demos prove different things, and the repository keeps both.</p>
</section>
</main>
`;

writeFileSync(outPath, html);
console.log(`wrote ${outPath}: ${html.length.toLocaleString('en-GB')} bytes`);
