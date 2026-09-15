# The assistant

This document is the design contract for the assistant: the constrained agent
a room seats as its human-facing synthesis layer. Every room seats one by
convention through the `assistant` option. It reads how each
person reads and consolidates the room's work when the exchange does not
already hold one answer. It is shipped. The code lives with the rest of the
runtime in [`packages/ambion/src`](../packages/ambion/src) —
the summary a seat commits in
[`transition.ts`](../packages/ambion/src/room/transition.ts), the fold a seat reads in
[`render.ts`](../packages/ambion/src/render.ts), the shapes in
[`types.ts`](../packages/ambion/src/types.ts). Read
[`agent.md`](agent.md), [`exchange.md`](exchange.md) and
[`presence.md`](presence.md) first.

One sentence:

> **A person asks a question. Agents wake and work it out between them. If
> their work needs consolidating when the room goes quiet, the assistant writes
> that person one summary, the way they read. The human-facing view and later
> agent contexts can use it in place of the working.**

---

## 1. The problem, measured

The run in [`demos/`](../demos) is the evidence for both halves.

**A person reads a transcript where an answer should be.** Priya asked one
question: _can I tell the client Thursday for the pour?_ It woke three
products. They answered her, answered each other, corrected each other and
refined their own answers. Ten agent messages landed before she left. Four
addressed her. The room established that Thursday was impossible, why, and
what would make Saturday possible. **It never assembled that into an
answer**, because no participant has assembling as its job.

**The room re-reads all of it, for ever.** Each activation renders the
record into a seat's context. Over 25 activations that run built 148,038
characters of context, and **the record was 77% of it**. The first context
was 1,259 characters. The last was 10,081. Thirty messages did that.

One message answers both.

---

## 2. The assistant

The assistant is the room's counterpart to the people in it: one assistant
per room, seated when the room starts, writing for every person who visits.

**It is a seat.** `startRoom` seats it beside the agents, the room
activates it as it activates every other agent, its turns land in a
downstream session of its own, and a live lease authorizes its writes.
Its policy selects these tools:

- It is seated at `none`, the narrow end of the attention scale
  ([`agent.md`](agent.md) rule 6): nothing said in the room wakes it, and
  it cannot be addressed.
- The close of an exchange wakes it, for the person who owns that exchange,
  and that activation holds one tool, `summarise`, bound to the range it
  must stand for.
- The open of an exchange wakes it too, when the room holds agents in
  reserve, and that activation holds one tool, `seat`, bound to the
  reserve. [`roster.md`](roster.md) is the contract for it.

A seat carries none of that. Which seat is the assistant is on the
composition; who is owed a message is a fold over the closes, the
summaries and the leases (`foldOwed` in
[`fold.ts`](../packages/ambion/src/room/fold.ts)); what it is drafting for
now is on the id of the activation it holds (`closed:<through>:<seat>:<attempt>`).
No seat carries a field for any of it.

The assistant holds one thing nothing else in the room holds: **what a
message to a person is for**, as its instructions say it. What differs by
person is the person's own: **how they read.** What an answer has to lead
with, what to cut, and how much of one they will take is the `preferences`
field on `defineHuman`, and the assistant reads it at the one activation
where it writes for them. No other seat reads it.

Two facts about a person sit outside both. What they own and what only they
can do is their `identity`, which every seat reads and the assistant reads
with them. What they asked is a message with a seq, and a closed exchange
names the seq it started at. A preference that holds either one carries a
copy of something already in the assistant's context.

Put the reading preferences inside each product's instructions and every
product carries a copy of every person, so each new person lengthens every
product's prompt. That is a modelling error. How Priya reads belongs to
Priya, so it lives on her definition, and the one seat that reads it is the
assistant, at the moment it writes for her.

**The assistant never decides and never acts as a person.** `Visit.send`
stays the person's own act, in their own words. §12 draws that line.

The name sets the authority. The assistant writes for a person, reminds, and
says _"she will want the tonnage"_. It never runs the room and it never
answers for anyone.

---

## 3. The exchange

The unit is the **exchange**, and it belongs to the core:
[`exchange.md`](exchange.md) specifies it, and
[`exchange.ts`](../packages/ambion/src/room/exchange.ts) is where it lives. A
question, and everything the room does until it goes quiet again. A
person's question opens one; quiescence closes it; what lands in between
steers the seats already working and changes nothing.

The assistant is the first thing to read a closed exchange, and other readers
exist beside it ([`exchange.md`](exchange.md) §7). An exchange opens and
closes whether or not the assistant ends up writing anything for it — that
choice is §4's, not the exchange's.

What matters here is what the assistant makes of one:

- **It is what a summary stands for.** One exchange, one message.
- **Only a question opens one**, so arriving and leaving are never
  summarised, and a room where nobody asks anything is never summarised at
  all.
- **Quiescence is a true end.** A room that settles has finished, and will
  never restart on its own, so a summary written at the close is written
  over work that is over.

**A summary stands for one closed exchange.** The recorded close fixes its
owner and range. `from` is the question that opened it; `through` is the
last sequence included when it closed. Every attempt reads this same range.

A person who returns after two days gets a summary of their next exchange.
Presence handles what they missed (§15). Later questions open separate
exchanges, including questions from the same person. §5 defines publication.

[`exchange.md`](exchange.md) §8 records the gap underneath this: nothing
bounds how long an exchange may run.

---

## 4. One exchange, one response

The rule the design serves:

> **Every exchange resolves to at most one summary response.**

Most of the time the room may already have a direct answer. One product
answers once, and that message remains the answer. **The assistant does not
engage.** The person reads what the product said, in that product's own
words, and the seats keep reading it too. `response()` returns `undefined`
when no summary is due.

It engages when the room did not:

> **A summary is written when an exchange closes and holds more than one
> message from the agents. One message needs no consolidation.**

It counts what the room produced, and leaves what people said into it out
of the count: a second person speaking is a steer, and two people talking
to each other is nothing the assistant consolidates. And it counts messages, not
speakers. The measured run's worst moment was one product saying four
separate things to Priya, and that needs consolidating as much as three
products saying one each.

What the run shows:

| In the measured run                  |              |
| ------------------------------------ | ------------ |
| Questions asked                      | 3            |
| Exchanges that would write a summary | 3            |
| Exchanges that would pass through    | 0            |
| Agent messages inside an exchange    | **17 of 19** |
| Agent messages outside any exchange  | 2            |

**Every question in this run drew more than one answer, so the threshold
never fired.** It is a rule about a case this run does not contain, and it
is kept because the case is real: a single clean answer should reach a
person in the voice that gave it.

An exchange with no agent message writes nothing.

---

## 5. A summary publishes the result of one closed exchange

The close fixes the summary's input, recipient, and writer. A later question
can open another exchange while the assistant drafts. It does not change
that draft's range or cause a freshness conflict.
The delivery projection excludes summary activations from implicit steering,
so later messages cannot enter that draft's model context.

**The room checks authority at publication.** A summary requires a live
`closed` activation whose specification grants `summarise` for the recorded
close. Its author must be the close's
writer, its recipient must be the owner, and its range must match exactly.
The room refuses a second summary for that exchange. Retrying the same
journal key returns the original commit through journal idempotency.

**Ordinary speech still requires a current view.** A `say` must include
every preceding message in its `readThrough`. A summary answers a fixed
exchange, so publication does not compare its range with the current record.
The journal still serializes writes and checks the run fence and lease.

**Each exchange has its own outcome.** Two closed exchanges for one person
remain separate obligations. A summary or a silent completion resolves only
its own exchange. Revocation and abandonment also apply to that exchange.
A failed or expired activation leaves it owed until retry or abandonment.
The room retries after thirty seconds times the attempts made, up to three
attempts. Retries read the original range.

**Publication can follow later messages.** Rendering folds only messages
inside `covers`. Intervening messages and other summaries stay visible,
including when summaries arrive out of exchange order. A summary never
folds another summary. Existing journals can contain overlapping ranges
from older releases; the renderer continues to show their summaries.

**The exchange can close before publication.** `messages()` resolves at the
durable close with the fixed non-summary conversation in the exchange's range.
`response()` waits for the assistant's summary or returns `undefined` when the
assistant deliberately stays silent. A failed attempt keeps the source
messages visible.

---

## 6. Who owns an exchange

A room holds several people, and one assistant writes for all of them. It
writes at most one summary per exchange, to one person, and the exchange says whom
([`exchange.md`](exchange.md) §4):

> **A person's question opens an exchange and owns it. Messages that land
> into an open exchange steer the seats already working and change nothing
> — the owner stays, and so does whom the assistant writes for at the close.**

**A person's exchange outlives their visit.** Priya may ask and walk out
before the room settles. The exchange is still hers, it still closes, and
the assistant still writes its summary — addressed to her, the way she
reads, waiting for her. How she reads is on the record, with her arrival,
so the room keeps it after she leaves.

**Sam gets no summary for a question he did not ask.** His message into
Priya's exchange steers whoever is working and owns nothing. His own next
question opens his own exchange, and the assistant writes it for him.

**Nobody addresses the assistant.** It sits at the narrow end of
attention and wakes for nothing said (§11), so a message directed at it
is a message nobody reads. The room refuses one. A person who wants the
assistant to write again asks the room, and the close is what wakes it.

**Two people owed at once are written for one after the other.** The
assistant is one seat and holds one activation. If Sam's exchange closes
while the assistant drafts for Priya, Sam stays owed, and the room wakes
the assistant again for him at its next reconcile. A person whose draft the
assistant could not land waits for the backoff instead, so a model that
keeps failing never retries on its own end (§5). Who is owed is a fold
over the journal: a close that names the assistant, with no summary covering
it and no draft that stood down over it. A draft stands down when the
assistant ends it without writing, and when the host revokes it: `abort()`
and `room.stop` write the draft off with every wake still pending. A
later close by the same person joins the draft, and one message reaches
back to the earliest question still owed.

---

## 7. A summary is its own kind of message

The record gains one kind. `said` would be the wrong kind for it, because
nobody said it: a person did not hear it in a room; the assistant wrote it.

```ts
/** What one exchange came to. The assistant writes it. Nobody speaks it. */
export interface SummaryMessage {
  kind: 'summary';
  seq: Seq;
  at: string;
  /** The assistant that wrote it. */
  from: string;
  /** The person whose question opened the exchange. Always present. */
  to: string;
  text: string;
  /** The range it stands for, ending at the last message before this one. */
  covers: { from: Seq; through: Seq };
}

export type Message = SpokenMessage | PresenceMessage | SummaryMessage;
```

Three kinds, and each earns its name. `said` is what a participant told the
room. `arrived` and `left` are what a person did. `summary` is what one
exchange came to. A summary carries two fields no other message has — a
reader and a span — because it is the only message written _for_ somebody,
about a range of the record.

**A summary is always addressed to a person.** `to` is the person whose
question opened the exchange, and it is never absent. That is what makes a
summary a message somebody was told.

---

## 8. The record only grows. What a seat reads does not.

Two statements, and both hold.

**The record is append-only.** A summary takes the next place and lands
after everything it covers. Nothing is deleted, nothing is rewritten, seqs are
monotonic, and `messages()` returns every message for ever. The past does
not change under a reader.

**A summarised range leaves the seats' context.** From the next activation,
the room renders the range as its count and the summary that stands for
it:

```
· priya arrived                                               (2 hours ago)
── 11 messages, summarised for priya below ──
[assistant → priya] Thursday is out: the inspector needs 48h notice and is
  not booked. Earliest is Saturday 30 Aug. It needs four things: …
[sam] Rain all Thursday morning. I am not pouring into that.  (12 min ago)
```

The question folds with the answers, because the range starts at the
question (§3). Nothing is lost by that: the summary answers what she asked,
so it carries the question inside it. `renderRecord` reads the fold off the
record itself — a summary carries the range it stands for — so the renderer
keeps no state and a seat reads the same room whoever renders it.

**Storage and context are different questions.** What a room keeps is
the record. What a seat is handed at an activation is a rendering of it,
built fresh each time by `render.ts`. This changes only the second, which
is why it costs the first nothing.

It is also what makes the design pay for the room and for the person at
once. Without it a seat's context grows with every message for ever. With
it, an exchange costs the room one message once it is over.

§9 says why that is safe to do, and §16 says what it still costs.

---

## 9. The record holds discussion; products hold state

This is what makes §8 safe, and it is a constraint on how a room is
built.

**A product answers out of its own data.** `stock_check()` returns 11.7
tonnes because that is what the materials tracker holds, whatever anybody
said on the record. No product in the measured run answered outside its own
API. So a fact that leaves a seat's context is never lost — the product
that owns it reads it again, on demand, the next time anybody asks.

**Anything that must survive an exchange belongs in a product's state.**
What a summary can genuinely lose is a commitment: _"Sam confirms rebar
fixing by Friday"_, _"Dan approved the overtime"_. No API holds those
unless a product wrote them down. In the measured run the task list wrote
three of them, and one of them carried the entire Saturday contingency into
T-121's note.

That is the rule the room must keep for compaction to be safe:

> **The record is what was said. Nothing lives only there.** A participant
> that establishes something durable writes it into the state it owns, in
> the same turn.

A room that keeps this loses nothing to a summary that it could not also
have lost to a person who stopped reading. A room that breaks it is storing
its decisions in a transcript, and was fragile before the assistant existed.

---

## 10. Presentation belongs to the client

A person should not read the working. That is a statement about
presentation, and it is decided in the client — the record and the wire
carry everything.

The runtime commits messages in order and streams them. What a client does
with them:

- **While the room works**, render the chatter as a thinking state.
  Somebody waiting sees that three products are working and can watch them
  do it, the way any agent's own reasoning is shown. They are not handed
  answers to read.
- **When the summary lands**, fold the range it covers back into that
  thinking state and show the summary as the answer. `covers` says which
  messages to fold.

This asks one thing of a client that a plain journal does not do: **it must be
able to change how it presents past messages when a new message arrives.**
A client that only appends will show the working as conversation.

**Everybody present folds the same range.** Sam watching Priya's exchange
sees what she sees: the room thinking, then the answer it came to. Folding
follows the summary that exists, whoever reads it — nothing is written for
Sam about Priya's exchange, and how he reads plays no part in how it renders
for him. The working is
hidden from every reader, because it was working, and there is no
per-person view to keep straight.

The example client does the smaller half of this. A terminal cannot
re-present what it has already printed, so
[`main.ts`](../examples/site/src/main.ts) marks a summary with `∎` and
prints the span it stands for — `∎ assistant → priya (2–12)` — and leaves
the lines above it unfolded. Folding is the job of a client that can
re-render, and `covers` is what it needs to do it.

---

## 11. Nothing the assistant writes wakes anybody

A summary that woke the room would start a new exchange about the exchange
it just closed. So the routing rule refuses it, and the guard keys on the
author:

```ts
function wakes(seat, target, message, fromAssistant) {
  if (fromAssistant) return false;
  ...
}
```

**The guard belongs to the author.** A guard on the message kind —
`isSummary(message)` — would cover the summary alone. The guard on the
author covers everything the assistant writes, so one line enforces the whole of
§12's rule: nothing the assistant writes can start work.

**The guard has one exception, and it is written into the line.** A
seating the assistant commits wakes the seat it names, and nobody else
([`roster.md`](roster.md) §3). That is the one activation the assistant
can cause: a seat from the reserve the host attached, woken to take its
turn in the exchange it was seated for. A summary still wakes nobody.

Every seat still **reads** everything the assistant writes. Waking and reading
were always different questions.

---

## 12. The limits

The assistant is the people's counterpart, and the pull to give it more will
be constant. One rule decides whether the assistant is still an assistant:

> **The assistant composes and consolidates, and never speaks in the
> room.** It seats a colleague from the reserve at the open of an exchange,
> and writes the one message at the close. It may never say anything, never
> call a tool that changes a product's state, never unseat a colleague, and
> never speak under a person's name.

§11 enforces the waking half in one line, because the guard is on the
author, whatever it wrote, with the one exception §11 names. The rest the
activation specification enforces: `opened` grants `seat` and `closed` grants
`summarise`, and an activation binds one tool. A tool the definition brings
reaches no model, because the assistant wakes for the room's own events
alone.

What the rule forbids, permanently:

- **Deciding.** The assistant reads how a person reads. The person holds the
  decision.
- **Acting as them.** The assistant writes in its own name, stamped `from` the
  assistant. No message on the record ever bears a person's name because the
  assistant wrote it — the runtime stamps `from`, so machinery enforces this.
  That is rule 7, at the one place it is most tempting to bend.
- **Speaking.** The assistant holds no `say` at any activation. A room
  where the assistant answers is a room with one more product in it, and
  one that no team owns.
- **Running the room.** The assistant seats, and the seated agent decides
  for itself whether to speak, to whom, and which colleague to call in. The
  assistant never directs a say, never unseats, and never defines an agent.
  A room that woke for anything the assistant wrote beyond a seating is a
  room being run by a proxy.

The runtime implements two functions: compose and consolidate. The
assistant seats who a question needs, from definitions the host holds in
reserve, and writes the summary of the exchange, shaped by the
person's preferences to how they read. It acts by calling a tool, and the
tools it holds are the runtime's own: they reach the record and the roster
and nothing else. A tool into a product's state is what this rule forbids,
and what `startRoom` refuses.

---

## 13. One explicit assistant

**The assistant option designates one agent.** `startRoom` seats it at
attention `none` and records its name in `Composition.assistant`.
The composition requires that name to identify a roster seat at `none`.
The host cannot unseat the designated assistant during the run.

**The assistant policy owns eligibility and guidance.** It selects an
opening activation when a question opens an exchange with agents in reserve.
It selects a closing activation when multiple agent messages need a summary.
The policy also owns the two tool schemas and their instructions.
The executor owns the mutable tool-call limits for each activation.

**The assistant option is optional.** A room without one closes exchanges
without owing summaries. A room with one serves every person through the
same seat. Each person's optional preferences reach their own closing
activation.

**A restarted room restores the designation from its composition.** The
runtime resolves the assistant's agent definition like every other agent.
The policy requires no role registry or host-supplied event mapping.

**An idle assistant makes no model calls.** It waits until an eligible
exchange event gives it work. A room nobody visits never activates it.

---

## 14. The shape

One required field on the room, one optional field on a person, and no
method:

```ts
const assistant = defineAgent({
  name: 'assistant',
  identity: 'Writes the one message a person reads when their exchange closes.',
  model: 'anthropic/claude-sonnet-5',
  instructions: `
    Lead with the decision the person has to make and who holds it. Give them
    the facts that decision turns on — quantities, dates, owners, what is still
    unknown — and cut everything else the room said.
  `,
});

const priya = defineHuman({
  name: 'priya',
  identity: 'Project manager, site office. Owns the programme.',
  preferences: `
    Open with the date: whether it holds, and if not, the earliest one that
    does. Four sentences at most.
  `,
});

const room = await startRoom({ name: 'site', assistant, agents: [materials, tasks] });
```

**A host never asks for a summary.** It is how the room works, and no
caller drives it. A question opens an exchange, the room works, and the exchange closes. If
the room said more than one thing, the summary is written and committed. It arrives on the `message` event that carries every
message on the record:

```ts
room.subscribe((event) => {
  if (event.type !== 'message') return;
  if (event.message.kind === 'summary') showAnswer(event.message);
  else showThinking(event.message);
});
```

`Visit` returns an exchange handle from `send`, and there is no cursor to
pass: the exchange names its own span. `startRoom` takes the composition,
`defineHuman` takes reading preferences, and the record holds summaries as a
separate message kind. A host follows one exchange directly:

```ts
const visit = await room.visit(priya);
const exchange = await visit.send({ text: 'What changed?' });
const response = await exchange.response();
```

`response()` waits for the summary or returns `undefined` when no summary is
due. A repeated key returns the same handle, and `room.exchange(from)`
reacquires it after a restart. There is no room-wide idle, quiet, or settled
wait.

**What the assistant is handed.** Its context contains the room's goal,
the roster, and messages within the closed exchange's range. Its system
prompt names the recipient and their reading preferences. The final
instruction names the fixed range. Later messages do not enter this input,
even when another exchange opens before publication.

**Preferences reach one seat.** How a person reads renders inside the
assistant's activation for that person, and nowhere else: not in the roster
every seat reads, not in another person's activation. The assistant's
working context is built fresh at every activation, so nothing of one
person's draft is in its context when it writes for the next.

**What the runtime asks of the assistant.** Answer the question, and nothing
beside it. Keep a fact only when the answer depends on it. Keep what
changed while the room worked — a correction, a decision, a date that
moved — because the person did not see it happen. Drop everything else the
room raised, however true. The instructions on the definition say what every
message follows; a person's `preferences` say how that person reads; the
runtime says what a summary is for. A room that asked for all three in the
definition would carry a copy of every person in one prompt.

**What the assistant is given.** A model, instructions, and one tool of the
runtime's per activation. At the close it is `summarise({ text })`, which
writes to the record and nothing else — no `to`, because a summary is
always addressed to the person whose exchange closed. At the open it is
`seat({ name })`, which moves one agent from the reserve to the roster and
commits the seating to the record ([`roster.md`](roster.md) §4). No
activation holds both, and none holds a `say`. The specification grants one tool per
event, so §12's rule — never call a tool that changes a product's state —
stays a fact about what the room hands the seat.

**Writing is a tool, and silence is a decision.** An activation that ends
without calling `summarise` leaves the range whole, and every reader
still sees all of it. That is rule 3 of the core, for the assistant: when the
room's answer already reads as one answer, standing between a person and it
would only add a voice. The threshold in §4 sits underneath as a cost
floor — below it the room spends no model call at all — and above it the
judgment is the assistant's, where the rest of the judgment lives.

**The tool bounds an activation.** It permits one successful publication
and caps the total number of tool calls.
A model that keeps calling a tool that keeps refusing would draft for ever,
so the tool ends the activation itself. Nothing else here bounds an
activation — which
is [`exchange.md`](exchange.md) §8's gap, closed where it can be closed.

**What the room reads it as.** A seat's context carries one paragraph about
folds, and only once the record holds a summary. A record with no summary on
it renders no fold, and no paragraph about one.

**Where its activation lands.** In a downstream session of its own,
`<room>:<assistant>`, by the same rule as every other seat. Every person's
message is drafted there, one activation each, and rule 8 keeps every
activation auditable after the fact: a summary is written by a model like
any other activation. The one message that reaches a person should be the
easiest thing in the room to check.

---

## 15. Boundaries

Each boundary is stated so a later change has to argue with it.

- **Catch-up stays presence's.** A person returning after two days is
  [`presence.md`](presence.md) §8's business, and its anchor is untouched.
  Arriving opens no exchange, and a summary stands for one exchange (§3),
  so no summary ever reaches back over what somebody missed.
- **The assistant seats from the reserve, and from nowhere else.** The
  host decides what may ever be in the room by writing `available`. The
  assistant defines nothing and unseats nobody.
  [`roster.md`](roster.md) §2, §7.
- **Activation triggers stay as they were, with one addition.** No seat
  wakes because the room went quiet. A seat wakes because the assistant
  seated it, and that is the one activation the assistant causes. §11.
- **One clean answer passes through untouched.** It reaches the person as
  it was given, and anything outside an exchange stays as it landed.
- **The record keeps every message.** Only a seat's context changes. §8.
- **Durable facts live in product state.** A participant writes what must
  survive into the state it owns. §9.
- **The assistant holds no authority over the room.** §12 draws the line and
  names what is forbidden.
- **The assistant is explicit.** The optional `assistant` setting names
  one seat with the fixed assistant policy. §13.
- **How a person reads reaches one seat.** The assistant reads a person's
  `preferences` when it writes for them, and no product's context carries
  them. §2, §14.

---

## 16. Open questions

**What a summary loses, and why that is accepted.** A summarised range
leaves the seats' context, so a fact the summary drops is gone from every
later activation. That is accepted, on two conditions the design states
as requirements.

The first is symmetry. **What never entered a person's context cannot come
back as a question they ask.** They read the summary; the seats read the
summary. Neither can be surprised by the other, because they hold the same
premise — and the seats hold strictly more, since they also have everything
after it and their own tools. The room is never behind the person it is
answering.

The second is §9. A fact is re-derivable, because the product that owns it
reads it again. A commitment is durable, because whoever made it wrote it
into their own state. **A room that keeps §9 loses nothing to a summary
that it would not also lose to a person who stopped reading.**

What remains, and is not solved: a person carries context from outside the
session. Priya reads a delivery note on her desk and asks about a tonnage
no summary prepared her for. The seats answer anyway, out of their own
APIs — which is §9 again. The case that would genuinely break is a question
about something established in a summarised range that no product owns, and
§9 exists to keep that class empty. Whether a real room keeps §9 is the
thing to watch.

**Quiescence is a reason to spend money.** No seat activates when the room
settles, so rule 1 keeps its letter. But the room makes a model call that
no message asked for, and that is a second kind of trigger. §15 bounds it:
the close of an exchange, one assistant, one message.

**An aborted exchange still closes.** `abort()` revokes the leases in
flight and the room reconciles, so the exchange it was working on closes
and the assistant writes for its owner. That is right — the exchange ended,
and its person still gets what the room reached before it was cut off —
but the message stands for work somebody stopped. A draft the assistant
held at the abort is written off with the rest: the summary it stood for
is owed no longer. `room.stop` is the other case, below.

**A run that stops mid-exchange writes no summary.** `room.stop` revokes
the leases in flight and writes no close, so the exchange stays open on
the journal. It revokes a draft in flight for the same reason, and a draft
that does finish after the stop commits nothing. The next run over the
same journal closes the exchange at its first reconcile
([`exchange.md`](exchange.md) §5) and writes what it owes then. Accepted.

**The close bounds the summary input.** Later messages cannot enlarge it.
An exchange can still run for an unbounded time before it closes; see
[`exchange.md`](exchange.md) §8.

**A stopped room leaves an unfinished exchange open.** `room.stop()` revokes
work and writes no close for the unfinished exchange. A later `resumeRoom`
replays it and lets `exchange.messages()` complete; shutdown does not invent a
summary or a close.

**A summary is owed until the third attempt.** A failed or expired
activation counts as one attempt. The room's own alarm wakes the assistant again
after the backoff, whether or not anybody speaks into the room. After
three attempts the room stops trying, and it writes an entry that says so:
the attempt it does not make, ended `abandoned`. The host hears an
`abandoned` event. The range stays whole and every reader still sees it,
so nothing is lost, and the one message never arrives.

**What a client owes.** §10 asks a client to re-present past messages when
a new one arrives. That is more than a journal does, and no client in this
repository does it.

**The room still chatters.** The assistant makes ten messages readable. It does
not make the room produce fewer, and the say instruction still rewards
adding something the record does not hold. Whether better prompting halves
the chatter is one run away, and it would change what the assistant has to do.

---

## 17. What proves it

The milestone tests live in
[`assistant.test.ts`](../packages/ambion/test/assistant.test.ts), one per claim this
document makes loudly:

- An exchange the room answered twice closes into one message, addressed to
  the person who asked, covering exactly the recorded close and drafted
  from that fixed range
  and with one tool that reaches the record and nothing else. The
  activation names whom it writes for and how they read. §2, §3, §4, §7,
  §14.
- One answer is left as it was given, in the voice that gave it. §4.
- A room without a designated assistant closes every exchange and owes
  no summary. An assistant that brings its own tools is seated, and its
  drafting activation still holds `summarise` alone. §12, §13.
- A summary wakes nobody, and the next activation reads the fold and the
  summary in place of the messages, while the record keeps every one of
  them. The fold paragraph reaches a seat once the record holds a summary.
  §8, §11, §14.
- A question that lands while a seat works on what nobody asked for still
  opens an exchange and owns it. §3.
- A later question leaves an active summary's input and range unchanged. §5.
- Separate exchanges for the same person each keep their own summary. §5.
- Publication rejects an incorrect writer, recipient, range, or duplicate. §5.
- An activation that stands down without writing is owed nothing for it. §14.
- An activation that fails outright leaves the summary owed, and the room
  drafts again when the backoff passes. §16.
- The person whose question opened the exchange owns it, and a second
  person speaking into it gets nothing. §6.
- A person who left before the exchange closed is still written for, the way
  they read. §6.
- Three people are each written for their own way, one activation carrying
  one person's preferences and no other's, and a person who said nothing
  about how they read is written for in the assistant's own style. §2, §13,
  §14.
- A second person owed while the assistant drafts for the first is written
  for once the first draft is over, one activation after the other. §6.
- The assistant's turns land in a downstream session of its own, and the room
  lists it as the seat it is, seated `none` and marked as the assistant.
  §2, §14.
- A second summary for the same person stands for their second question,
  and never for the exchange before it. §3.
- `exchange.messages()` can resolve before its optional summary response resolves. §14.
- A fold names the person its summary was written for, and two overlapping
  ranges stay apart. §5, §8.
- An empty say is refused, so nothing empty stands inside a range. §4.
- An exchange with a summary owed keeps its response pending until the summary
  lands or the room deliberately gives up; a stopped room leaves the exchange
  open for a later resume. §5, §16.
- `startRoom` refuses an assistant whose name an agent holds, and
  `room.visit` refuses a person who takes the assistant's name. §14.
- Each assistant activation grants exactly its prescribed tool. An invalid
  assistant designation is refused before the composition is committed. §12.
- The assistant is seated when the room starts, and a room nobody visits
  never activates it. §13.

All in-process, in vitest, on a scripted stream.

The runnable proof is [`examples/site`](../examples/site), where one
assistant writes for three people, and how each of them reads lives on
their definition alone; no product's instructions carry a copy.

---

## 18. What proved it in a room

The tests prove the mechanism. They do not prove that the one message is
worth reading, and that needed a live run.

The run is
[`demos/2026-08-31-one-exchange-one-message.html`](../demos/2026-08-31-one-exchange-one-message.html):
the same scenario twice, once with the assistants taken out of
[`room.ts`](../examples/site/src/room.ts) and once as it stands.

What it showed. Four questions opened four exchanges, and each one closed
into one message: 19 agent messages became 4, of 94 words on average. A
seat activated after a summary still did its job, answering from the folds
and its own API because the record no longer held what it told her.

What it cost. The last seat activation read 8,391 characters, with 14
messages standing as 3 summaries; the same record unfolded is 11,698, so
the fold took 28% off what that seat read. That is the number to trust —
one room, rendered twice. Across the two arms it is muddier: the run with
no assistants ended at 8,266 characters for 29 messages against this run's 36,
so the two came out level. The room with assistants in it said more, and
folding what it said gave the saving back. Earlier runs of
the same pair, on rooms that talked at more similar lengths, ended a third
to a half apart in the fold's favour. What a person reads does not move:
one message per question.

What it changed. Three things in this document came from those runs rather
than from the tests: §3's range, which used to start after a person's last
summary and now starts at their question; §5's fold, which now names the
person it was written for; and §14's paragraph, which now asks an assistant for
the answer and what changed, and for nothing else. An earlier run of the
same scenario wrote summaries of 158 words. All of it is in the report.
