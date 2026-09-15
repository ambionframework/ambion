#!/usr/bin/env node
/**
 * Writes one demo report from the JSON that `examples/site`'s `pnpm demo`
 * captured. Nothing in the numbers is typed by hand: every figure on the page
 * is read off the run. The prose around the figures belongs to the change the
 * run was made for, and moves with it.
 *
 *   node scripts/report.mjs demo-run.json demos/YYYY-MM-DD-<slug>.html
 *
 * The stylesheet beside this script, `report.css`, is the house style every
 * report shares; the run-specific colours are added below it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { attemptOf, esc, foldLeases, invalidRows, plural, rowsOf as rows } from './report-log.mjs';

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
	console.error('usage: node scripts/report.mjs <demo-run.json> <out.html>');
	process.exit(2);
}
const run = JSON.parse(readFileSync(inPath, 'utf8'));
const css = readFileSync(new URL('./report.css', import.meta.url), 'utf8');

const n = (x) => x.toLocaleString('en-GB');
const money = (x) => `$${x.toFixed(2)}`;
const words = (t) => t.trim().split(/\s+/).length;
const times = (x) => (x === 1 ? 'once' : `${x} times`);

const PEOPLE = new Set(run.people.map((p) => p.name));
const ASSISTANT = run.assistant.name;
const RESERVE = new Set(run.reserve.map((a) => a.name));
const COLOUR = {
	'time-tracker': 'c-shifts',
	'task-management': 'c-tasks',
	'materials-tracker': 'c-materials',
	'building-control': 'c-inspect',
	'plant-hire': 'c-plant',
	'temporary-works': 'c-tw',
	[ASSISTANT]: 'c-aide',
};
const colour = (name) => COLOUR[name] ?? '';
const WORKSPACE_TOOLS = new Set(['read', 'write', 'edit', 'bash']);

const record = run.record;
const said = record.filter((m) => m.kind === 'said');
const agentSaid = said.filter((m) => !PEOPLE.has(m.from));
const questions = said.filter((m) => PEOPLE.has(m.from));
const summaries = run.summaries;
const seatings = run.seatings;
const closed = run.timeline
	.filter((t) => t.event.type === 'exchange_closed')
	.map((t) => t.event.exchange);
const conflicts = run.timeline.filter((t) => t.event.type === 'conflict').length;
const errors = run.timeline.filter((t) => t.event.type === 'error').length;
const leaseExpiryErrors = run.timeline.filter(
	(t) => t.event.type === 'error' && t.event.error.message === 'The activation ran past its lease.',
).length;
const otherErrors = errors - leaseExpiryErrors;

// -- cost and tokens, off each seat's own session ---------------------------------
const usageOf = (turns) => {
	let cost = 0;
	let tokens = 0;
	let calls = 0;
	for (const t of turns) {
		if (t.role !== 'assistant') continue;
		calls += 1;
		const u = t.usage ?? {};
		tokens += (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
		cost += u.cost?.total ?? 0;
	}
	return { cost, tokens, calls };
};
const sessionOf = (agent) => run.seatSessions.find((s) => s.agent === agent);
// Activations in timeline order per agent map onto blocks in the same order.
const acts = run.activations.map((a) => ({ ...a }));
for (const s of run.seatSessions) {
	const mine = acts.filter((a) => a.agent === s.agent);
	s.blocks.forEach((b, i) => {
		const a = mine[i];
		if (!a) return;
		const u = usageOf(b.turns);
		a.cost = u.cost;
		a.tokens = u.tokens;
		a.turns = u.calls;
		a.block = i;
	});
}
const sessionTotals = run.seatSessions.reduce(
	(total, session) => {
		for (const block of session.blocks) {
			const usage = usageOf(block.turns);
			total.cost += usage.cost;
			total.tokens += usage.tokens;
			total.calls += usage.calls;
		}
		return total;
	},
	{ cost: 0, tokens: 0, calls: 0 },
);
const capturedBlocks = run.seatSessions.reduce(
	(total, session) => total + session.blocks.length,
	0,
);
const agentsWithCaptures = new Set([
	...run.seatSessions.map((session) => session.agent),
	...acts.map((activation) => activation.agent),
]);
let unmatchedBlocks = 0;
let unmatchedActivations = 0;
for (const agent of agentsWithCaptures) {
	const blockCount = run.seatSessions
		.filter((session) => session.agent === agent)
		.reduce((total, session) => total + session.blocks.length, 0);
	const activationCount = acts.filter((activation) => activation.agent === agent).length;
	if (blockCount > activationCount) unmatchedBlocks += blockCount - activationCount;
	if (activationCount > blockCount) unmatchedActivations += activationCount - blockCount;
}
const totalCost = sessionTotals.cost;
const totalTokens = sessionTotals.tokens;
const assistantActs = acts.filter((a) => a.agent === ASSISTANT);
const composing = assistantActs.filter(
	(a) =>
		a.tools.includes('seat') ||
		(a.block !== undefined &&
			sessionOf(ASSISTANT).blocks[a.block].turns.some(
				(t) =>
					t.role === 'user' && typeof t.content === 'string' && t.content.includes('The reserve:'),
			)),
);
const drafting = assistantActs.filter((a) => !composing.includes(a));
const seatActs = acts.filter((a) => a.agent !== ASSISTANT);

// -- what each activation read: context sizes --------------------------------------
const contextOf = (block) => {
	const first = block.turns.find((t) => t.role === 'user' && typeof t.content === 'string');
	return first?.content ?? '';
};

// -- pieces --------------------------------------------------------------------------
function stat(b, s) {
	return `<div class="stat"><b>${b}</b><span>${s}</span></div>`;
}

/** Where a seat sits, in the words the roster uses. */
function seatWhere(seat, isReserve, isAssistant) {
	if (isAssistant) return 'wakes for nothing said · the assistant';
	if (isReserve) {
		return seat.attention === undefined
			? 'on call, in the reserve'
			: `seated by the assistant · ${seat.attention}`;
	}
	return seat.attention === 'presence' ? 'wakes on arrivals too' : 'wakes on anything said';
}

function agentTools(tools, isAssistant) {
	if (isAssistant) return '<li>seat(name)</li><li>summarise(text)</li>';
	const own = tools.map((t) => `<li>${esc(t)}()</li>`).join('');
	return `${own}<li>read · write · edit · bash <b>·drive</b></li>`;
}

function agentCard(seat) {
	const name = seat.name;
	const mine = acts.filter((a) => a.agent === name);
	const api = run.toolCalls.filter((c) => c.app === name);
	const drive = mine.flatMap((a) => a.tools).filter((t) => WORKSPACE_TOOLS.has(t)).length;
	const msgs = agentSaid.filter((m) => m.from === name).length;
	const tools = [...new Set(api.map((c) => c.tool))];
	const isReserve = RESERVE.has(name) || seatings.some((m) => m.subject === name);
	const isAssistant = name === ASSISTANT;
	const where = seatWhere(seat, isReserve, isAssistant);
	const identity = seat.identity;
	const head = identity.split('. ')[0];
	const rest = identity.slice(head.length + 2);
	const cost = mine.reduce((x, a) => x + (a.cost ?? 0), 0);
	const list = agentTools(tools, isAssistant);
	const foot = isAssistant
		? `${composing.length} composing · ${drafting.length} drafting · ${money(cost)}`
		: `${api.length} API calls · ${drive} drive calls · ${mine.length} activations · ${msgs} messages · ${money(cost)}`;
	return `<div class="app ${colour(name)}"><div class="app-h"><span class="agent">${esc(name)}</span><span class="seat">${esc(where)}</span></div><h3>${esc(head)}</h3><p>${esc(rest)}</p><ul class="api">${list}</ul><div class="app-f">${foot}</div></div>`;
}

function personCard(p) {
	const written = summaries.filter((s) => s.to === p.name).length;
	const role = p.identity.split(',')[0].split('.')[0];
	return `<div class="person"><span class="nm">${esc(p.name)}</span><span class="rl2">${esc(role)}</span><p>${esc(p.identity)}</p><div class="aide"><span class="rl">preferences · read by the assistant alone</span><p>${esc(p.preferences ?? '').trim()}</p></div><div class="acts">${written} message${written === 1 ? '' : 's'} written for ${esc(p.name)}</div></div>`;
}

const PRESENCE_VERB = { arrived: 'opened the room', left: 'left', unseated: 'unseated' };

function presenceLine(m) {
	const verb =
		m.kind === 'seated' ? `seated by ${m.from ? esc(m.from) : 'the host'}` : PRESENCE_VERB[m.kind];
	const cls = m.kind === 'left' ? 'away' : m.kind;
	return `<li class="pres p-${cls}"><span class="seq">${m.seq}</span><div class="body"><span class="dot"></span>${esc(m.subject)} ${verb}</div></li>`;
}

function whoLine(m) {
	const to = m.to ? `<span class="to">→ ${esc(m.to)}</span>` : '';
	const cls = PEOPLE.has(m.from) ? 'person' : `app ${colour(m.from)}`;
	return `<div class="who ${cls}">${esc(m.from)}${to}</div>`;
}

function recordLine(m, cls = '') {
	if (m.kind === 'summary') {
		return `<li class="sum"><span class="seq">${m.seq}</span><div class="body"><div class="who app c-aide">∎ ${esc(m.from)}<span class="to">→ ${esc(m.to)} · covers ${m.covers.from}–${m.covers.through}</span></div><div class="text">${esc(m.text)}</div></div></li>`;
	}
	if (m.kind !== 'said') return presenceLine(m);
	return `<li class="msg ${cls}"><span class="seq">${m.seq}</span><div class="body">${whoLine(m)}<div class="text">${esc(m.text)}</div></div></li>`;
}

function exchangeMeta(x, inside, summary) {
	const agentMsgs = inside.filter((m) => m.kind === 'said' && !PEOPLE.has(m.from)).length;
	const seated = inside.filter((m) => m.kind === 'seated').map((m) => m.from);
	const who = seated.length ? `seated ${seated.join(', ')}` : 'nobody seated';
	const wrote = summary
		? `summary [${summary.seq}] covers ${summary.covers.from}–${summary.covers.through}`
		: 'no summary';
	return `[${x.from}] · ${agentMsgs} agent messages · ${who} · ${wrote}`;
}

function answerHtml(summary) {
	if (!summary) {
		return '<div class="answer"><div class="who">no summary<span class="to">the room answered once, or not at all</span></div></div>';
	}
	return `<div class="answer"><div class="who">∎ ${esc(summary.from)}<span class="to">→ ${esc(summary.to)} · ${words(summary.text)} words</span></div><div class="text">${esc(summary.text)}</div></div>`;
}

function exchanges() {
	return closed
		.map((x) => {
			const q = record.find((m) => m.seq === x.from);
			const inside = record.filter((m) => m.seq > x.from && m.seq <= x.through);
			const summary = summaries.find(
				(s) => s.to === x.owner && s.covers.from === x.from && s.covers.through === x.through,
			);
			return `<div class="exchange"><div class="xh"><span class="nm">${esc(x.owner)} asked</span><span class="sm">${esc(exchangeMeta(x, inside, summary))}</span></div><p class="q">${esc(q?.text ?? '')}</p><details class="working"><summary>the working the room did — ${inside.length} messages</summary><ul class="record">${inside.map((m) => recordLine(m, 'fold')).join('')}</ul></details>${answerHtml(summary)}</div>`;
		})
		.join('');
}

/** What one activation did, in a word. */
function whatDid(agent, a) {
	if (agent === ASSISTANT && a.tools.includes('seat')) return 'seated';
	if (agent === ASSISTANT && a.tools.includes('summarise')) return 'wrote';
	return a.spoke ? 'spoke' : 'stayed quiet';
}

function laneCell(agent, seq) {
	const a = acts.find((x) => x.agent === agent && x.trigger === seq);
	if (!a) return '<i class="a-none"></i>';
	const kind = a.spoke ? 'a-spoke' : 'a-idle';
	return `<i class="${kind}" title="${esc(agent)} woke on message ${seq} (${esc(a.triggerFrom)}) — ${whatDid(agent, a)}, ${money(a.cost ?? 0)}"></i>`;
}

function lanes() {
	const seqs = record.map((m) => m.seq);
	const agents = run.seats
		.filter((s) => s.kind === 'agent' && s.name !== ASSISTANT)
		.map((s) => s.name);
	agents.push(ASSISTANT);
	return agents
		.map((agent) => {
			const cells = seqs.map((seq) => laneCell(agent, seq)).join('');
			return `<div class="lane${agent === ASSISTANT ? ' aide' : ''}"><span class="lbl">${esc(agent)}</span><div class="cells">${cells}</div></div>`;
		})
		.join('');
}

function userTurn(t, tn) {
	const text = typeof t.content === 'string' ? t.content : JSON.stringify(t.content);
	const steer = text.startsWith('[new] ');
	const label = steer ? 'steered in mid-turn' : 'the context the room handed it';
	return `<details class="turn ${steer ? 'steer' : 'ctx'}"><summary>${tn}${label}<span class="len">${n(text.length)} chars</span></summary><pre>${esc(text)}</pre></details>`;
}

function contentPart(c, tn) {
	if (c.type === 'thinking')
		return `<div class="turn think">${tn}<span class="rl">said to itself</span><div>${esc(c.thinking)}</div></div>`;
	if (c.type === 'text' && c.text.trim())
		return `<div class="turn think">${tn}<span class="rl">said to itself</span><div>${esc(c.text)}</div></div>`;
	if (c.type !== 'toolCall') return '';
	const where = WORKSPACE_TOOLS.has(c.name) ? ' <em>on the drive</em>' : '';
	return `<div class="turn call">${tn}<span class="rl">calls${where}</span><code>${esc(c.name)}</code><pre class="args">${esc(JSON.stringify(c.arguments, null, 2))}</pre></div>`;
}

function metaTurn(t, tn) {
	const u = t.usage ?? {};
	const odd = t.stopReason && t.stopReason !== 'stop' && t.stopReason !== 'toolUse';
	const stop = odd ? ` · ${esc(t.stopReason)}` : '';
	return `<div class="turn tmeta">${tn}<span class="sm">${n(u.input ?? 0)} in · ${n(u.output ?? 0)} out · ${n(u.cacheRead ?? 0)} cached · ${money(u.cost?.total ?? 0)}${stop}</span></div>`;
}

function resultTurn(t, tn) {
	const text = (t.content ?? [])
		.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
		.join('\n');
	const bad = t.isError ? ' bad' : '';
	return `<div class="turn res${bad}">${tn}<span class="rl">${esc(t.toolName)} returned${t.isError ? ' an error' : ''}</span><pre class="mini">${esc(text)}</pre></div>`;
}

function turnHtml(t, i) {
	const tn = `<span class="tn">${i}</span>`;
	if (t.role === 'user') return userTurn(t, tn);
	if (t.role === 'assistant') {
		return (t.content ?? []).map((c) => contentPart(c, tn)).join('') + metaTurn(t, tn);
	}
	if (t.role === 'toolResult') return resultTurn(t, tn);
	return '';
}

/** What woke this activation, as the summary line says it. */
function triggerText(a) {
	if (!a) return 'activation';
	const kind =
		a.trigger === 0 ? 'opened the room' : (record.find((m) => m.seq === a.trigger)?.kind ?? '');
	return `woke on <b>[${a.trigger}]</b> ${esc(a.triggerFrom)} ${kind}`;
}

/** The outcome pill: what the seat did, or what the assistant did. */
function outcomePill(agent, a) {
	if (agent === ASSISTANT && a?.tools.includes('seat'))
		return '<span class="pill spoke">seated</span>';
	if (agent === ASSISTANT && a?.tools.includes('summarise'))
		return '<span class="pill spoke">wrote</span>';
	return a?.spoke
		? '<span class="pill spoke">spoke</span>'
		: '<span class="pill idle">stayed quiet</span>';
}

function activationBlock(s, b, i, a) {
	const u = usageOf(b.turns);
	return `<details class="act"><summary><span class="n">#${i + 1}</span> ${triggerText(a)} ${outcomePill(s.agent, a)}<span class="sm">${u.calls} turns · ${n(u.tokens)} tok · ${money(u.cost)}</span></summary>${b.turns.map((t, j) => turnHtml(t, j + 1)).join('')}</details>`;
}

function seatSessions() {
	const order = [...run.seatSessions].sort((a, b) =>
		a.kind === b.kind ? 0 : a.kind === 'assistant' ? 1 : -1,
	);
	return order
		.map((s) => {
			const mine = acts.filter((a) => a.agent === s.agent);
			const cost = mine.reduce((x, a) => x + (a.cost ?? 0), 0);
			const blocks = s.blocks.map((b, i) => activationBlock(s, b, i, mine[i])).join('');
			return `<details class="seat"><summary><span class="${colour(s.agent)}">${esc(s.agent)}</span><span class="sm">${esc(s.sessionId)} · ${s.blocks.length} activations · ${money(cost)}</span></summary>${blocks}</details>`;
		})
		.join('');
}

function writes() {
	const rows = run.toolCalls.filter((c) =>
		[
			'update_task',
			'move_delivery',
			'request_overtime',
			'request_inspection',
			'move_hire',
		].includes(c.tool),
	);
	return `<div class="tw"><table><thead><tr><th>Product</th><th>Call</th><th>Arguments</th><th>Result</th></tr></thead><tbody>${rows.map((c) => `<tr><td class="tid ${colour(c.app)}">${esc(c.app)}</td><td class="tid">${esc(c.tool)}</td><td class="api-cell">${esc(JSON.stringify(c.params))}</td><td class="api-cell">${esc(c.result)}</td></tr>`).join('')}</tbody></table></div>`;
}

function diary() {
	const after = run.drive.after
		.filter((f) => f.path.includes('/diary/'))
		.map(
			(f) =>
				`<h3 style="font:600 .95rem/1.4 Spectral,serif;margin:1rem 0 .3rem">${esc(f.path)}</h3><pre class="mini" style="white-space:pre-wrap">${esc(f.text.trim())}</pre>`,
		)
		.join('');
	return after;
}

// -- the findings: composed from the numbers, with the prose written for this run ----
const seatedBy = seatings
	.map((m) => `${m.subject} at [${m.seq}]${m.from ? ` by ${m.from}` : ''}`)
	.join(', ');
const firstCtx = (() => {
	const s = sessionOf(seatActs[0]?.agent);
	return s ? contextOf(s.blocks[0]).length : 0;
})();
const lastSeatAct = seatActs.at(-1);
const lastCtxLen =
	lastSeatAct && sessionOf(lastSeatAct.agent)
		? contextOf(sessionOf(lastSeatAct.agent).blocks[lastSeatAct.block]).length
		: 0;
const avgWords = summaries.length
	? Math.round(summaries.reduce((a, s) => a + words(s.text), 0) / summaries.length)
	: 0;

// -- the crash: what the dead run held, and what the resumed run did with it ---------
const crash = run.crash ?? { at: 0, time: run.ranAt, leaseExpiry: 0 };
const crashTime = Date.parse(crash.time);
const log = run.journal;
const rowsOf = (kind) => rows(log, kind);
const leaseRows = rowsOf('lease');
/** The runs that wrote the log, in order: every row carries the run that wrote it. */
const runs = rowsOf('run');
const leases = foldLeases(log);
const expiredLeases = leases.filter((l) => l.phase === 'ended' && l.reason === 'expired');
const abandoned = leases.filter((l) => l.phase === 'ended' && l.reason === 'abandoned');
const heldAtCrash = leases.filter(
	(l) =>
		Date.parse(l.claimedAt) <= crashTime && (l.phase === 'running' || Date.parse(l.at) > crashTime),
);
const resentActs = acts.filter(
	(a) => a.trigger <= crash.at && a.trigger > 0 && Date.parse(a.startedAt) > crashTime,
);
const retried = leases.filter((l) => (attemptOf(l.id) ?? 0) > 1);
const invalidLeaseIds = leases.filter((l) => l.invalidId);
const logProblems = invalidRows(log);
const crashMessage = record.find((m) => m.seq === crash.at);
const crashExchange = closed.find((x) => x.from <= crash.at && x.through >= crash.at);
const crashSummary = crashExchange
	? summaries.find(
			(s) =>
				s.to === crashExchange.owner &&
				s.covers.from === crashExchange.from &&
				s.covers.through === crashExchange.through,
		)
	: undefined;
const crashRecorded = Number.isInteger(crash.at) && crash.at > 0 && Number.isFinite(crashTime);
const resumed = runs.length > 1;
const crossed = leases.filter((lease) => lease.crossed);
const allHeldExpired =
	heldAtCrash.length > 0 &&
	heldAtCrash.every((lease) => lease.phase === 'ended' && lease.reason === 'expired');
const crashEvidence = crashRecorded && resumed && heldAtCrash.length > 0;
const recoveryEvidence = crashEvidence && crossed.length > 0 && crashSummary !== undefined;
const afterCrash = run.timeline.filter((t) => Date.parse(t.at) > crashTime);
const firstAfter = afterCrash.slice(0, 6).map((t) => {
	const e = t.event;
	if (e.type === 'message') return `[${e.message.seq}] ${e.message.from} ${e.message.kind}`;
	if (e.type === 'activation_start') return `${e.agent} woke`;
	if (e.type === 'activation_end') return `${e.agent} ended${e.spoke ? ', having spoken' : ''}`;
	if (e.type === 'error') return `${e.agent}: ${e.error.message}`;
	return e.type.replaceAll('_', ' ');
});
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

function leaseTable() {
	const rows = heldAtCrash
		.map((l) => {
			const ended =
				l.phase === 'ended'
					? `${l.reason} at +${seconds(Date.parse(l.at) - crashTime)}`
					: 'still running';
			const by = l.endedBy;
			return `<tr><td class="tid">${esc(l.id)}</td><td>${esc(l.claimedAt.slice(11, 23))}</td><td>[${l.readThrough}]</td><td>${esc(ended)}</td><td>${esc(by)}</td></tr>`;
		})
		.join('');
	return `<div class="tw"><table><thead><tr><th>Lease</th><th>Claimed at</th><th>Read through</th><th>How it ended, after the crash</th><th>Last row written by</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

const ranAt = new Date(run.ranAt);
const dateLine = ranAt.toLocaleDateString('en-GB', {
	day: 'numeric',
	month: 'long',
	year: 'numeric',
});

const seatedByAssistant = seatings.filter((m) => m.from === ASSISTANT);
const byQuestion = closed
	.map((x) => ({
		x,
		seated: seatedByAssistant.filter((m) => m.seq > x.from && m.seq <= x.through),
	}))
	.filter((q) => q.seated.length);

const crashLead = crashEvidence
	? `The capture records the runtime drop at message [${crash.at}]: ${plural(heldAtCrash.length, 'lease was', 'leases were')} live across it. ${resumed ? `${plural(resentActs.length, 'wake', 'wakes')} resumed after the second run took the journal name.` : 'No second run is recorded.'} ${allHeldExpired ? `All ${plural(heldAtCrash.length, 'lease', 'leases')} ended as expired.` : 'The captured leases do not all end as expiry, so the report leaves their outcomes explicit below.'}`
	: 'The capture does not contain enough evidence for a crash-and-resume claim; the recorded rows and activations remain below for inspection.';

const html = `<meta charset="utf-8">
<title>The Room Comes Back</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Spectral:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>${css}
:root{--c-inspect:#7a3d8a;--c-plant:#1f7a7a;--c-tw:#8a5a20}
@media (prefers-color-scheme: dark){ :root:not([data-theme="light"]){--c-inspect:#cf9be0;--c-plant:#6fd0d0;--c-tw:#dfae62} }
:root[data-theme="dark"]{--c-inspect:#cf9be0;--c-plant:#6fd0d0;--c-tw:#dfae62}
.c-inspect{color:var(--c-inspect)} .c-plant{color:var(--c-plant)} .c-tw{color:var(--c-tw)}
.alanes .lane:nth-child(6){color:var(--ink)}
.record li.pres.p-seated .dot{background:var(--add)} .record li.pres.p-unseated .dot{background:var(--absent)}
ul.plain{margin:.4rem 0 0 1.2rem;padding:0;color:var(--dim);max-width:45rem} ul.plain li{margin:.3rem 0}
.alanes .lane:nth-child(4),.alanes .lane:nth-child(5){color:var(--ink)}
</style>
<main>
<p class="meta">Ambion demo · ${esc(dateLine)} · ${esc(run.model)} · room &lsquo;${esc(run.name)}&rsquo; · workspace &lsquo;${esc(run.drive.workspace)}&rsquo;</p>
<h1>The Room Comes Back</h1>
<p class="lede">${esc(crashLead)} ${recoveryEvidence ? `The exact closed exchange has a matching summary for ${esc(crashSummary.to)}, covering [${crashSummary.covers.from}]–[${crashSummary.covers.through}].` : 'No exact summary match is present for the crash exchange.'} ${questions.length} questions opened ${closed.length} exchanges, and ${summaries.length} summaries were written.</p>
<div class="stats">${stat(questions.length, 'questions asked')}${stat(agentSaid.length, 'agent messages')}${stat(summaries.length, 'summaries written')}${stat(run.reserve.length, 'specialists on call')}${stat(seatings.filter((m) => m.from === ASSISTANT).length, 'seated by the assistant')}${stat(composing.length, 'composing activations')}</div>
<div class="stats">${stat(seatActs.length, 'seat activations')}${stat(conflicts, 'says the lock refused')}${stat(leaseExpiryErrors, 'expected lease-expiry events')}${stat(otherErrors, 'other error events')}${stat(run.toolCalls.length, 'calls into the products&rsquo; APIs')}${stat(n(totalTokens), 'tokens across every turn')}${stat(money(totalCost), 'total model cost')}</div>
<p class="note">Every line is verbatim from one live run. The people were scripted only in when they arrived, what they asked, and when they left. Nobody scripted the seatings: ${esc(seatedBy || 'none recorded')} ${logProblems.length || invalidLeaseIds.length ? `The capture has ${logProblems.length + invalidLeaseIds.length} invalid journal or activation-id finding${logProblems.length + invalidLeaseIds.length === 1 ? '' : 's'}.` : 'The native journal and activation ids validated successfully.'}</p>

<section>
<h2>The suite, the specialists on call, and the seat that composes the room</h2>
<p class="note">Three products seated for the run, each with its own state and its own API, connected to the site drive. ${run.reserve.length} specialists in the reserve, which the assistant reads at the open of an exchange and nobody else reads at all. And the assistant, seated at the narrow end of attention, holding one tool of the runtime&rsquo;s per activation: <code>seat</code> at an open, <code>summarise</code> at a close. Calls marked <b>·drive</b> reach the workspace.</p>
<div class="apps">${run.seatsAtStart
	.filter((s) => s.kind === 'agent' && s.name !== ASSISTANT)
	.map(agentCard)
	.join(
		'',
	)}${run.reserve.map((r) => agentCard({ name: r.name, identity: r.identity, kind: 'agent' })).join('')}${agentCard(run.seats.find((s) => s.name === ASSISTANT))}</div>
</section>

<section>
<h2>The people, and how each of them reads</h2>
<p class="note">An identity is the public face: what a person owns, and what only they can do. Every seat reads it. How a person reads lives on the person, and the assistant reads it in the one activation where it writes for them.</p>
<div class="people">${run.people.map(personCard).join('')}</div>
</section>

<section>
<h2>What the run did</h2>
<ol class="steps">${run.steps.map((s, i) => `<li><span class="n">${i + 1}</span><span>${esc(s.step)}</span></li>`).join('')}</ol>
</section>

<section>
<h2>The crash, and what the log held</h2>
<p class="note">The room reconstructs durable state from the native journal: the roster, people, exchange, leases and pending wakes are folds over its entries. ${crashEvidence ? `The capture records the crash at <b>[${crash.at}]</b>${crashMessage ? `, after ${esc(crashMessage.from)}&rsquo;s message` : ''}; the leases live at that boundary are below. Their <code>readThrough</code> values are the acknowledgement positions, and each row&rsquo;s envelope identifies the run that wrote it.` : 'This capture does not record a complete crash boundary; the lease rows below are evidence only, without a crash conclusion.'} ${plural(runs.length, 'run', 'runs')} took the journal name. ${logProblems.length ? `${plural(logProblems.length, 'journal row is', 'journal rows are')} invalid; affected metrics are incomplete.` : ''}</p>
${leaseTable()}
<p class="note" style="margin-top:1.4rem">What the resumed run did first, in order: ${firstAfter.map((t) => `<b>${esc(t)}</b>`).join(' · ')}.${retried.length ? ` ${plural(retried.length, 'activation', 'activations')} ran as a second attempt at a message the dead run&rsquo;s activation heard and held no lease for at the end: ${retried.map((l) => `<code>${esc(l.id)}</code>`).join(', ')}. The id says which message and which attempt, and nothing minted it: the log derives it.` : ' No activation needed a second attempt.'}</p>
</section>

<section>
<h2>Every exchange, who was seated for it, and the one message it came to</h2>
<p class="note">An exchange opens when a person asks something and closes when no agent is active, the composing assistant included. ${questions.length} questions opened ${closed.length} exchanges. Open <em>the working</em> to read what the person did not have to, and to see where a seating landed among the answers.</p>
<div class="exchanges">${exchanges()}</div>
</section>

<section>
<h2>What this change built</h2>
<p class="note"><b>The native journal is the truth.</b> This capture contains <code>message</code>, <code>lease</code>, <code>close</code>, <code>composition</code> and <code>run</code> entries. The room derives its roster, people, exchange, leases and pending work by folding those bodies in journal order; the report keeps the envelope&rsquo;s sequence, storage position and run provenance beside each body.</p>
<p class="note"><b>A run envelope fences the journal.</b> Each runtime writes a <code>run</code> entry before its later entries and the journal stamps them with that run id. The fold can therefore identify rows from the resumed runtime while the raw storage retains the complete history used for this report.</p>
<p class="note"><b>Every lease records its read boundary.</b> A message carries the seats it wakes, and an active seat acknowledges context through the lease&rsquo;s <code>readThrough</code>. Expired, failed or refused work remains an explicit outcome; only a valid four-part activation id can contribute a retry count, and malformed ids are reported as invalid evidence.</p>
<p class="note"><b>The activation id carries its provenance.</b> The room derives ids as <code>message|opened|closed:position:seat:attempt</code>. A repeated commit uses its key, while a request whose lease ended is refused by the folded room state. The report uses the captured id and envelope rows rather than inventing an id from a message.</p>
<p class="note"><b>A host owns its runtime connections.</b> The in-process demo evicts one runtime while the room&rsquo;s shared business objects and workspace remain represented by the resumed session; independent database connections provide the room and Pi transcript views. A host crossing a process boundary carries the same room calls as JSON, and the Cloudflare package maps those calls to Durable Objects.</p>
<p class="note"><b>The capture states what it proves.</b> It records ${n(log.length)} native journal rows, ${n(capturedBlocks)} downstream activation blocks and ${n(sessionTotals.calls)} model responses. Those observed counts, the crash boundary, lease outcomes and exact summary range are the evidence on this page; missing or malformed fields remain findings instead of being treated as success.</p>
</section>

<section>
<h2>Every captured activation, and what it decided</h2>
<p class="note">One column per message on the record, one lane per seat, and one for the assistant. A filled mark is a seat that woke and left a mark on the record: a say, a seating, or a summary. A hollow mark is one that woke and left none. The two specialist lanes are empty until the seating that woke them. The lock refused ${conflicts} says.</p>
<div class="band alanes">${lanes()}</div>
</section>

<section>
<h2>Inside each seat&rsquo;s own session, and the assistant&rsquo;s</h2>
<p class="note">Every activation&rsquo;s full turns are kept in a downstream session, <code>&lt;room&gt;:&lt;agent&gt;</code>. Every one of them is below, complete: the context the room handed it, its reasoning, every call with the arguments it passed, everything that came back, and every say the lock refused. The assistant&rsquo;s session holds its composing activations and its drafts alike; the composing ones show the reserve as the second roster the assistant read.</p>
${seatSessions()}
</section>

<section>
<h2>What the products changed</h2>
<p class="note">The record is what was said; a product that establishes something durable writes it into its own state in the same turn, and into the diary. The two specialists write too, once seated.</p>
${writes()}
<p class="note" style="margin-top:1.4rem">The site diary as the run left it:</p>
${diary()}
</section>

<section>
<h2>The record</h2>
<p class="note">Every message, in order. The ones marked <b>∎</b> are the summaries, each with the range it stands for; the shaded rows above each one are the messages that range holds. A seating sits among the answers as an aside, stamped with who did it.</p>
<ul class="record">${record.map((m) => recordLine(m, summaries.some((s) => m.seq >= s.covers.from && m.seq <= s.covers.through) ? 'fold' : '')).join('')}</ul>
</section>

<section>
<h2>What the run showed</h2>
<div class="findings">
<div class="finding"><h3>${crashEvidence ? 'A recorded crash and its lease outcomes' : 'The capture has no complete crash finding'}</h3><p>${crashEvidence ? `The runtime boundary is evidenced at [${crash.at}] with ${plural(heldAtCrash.length, 'lease', 'leases')} live. ${crossed.length ? `${plural(crossed.length, 'lease crossed', 'leases crossed')} the run fence.` : 'No lease has writer provenance on both sides of a run fence.'} ${crashSummary ? `An exact summary covers [${crashSummary.covers.from}]–[${crashSummary.covers.through}] for ${esc(crashSummary.to)}.` : 'No exact summary for the closed exchange is recorded.'}` : 'The report cannot infer a crash, recovery, or success from the available rows. Inspect the captured journal and timeline below.'}</p></div>
<div class="finding"><h3>Expiry, refusal, and real errors are separate outcomes</h3><p>${plural(expiredLeases.length, 'lease', 'leases')} ended as expired and ${plural(abandoned.length, 'lease', 'leases')} as abandoned. The room recorded ${plural(conflicts, 'refused say', 'refused says')} as lock conflicts; these are expected refusal outcomes. ${leaseExpiryErrors ? `${plural(leaseExpiryErrors, 'error event is', 'error events are')} the expected lease-expiry notification.` : 'No lease-expiry notification was emitted.'} ${otherErrors ? `${plural(otherErrors, 'other error event requires', 'other error events require')} inspection as failures; the report does not fold them into the crash proof.` : 'No other error events were emitted in the captured timeline.'} ${retried.length ? `${plural(retried.length, 'activation', 'activations')} carry an attempt greater than one.` : 'No valid activation id carries an attempt greater than one.'} ${invalidLeaseIds.length ? `${plural(invalidLeaseIds.length, 'lease id is', 'lease ids are')} malformed and excluded from retry claims.` : ''}</p></div>
<div class="finding"><h3>What this capture contains</h3><p>${plural(seatActs.length, 'seat activation', 'seat activations')} and ${plural(assistantActs.length, 'assistant activation', 'assistant activations')} were captured, with ${money(totalCost)} in model cost across ${n(sessionTotals.calls)} model responses. The room&rsquo;s log holds ${n(log.length)} native rows beside ${record.length} messages: ${plural(leaseRows.length, 'lease row', 'lease rows')}, ${plural(rowsOf('close').length, 'close', 'closes')}, and ${plural(runs.length, 'run row', 'run rows')}. ${unmatchedBlocks || unmatchedActivations ? `${unmatchedBlocks} session block${unmatchedBlocks === 1 ? '' : 's'} and ${unmatchedActivations} activation${unmatchedActivations === 1 ? '' : 's'} could not be paired.` : 'Every captured activation has a corresponding session block.'}</p></div>
<div class="finding"><h3>What the assistant did</h3><p>It composed the room ${times(composing.length)} and seated ${plural(seatedByAssistant.length, 'specialist', 'specialists')}: ${byQuestion.map((q) => `${q.seated.map((m) => `<b>${esc(m.subject)}</b>`).join(' and ')} for ${esc(q.x.owner)}&rsquo;s question at [${q.x.from}]`).join('; ') || 'no assistant seating was recorded'}. It wrote ${summaries.length} summaries, ${avgWords} words on average. The first captured seat context had ${n(firstCtx)} characters; the last had ${n(lastCtxLen)}.</p></div>
</div>
</section>
</main>
`;

writeFileSync(outPath, html);
console.error(`wrote ${outPath}: ${n(html.length)} bytes`);
