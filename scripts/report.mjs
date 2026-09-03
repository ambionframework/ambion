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

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
	console.error('usage: node scripts/report.mjs <demo-run.json> <out.html>');
	process.exit(2);
}
const run = JSON.parse(readFileSync(inPath, 'utf8'));
const css = readFileSync(new URL('./report.css', import.meta.url), 'utf8');

const esc = (s) =>
	String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#x27;');
const n = (x) => x.toLocaleString('en-GB');
const money = (x) => `$${x.toFixed(2)}`;
const words = (t) => t.trim().split(/\s+/).length;

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
const composeCosts = composing.map((a) => a.cost ?? 0);
const composeCost = composeCosts.reduce((a, b) => a + b, 0);
const newcomerActs = seatActs.filter((a) => seatings.some((m) => m.from === a.agent));
const newcomerMsgs = agentSaid.filter((m) => seatings.some((s) => s.from === m.from));
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

const ranAt = new Date(run.ranAt);
const dateLine = ranAt.toLocaleDateString('en-GB', {
	day: 'numeric',
	month: 'long',
	year: 'numeric',
});

const seatedByAssistant = seatings.filter((m) => m.by === ASSISTANT);
const leftAlone = composing.filter((a) => !a.tools.includes('seat'));
const emptied = seatedByAssistant.length === run.reserve.length;
const byQuestion = closed
	.map((x) => ({
		x,
		seated: seatedByAssistant.filter((m) => m.seq > x.from && m.seq <= x.through),
	}))
	.filter((q) => q.seated.length);
const neverSeated = run.reserve
	.filter((r) => !seatings.some((m) => m.from === r.name))
	.map((r) => r.name);
const composingList = composing
	.map((a) => {
		const q = record.find((m) => m.seq === a.trigger);
		const seatedHere = seatings.filter(
			(m) =>
				m.seq > a.trigger &&
				m.seq <= (closed.find((x) => x.from === a.trigger)?.through ?? Infinity) &&
				m.by === ASSISTANT,
		);
		return `<li><b>[${a.trigger}] ${esc(a.triggerFrom)}:</b> “${esc(q?.text ?? '')}” — ${seatedHere.length ? `seated <b>${seatedHere.map((m) => esc(m.from)).join('</b> and <b>')}</b>` : 'left the roster as it stood'} · ${money(a.cost ?? 0)}</li>`;
	})
	.join('');

const html = `<meta charset="utf-8">
<title>Who the Question Needs</title>
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
<h1>Who the Question Needs</h1>
<p class="lede">The same construction suite and the same three people, and the room now holds ${run.reserve.length} specialists on call in a reserve: a building control liaison, the plant desk and the temporary works coordinator. When a question opens an exchange, the assistant reads it beside the seated products and seats every specialist whose identity touches it: a seated specialist with nothing to add stays quiet for the price of a glance, and one that was never seated costs the answer. ${questions.length} questions opened ${closed.length} exchanges. The assistant composed the room ${composing.length} times and seated ${seatedByAssistant.length} specialists${leftAlone.length ? `, leaving the roster alone ${leftAlone.length} times` : ''}${emptied ? `; once the reserve was empty, the ${questions.length - composing.length} later questions woke it no more` : ''}. Each newcomer woke on its own seating, read the room as it stood, and answered beside the products.</p>
<div class="stats">${stat(questions.length, 'questions asked')}${stat(agentSaid.length, 'agent messages')}${stat(summaries.length, 'summaries written')}${stat(run.reserve.length, 'specialists on call')}${stat(seatings.filter((m) => m.by === ASSISTANT).length, 'seated by the assistant')}${stat(composing.length, 'composing activations')}</div>
<div class="stats">${stat(seatActs.length, 'seat activations')}${stat(conflicts, 'says the lock refused')}${stat(errors, 'tool or model failures')}${stat(run.toolCalls.length, 'calls into the products&rsquo; APIs')}${stat(n(totalTokens), 'tokens across every turn')}${stat(money(totalCost), 'total model cost')}</div>
<p class="note">Every line is verbatim from one live run, the first on this branch. The people were scripted only in when they arrived, what they asked, and when they left. Nobody scripted the seatings: ${esc(seatedBy)}.</p>

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
<h2>Every exchange, who was seated for it, and the one message it came to</h2>
<p class="note">An exchange opens when a person asks something and closes when no agent is active, the composing assistant included. ${questions.length} questions opened ${closed.length} exchanges. Open <em>the working</em> to read what the person did not have to, and to see where a seating landed among the answers.</p>
<div class="exchanges">${exchanges()}</div>
</section>

<section>
<h2>What this change built</h2>
<p class="note"><b>A reserve on <code>startSession</code>.</b> <code>available</code> holds agents the room does not seat now. Both lists hold the same <code>AgentSeat</code> values, so a reserve entry carries an attention, and the room refuses a name in both. <code>agents</code> is optional, so a room can start with the assistant alone. The reserve is a value the host wrote: nothing discovers agents, and the assistant can never define one.</p>
<p class="note"><b>The assistant bookends the exchange.</b> The open of an exchange wakes it when the reserve holds anybody, in parallel with the seats, and hands it <code>seat</code> bound to the reserve. The close hands it <code>summarise</code>, as before. In this run it composed ${composing.length} times, for ${money(composeCost)} in total:</p>
<ul class="plain">${composingList}</ul>
<p class="note"><b>Seating is a presence message.</b> <code>seated</code> and <code>unseated</code> join <code>arrived</code> and <code>left</code>, with <code>by</code> naming the assistant when it did the seating. Every rule of the core applies unchanged, and two change: the routing excludes a message&rsquo;s author and wakes the seat it names, and a seat the message names wakes at any attention. A seating is the one message whose author and subject differ, and the one activation the assistant can cause.</p>
<p class="note"><b>A composing activation is the room working.</b> <code>settled()</code> leaves a drafting assistant out, so a close cannot hold open the exchange it is closing, and counts a composing one in, so the exchange stays open until the assistant has decided. ${newcomerMsgs.length ? `The ${newcomerActs.length} newcomer activations in this run all fell inside the exchange that seated them, and the summaries cover what they said.` : ''}</p>
<p class="note"><b>Nothing said while the assistant decides reaches it.</b> A composing activation is one pass, and the room steers nothing into it. The run before this one showed why: the assistant was handed the products&rsquo; answers as <code>[new]</code> lines mid-decision, weighed them, tried to seat a specialist that was already in the room, and drafted a close it had no hand to deliver. It now reads the question and the reserve, seats or ends its turn, and the seats&rsquo; answers are theirs.</p>
<p class="note"><b>A seating commits outside the lock.</b> The first draft of this branch committed a seating under rule 5&rsquo;s lock, and the tests showed why that cannot hold: a product that answers before the assistant decides moves the record, the seating is refused, and the assistant spends a turn reconsidering a decision the answer rarely changes. The assistant decides on the question; the newcomer reads the answers when it wakes and declines when the point stands.</p>
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
<div class="finding"><h3>The assistant seated everyone the question touched${leftAlone.length ? ', and left the roster alone when nobody was' : ', and nothing paid for the reserve once it was empty'}</h3><p>${composing.length} questions opened with agents in reserve, and the assistant composed the room ${composing.length} times: ${seatedByAssistant.length} seatings${leftAlone.length ? ` and ${leftAlone.length} decisions to seat nobody` : ''}. ${byQuestion.map((q) => `${q.seated.map((m) => `<b>${esc(m.from)}</b>`).join(' and ')} for ${esc(q.x.owner)}&rsquo;s question at [${q.x.from}]`).join('; ')}.${emptied ? ` That emptied the reserve, so the ${questions.length - composing.length} questions after it woke no composing activation: an empty reserve costs the room nothing.` : ''}${neverSeated.length ? ` ${neverSeated.map(esc).join(', ')} stayed in the reserve for the whole run: no question turned on what it holds, and nothing paid for it.` : ''} Every seating is on the record, stamped <code>by: assistant</code>, and every newcomer&rsquo;s first activation was the seating itself: it read the question and the answers so far, and spoke from its own API.</p></div>
<div class="finding"><h3>What composition cost</h3><p>${composing.length} composing activations cost ${money(composeCost)} between them, against ${money(totalCost)} for the run. A composing activation reads the same context a seat reads plus the reserve, and ends in one turn when it seats nobody. Each seated specialist then costs what any seat costs for the rest of the run: ${newcomerActs.length} activations and ${newcomerMsgs.length} messages from the ${seatedByAssistant.length} seated here. The lock refused ${conflicts} says, against 14 in the run before this branch: ${seatedByAssistant.length} more seats answering in parallel is ${seatedByAssistant.length} more seats racing, and the lock is what keeps a point from reaching the record twice.</p></div>
<div class="finding"><h3>One exchange, one message, with the newcomers inside it</h3><p>${summaries.length} summaries were written, ${avgWords} words on average. Because a composing activation counts as the room working, no exchange closed before the assistant had decided, and the ranges the summaries cover hold the seatings and what the seated specialists said.</p></div>
<div class="finding"><h3>What four runs before this one changed</h3><p>The first run put two specialists in reserve and the assistant seated both on the first question, so no later exchange showed it choosing to seat nobody; a third specialist, the temporary works coordinator, went into the reserve to give the later questions a real choice. The second run had seats comparing site dates with the clock at the top of their context, calling a forecast and two deliveries stale, and one summary opening with the room&rsquo;s date; the goal now says the clock is the room&rsquo;s own and Tue 25 Aug is today. The third run steered the products&rsquo; answers into the composing activation, and the runtime now keeps them out. The fourth run asked the assistant to seat only what a question turned on, and it left a specialist out that had something to add; the runtime now asks it to seat everyone the question touches, and the cap on seatings is the reserve itself. Each of those is a fault the tests could not have found, and a live run did.</p></div>
<div class="finding"><h3>What a seat read</h3><p>The first seat activation read ${n(firstCtx)} characters; the last read ${n(lastCtxLen)}, with the earlier exchanges folded into their summaries. The reserve appears in none of them: it renders only in the assistant&rsquo;s composing activations.</p></div>
</div>
</section>
</main>
`;

writeFileSync(outPath, html);
console.error(`wrote ${outPath}: ${n(html.length)} bytes`);
