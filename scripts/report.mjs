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
import { esc, foldLeases, plural, rowsOf as rows } from './report-log.mjs';

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
const totalCost = acts.reduce((s, a) => s + (a.cost ?? 0), 0);
const totalTokens = acts.reduce((s, a) => s + (a.tokens ?? 0), 0);
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
	const isReserve = RESERVE.has(name) || seatings.some((m) => m.from === name);
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
		m.kind === 'seated' ? `seated by ${m.by ? esc(m.by) : 'the host'}` : PRESENCE_VERB[m.kind];
	const cls = m.kind === 'left' ? 'away' : m.kind;
	return `<li class="pres p-${cls}"><span class="seq">${m.seq}</span><div class="body"><span class="dot"></span>${esc(m.from)} ${verb}</div></li>`;
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
				(s) => s.covers.from <= x.from && s.covers.through >= x.through,
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
	.map((m) => `${m.from} at [${m.seq}]${m.by ? ` by ${m.by}` : ''}`)
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
const log = run.log ?? [];
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
const expiredAfter = expiredLeases.length
	? Math.max(...expiredLeases.map((l) => Date.parse(l.at))) - crashTime
	: 0;
const resentActs = acts.filter(
	(a) => a.trigger <= crash.at && a.trigger > 0 && Date.parse(a.startedAt) > crashTime,
);
const retried = leases.filter((l) => /^\d+:[a-z0-9-]+:\d+$/.test(l.id));
const crashMessage = record.find((m) => m.seq === crash.at);
const crashExchange = closed.find((x) => x.from <= crash.at && x.through >= crash.at);
const crashSummary = crashExchange
	? summaries.find(
			(s) => s.covers.from <= crashExchange.from && s.covers.through >= crashExchange.through,
		)
	: undefined;
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
			return `<tr><td class="tid">${esc(l.id)}</td><td>${esc(l.claimedAt.slice(11, 23))}</td><td>[${l.heardThrough}]</td><td>${esc(ended)}</td><td>${esc(by)}</td></tr>`;
		})
		.join('');
	return `<div class="tw"><table><thead><tr><th>Lease</th><th>Claimed at</th><th>Heard through</th><th>How it ended, after the crash</th><th>Last row written by</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

const ranAt = new Date(run.ranAt);
const dateLine = ranAt.toLocaleDateString('en-GB', {
	day: 'numeric',
	month: 'long',
	year: 'numeric',
});

const seatedByAssistant = seatings.filter((m) => m.by === ASSISTANT);
const byQuestion = closed
	.map((x) => ({
		x,
		seated: seatedByAssistant.filter((m) => m.seq > x.from && m.seq <= x.through),
	}))
	.filter((q) => q.seated.length);

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
<p class="lede">The same construction suite and the same three people, and this time the process dies in the middle of a question. As the first answer to ${esc(crashMessage ? (record.find((m) => m.seq === crashExchange?.from)?.from ?? 'sam') : 'sam')}&rsquo;s question landed, at message [${crash.at}], the runtime that held the room was dropped: ${plural(heldAtCrash.length, 'lease', 'leases')} stayed on the log unreleased, and nothing was written about the crash. A second runtime resumed the name over the same log. It folded the roster, the people, the open exchange and the leases back from the rows; it sent the ${plural(resentActs.length, 'wake', 'wakes')} the dead run left unanswered again; the ${plural(heldAtCrash.length, 'lease', 'leases')} the dead run held expired on its own alarm, ${seconds(expiredAfter)} after the crash; the exchange closed; and the assistant wrote ${crashSummary ? `${esc(crashSummary.to)}` : 'nobody'} the one message${crashSummary ? `, covering [${crashSummary.covers.from}]–[${crashSummary.covers.through}], the crash inside it` : ''}. ${questions.length} questions opened ${closed.length} exchanges, and ${summaries.length} were written for, across two runtimes.</p>
<div class="stats">${stat(questions.length, 'questions asked')}${stat(agentSaid.length, 'agent messages')}${stat(summaries.length, 'summaries written')}${stat(run.reserve.length, 'specialists on call')}${stat(seatings.filter((m) => m.by === ASSISTANT).length, 'seated by the assistant')}${stat(composing.length, 'composing activations')}</div>
<div class="stats">${stat(seatActs.length, 'seat activations')}${stat(conflicts, 'says the lock refused')}${stat(errors, 'errors the room reported')}${stat(run.toolCalls.length, 'calls into the products&rsquo; APIs')}${stat(n(totalTokens), 'tokens across every turn')}${stat(money(totalCost), 'total model cost')}</div>
<p class="note">Every line is verbatim from one live run. The people were scripted only in when they arrived, what they asked, and when they left; the crash was scripted to land on the first answer to the second question, and nothing else about it was. Nobody scripted the seatings: ${esc(seatedBy)}.</p>

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
<p class="note">The room holds no fact in memory: the roster, the people, the open exchange, the leases and the wakes still pending are each a fold over the log, and a room that replays the log folds the state the room that wrote it held. The crash landed on <b>[${crash.at}]</b>${crashMessage ? `, ${esc(crashMessage.from)}&rsquo;s answer` : ''}. Every lease the dead run held is below: an activation claims a lease with an expiry of ${seconds(crash.leaseExpiry)} in this run, renews it while it runs, and each running row carries the seq the activation has taken. Nobody released these, so they ran out on the resumed room&rsquo;s alarm, and the room reported each one as an activation that ran past its lease. The last column names the run that wrote the row: ${plural(runs.length, 'run', 'runs')} took this name, and the row each run wrote first is the fence between them.</p>
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
<p class="note"><b>The log is the truth.</b> The room writes six kinds of entry to its own Pi session: <code>ambion/message</code>, <code>ambion/lease</code>, <code>ambion/close</code>, <code>ambion/composition</code>, <code>ambion/run</code> and <code>ambion/checkpoint</code>. Every fact the room used to hold in memory is now a fold over them: the roster from the composition and the seatings after it, the people from the arrivals and departures, the open exchange from the questions and the closes, the leases from their rows, and the wakes still pending from the messages and the leases together. <code>reconcile()</code> folds, decides, writes what it decided, and sends; it runs after every commit, every lease change, every alarm and every wake, and running it twice writes nothing.</p>
<p class="note"><b>A run row fences the runs.</b> Every run writes <code>ambion/run</code> before it writes anything else, and stamps every later entry with its own id. A read passes the run rows in order, and an entry of an earlier run that lands after a later run&rsquo;s row is void. That is what makes this crash safe: the dead run&rsquo;s activations were still in the process, and a write from one of them after the resume counts for nothing. A checkpoint carries the fold the rows before it made, so a resumed room reads one row in place of many.</p>
<p class="note"><b>Every message names every seat it reaches, and every lease says what it heard.</b> <code>wakes</code> on a message names the idle seats its reach wakes and every seat at work, so a message and its routing are one write. A seat at work is steered inside its running activation, and the lease records <code>heard</code>, the seq the activation has taken. A wake is answered by any lease of the seat that heard it and ran to its end. A lease that expired or failed answers nothing, whatever it said: the room wakes the seat again after a backoff, up to three attempts, the same policy the summaries had already. What the dead activation said stays on the record, and the seat reads it at the next attempt: the room prefers a seat that reads its own words twice to a question that nobody answers.</p>
<p class="note"><b>Nothing mints an id.</b> An activation is named by the message that woke it and the seat, <code>[${crash.at}]:${esc(crashMessage?.from ?? 'seat')}</code>, or by the close it answers and the attempt, <code>close:${crashExchange?.through ?? 0}:1</code>. A wake is safe to send twice, a retried commit lands once under its key, and a request from an activation whose lease ended is refused because the fold says so.</p>
<p class="note"><b>A host owns a runtime.</b> The clock, the session opener, the transport, the model call and the catalog of definitions live in a <code>Runtime</code> value; two runtimes in one process share nothing, and that is what let this run drop one and resume in another. What crosses between a seat and its room is JSON: the seat reaches the room through <code>view</code>, <code>commit</code> and <code>lease</code>, and the room reaches the seat through <code>wake</code>, so a seat and its room can live in two processes. A second package runs a room as Cloudflare Durable Objects over those calls, tested inside workerd.</p>
<p class="note"><b>The evidence is a chaos tier.</b> A scenario runs once to count the writes its log takes, then once per write, crashing the room at that write before the entry lands and again after it landed and before the room heard, and a host resumes it and retries under the same key; the same scenario runs in a child process on a JSONL storage and is killed mid-activation; and a seeded walk loses and repeats requests on the wire, fails writes before and after they land, and crashes the room up to three times. Every run must come to the same record. Three faults this branch fixed were found there and nowhere else: a message a live seat heard only through a steer that a crash lost, a write that landed while its confirmation was lost and stayed invisible until the next write, and a visit the storage refused that left the person able to speak without arriving.</p>
</section>

<section>
<h2>Every activation, and what it decided</h2>
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
<div class="finding"><h3>A crash mid-exchange lost nothing but the run</h3><p>The runtime was dropped as [${crash.at}] landed, with ${plural(heldAtCrash.length, 'lease', 'leases')} running and no <code>left</code>, no release and no close written. The second runtime folded the same roster, the same people and the same open exchange from the log, and continued it: ${resentActs.length ? `the ${plural(resentActs.length, 'wake', 'wakes')} its expired leases left unanswered ${resentActs.length === 1 ? 'was' : 'were'} sent again and answered, ` : ''}the ${plural(heldAtCrash.length, 'lease', 'leases')} it held expired ${seconds(expiredAfter)} after the crash on the resumed room&rsquo;s own alarm, and the exchange closed into ${crashSummary ? `one message for ${esc(crashSummary.to)} covering [${crashSummary.covers.from}]–[${crashSummary.covers.through}]` : 'no message'}. The people did nothing: sam&rsquo;s visit was put back with no arrival written, because the log said he was present.</p></div>
<div class="finding"><h3>What the expiry costs, and what it does not</h3><p>An activation cut by the crash holds its lease until the expiry, ${seconds(crash.leaseExpiry)} here and a minute by default, and the exchange stays open until then: that is the one delay a crash adds. What the cut activations had said before the crash stands on the record, and every one of them left the messages it heard pending, so ${retried.length ? `${plural(retried.length, 'seat took', 'seats took')} a second attempt and read their own first answer in it` : 'no seat took a second attempt'}. ${abandoned.length ? `The room wrote off ${plural(abandoned.length, 'activation', 'activations')} that came to nothing on every attempt: ${abandoned.map((l) => `<code>${esc(l.id)}</code>`).join(', ')}.` : 'Every wake the room sent was answered inside the attempts it allows, so the room wrote nothing off.'} The lock refused ${conflicts} says across both runtimes, and the record kept its shape: seqs contiguous, every key once, every summary covering the range before it.</p></div>
<div class="finding"><h3>The same room, whichever process holds it</h3><p>${plural(seatActs.length, 'seat activation', 'seat activations')} and ${plural(assistantActs.length, 'assistant activation', 'assistant activations')} ran across the two runtimes, ${money(totalCost)} in all, and each seat&rsquo;s own session holds every one of them, complete, whichever runtime ran it. The room&rsquo;s log holds ${n(log.length)} rows beside ${record.length} messages: ${plural(leaseRows.length, 'lease row', 'lease rows')}, ${plural(rowsOf('close').length, 'close', 'closes')}, ${plural(runs.length, 'run row', 'run rows')}, ${plural(rowsOf('checkpoint').length, 'checkpoint', 'checkpoints')}, and one composition. A reader of the log alone can say which activation said what, which wake each lease answered, and where the crash fell.</p></div>
<div class="finding"><h3>What the assistant did, unchanged</h3><p>It composed the room ${times(composing.length)} and seated ${plural(seatedByAssistant.length, 'specialist', 'specialists')}: ${byQuestion.map((q) => `${q.seated.map((m) => `<b>${esc(m.from)}</b>`).join(' and ')} for ${esc(q.x.owner)}&rsquo;s question at [${q.x.from}]`).join('; ')}. It wrote ${summaries.length} summaries, ${avgWords} words on average, one of them for the exchange the crash fell inside. The first seat activation read ${n(firstCtx)} characters; the last read ${n(lastCtxLen)}, with the earlier exchanges folded into their summaries.</p></div>
</div>
</section>
</main>
`;

writeFileSync(outPath, html);
console.error(`wrote ${outPath}: ${n(html.length)} bytes`);
