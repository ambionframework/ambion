# The assistant

This document is the design contract for the assistant: the agent every
person brings into a session, which holds how they read and turns the
room's work into one message. It is shipped. The code lives with the rest
of the runtime in [`packages/ambion/src`](../packages/ambion/src) —
the summary in [`session.ts`](../packages/ambion/src/session.ts), the fold a
seat reads in [`render.ts`](../packages/ambion/src/render.ts), the shapes
in [`types.ts`](../packages/ambion/src/types.ts). Read
[`agent.md`](agent.md), [`exchange.md`](exchange.md) and
[`presence.md`](presence.md) first.

One sentence:

> **A person asks a question. Several agents wake and work it out between
> them. When the room goes quiet, that person's assistant writes one summary of
> what they arrived at — the person reads that in place of the working, and
> from the next activation the seats read it too.**

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

An assistant is a person's counterpart in a room: one assistant, one person, for as
long as they are in it.

**It is a seat.** It is seated when its person arrives, the room activates
it as it activates every other agent, its turns land in a downstream session
of its own, and the record's lock refuses it exactly as it refuses a say. Two
things make it the seat it is, and both are data:

- It is seated at `none`, the narrow end of the attention scale
  ([`agent.md`](agent.md) rule 6): nothing said in the room wakes it, and
  it cannot be addressed.
- The close of its person's exchange wakes it, and that activation holds one
  tool, `summarise`, bound to the range it must stand for.

A seat carries none of that. Which assistant writes for whom, who is owed a
message, and which is drafting one now are held by the assistants themselves
(`Assistants` in [`assistant.ts`](../packages/ambion/src/assistant.ts)); the room asks
them, and no seat carries a field for it.

An assistant holds one thing nothing else in the room holds: **how its person
reads.** What an answer has to lead with, what to cut, and how much of one
they will take.

Two facts about a person sit outside it. What they own and what only they
can do is their `identity`, which every seat reads and the assistant reads with
them. What they asked is a message with a seq, and a closed exchange names
the seq it started at. An assistant that holds either one carries a copy of
something already in its context.

Put the reading preferences inside each product's instructions and every
product carries a copy of every person, so each new person lengthens every
product's prompt. That is a modelling error. How Priya reads belongs to
Priya, so it lives in her assistant and nowhere else.

**An assistant never decides and never acts as its person.** `deliver` stays the
person's own act, in their own words. §12 draws that line.

The name sets the authority. An assistant writes for its person, reminds, and
says _"she will want the tonnage"_. It never runs the room and it never
answers for anyone.

---

## 3. The exchange

The unit is the **exchange**, and it belongs to the core:
[`exchange.md`](exchange.md) specifies it, and
[`exchange.ts`](../packages/ambion/src/exchange.ts) is where it lives. A
question, and everything the room does until it goes quiet again. A
person's question opens one; quiescence closes it; what lands in between
steers the seats already working and changes nothing.

An assistant is the first thing to read a closed exchange, and other readers
exist beside it ([`exchange.md`](exchange.md) §7). An exchange opens and
closes whether or not its assistant ends up writing anything for it — that
choice is §4's, not the exchange's.

What matters here is what an assistant makes of one:

- **It is what a summary stands for.** One exchange, one message.
- **Only a question opens one**, so arriving and leaving are never
  summarised, and a room where nobody asks anything is never summarised at
  all.
- **Quiescence is a true end.** A room that settles has finished, and will
  never restart on its own, so a summary written at the close is written
  over work that is over.

**A summary stands for one exchange, and never for anything before it.**
`from` is the question that opened it; `through` is the last seq when the
summary commits. The room holds `from` while the exchange is open, the same
way it holds the owner, and `through` is a live read of the record; the
runtime keeps no cursor beside it.

A person who walks back into a room after two days is not summarised for
the two days. What they missed is presence's business (§15), and their next
question opens a range of its own.

The close is a race, and §5 settles it with the lock the room already has.

[`exchange.md`](exchange.md) §8 records the gap underneath this: nothing
bounds how long an exchange may run.

---

## 4. One exchange, one message

The rule the design serves:

> **Every exchange resolves to exactly one message.**

Most of the time the room may already have done that. One product answers,
once, and that message is the answer. **An assistant does not engage.** The
person reads what the product said, in that product's own words, and the
seats keep reading it too.

It engages when the room did not:

> **A summary is written when an exchange closes and holds more than one
> message from the agents. One message needs no consolidation.**

It counts what the room produced, and leaves what people said into it out
of the count: a second person speaking is a steer, and two people talking
to each other is nothing an assistant consolidates. And it counts messages, not
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

## 5. A summary commits under the same lock as a say

An assistant takes seconds to write. The room is idle while it works, so a new
question may land, open the next exchange and wake seats before the summary
is ready. A summary that committed anyway would sit in the record after
work it does not cover, and both readers would have to cope with a fold
that is no longer next to the message doing the folding.

Nothing new is needed. **Rule 5 already refuses a message that was drafted
against a record that has moved**, and it refuses an assistant exactly as it
refuses a seat:

> **A message commits only against a record its author has read in full.**

The assistant reads the record to `through` and drafts. At the moment it
commits, the room checks: if the record has not moved, the summary lands
immediately after the range it covers, contiguous and in order. If the
record has moved, the commit is refused, and the host hears the same
`conflict` event a refused seat raises, naming the assistant and what it missed.

**A refused assistant is told, in its own activation.** It writes by calling a tool
(§14), so the refusal reaches it the way a refused say reaches a seat: as
the tool's failure, listing what landed. The range widens to hold those
messages, and the assistant drafts again over it immediately. It gets two
drafts. After the second refusal the room is moving faster than the assistant
writes, and the activation ends.

**A summary the activation could not land drafts again at the next
quiescence.**
Its range is a live read, so the retry covers what it covered before plus
whatever won the race. The two halves of the rule divide the work: the assistant
redrafts inside its activation while that is still useful, and the next quiet
room catches an activation that ran out of drafts or failed outright.

Two questions asked in quick succession become one summary, which is right:
they were one conversation. If somebody else's exchange won the race, it
falls inside the range too, and its person reads what happened while they
were waiting. That is the price of the race, it is acceptable, and one
message still serves.

**A race is the only way two ranges overlap**, and a widened range can hold
a summary written for somebody else. The rendering says whose each fold is:

```
── 3 messages, summarised for priya below ──
── 3 messages, summarised for sam below ──
[sam-assistant → sam] …
[priya-assistant → priya] …
```

Each message takes the nearest summary that stands for it, and a summary is
never folded into another one. So a fold never claims a message that stands
for something else, and a reader is never told that the summary under a
fold covers more than it does.

Three things follow, and each removes a problem the design would otherwise
have.

**A summary is always contiguous with what it covers.** So `render.ts`
replaces a block that ends immediately before the summary, and a client
folds a run that ends at the message it just received. Neither has to
reason about interleaving.

**`settled()` keeps its meaning.** The exchange can close before its
summary lands, and the room is never held busy while an assistant writes.
Quiescence is still simply "no agent is active".

**A failed model call is a refused commit with extra steps.** If the assistant's
activation errors, no summary is written, the range stays uncompacted and
fully
visible, and the next quiescence is another chance. The safe direction is
the default, and it takes no special case.

The event the room emits on a refusal is `conflict`, and it carries the
author and what they missed. It names the author because the lock covers
every kind of message, says and summaries alike.

---

## 6. Who owns an exchange

A room holds several people, and each brings an assistant. Only one writes
per exchange, and the exchange says which
([`exchange.md`](exchange.md) §4):

> **A person's question opens an exchange and owns it. Messages that land
> into an open exchange steer the seats already working and change nothing
> — the owner stays, and so does which assistant writes at the close.**

**An assistant outlives its person's visit by one exchange.** Priya may ask and
walk out before the room settles. The exchange is still hers, it still
closes, and her assistant still writes its summary — addressed to her, waiting
for her.

**Sam gets no summary for a question he did not ask.** His message into
Priya's exchange steers whoever is working and owns nothing. His own next
question opens his own exchange, and his own assistant writes it.

---

## 7. A summary is its own kind of message

The record gains one kind. `said` would be the wrong kind for it, because
nobody said it: a person did not hear it in a room; an assistant wrote it.

```ts
/** What one exchange came to. An assistant writes it. Nobody speaks it. */
export interface SummaryMessage {
  kind: 'summary';
  seq: Seq;
  at: string;
  /** The assistant that wrote it. */
  from: string;
  /** The person whose question opened the exchange. Always present. */
  to: string;
  text: string;
  /** The range it stands for, contiguous and ending just before this seq. */
  covers: { from: Seq; through: Seq };
}

export type Message = SpokenMessage | PresenceMessage | SummaryMessage;
```

Three kinds, and each earns its name. `said` is what a participant told the
room. `arrived` and `left` are what a person did. `summary` is what one
exchange came to. A summary carries two fields no other message has — a
reader and a span — because it is the only message written _for_ somebody,
about a range of the record.

**A summary is always addressed to its person.** `to` is the person whose
question opened the exchange, and it is never absent. That is what makes a
summary a message somebody was told.

---

## 8. The record only grows. What a seat reads does not.

Two statements, and both hold.

**The record is append-only.** A summary takes the next seq and lands after
everything it covers. Nothing is deleted, nothing is rewritten, seqs are
monotonic, and `messages()` returns every message for ever. The past does
not change under a reader.

**A summarised range leaves the seats' context.** From the next activation,
the session renders the range as its count and the summary that stands for
it:

```
· priya arrived                                               (2 hours ago)
── 11 messages, summarised for priya below ──
[priya-assistant → priya] Thursday is out: the inspector needs 48h notice and is
  not booked. Earliest is Saturday 30 Aug. It needs four things: …
[sam] Rain all Thursday morning. I am not pouring into that.  (12 min ago)
```

The question folds with the answers, because the range starts at the
question (§3). Nothing is lost by that: the summary answers what she asked,
so it carries the question inside it. `renderRecord` reads the fold off the
record itself — a summary carries the range it stands for — so the renderer
keeps no state and a seat reads the same room whoever renders it.

**Storage and context are different questions.** What a session keeps is
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
its decisions in a transcript, and was fragile before an assistant existed.

---

## 10. Presentation belongs to the client

A person should not read the working. That is a statement about
presentation, and it is settled in the client — the record and the wire
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

This asks one thing of a client that a plain log does not do: **it must be
able to change how it presents past messages when a new message arrives.**
A client that only appends will show the working as conversation.

**Everybody present folds the same range.** Sam watching Priya's exchange
sees what she sees: the room thinking, then the answer it came to. Folding
follows the summary that exists, whoever reads it — Sam's own assistant
plays no part in how Priya's exchange renders for him. The working is
hidden from every reader, because it was working, and there is no
per-person view to keep straight.

The example client does the smaller half of this. A terminal cannot
re-present what it has already printed, so
[`main.ts`](../examples/site/src/main.ts) marks a summary with `∎` and
prints the span it stands for — `∎ priya-assistant → priya (2–12)` — and leaves
the lines above it unfolded. Folding is the job of a client that can
re-render, and `covers` is what it needs to do it.

---

## 11. Nothing an assistant writes wakes anybody

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
author covers everything an assistant writes, so one line enforces the whole of
§12's rule: nothing an assistant writes can start work.

Every seat still **reads** everything an assistant writes. Waking and reading
were always different questions.

---

## 12. The limits

An assistant is a person's counterpart, and the pull to give it more will be
constant. One rule decides whether an assistant is still an assistant:

> **An assistant shapes, and never wakes.** It may steer a seat that is already
> working. It may never activate one, never call a tool that changes a
> product's state, and never speak under its person's name.

§11 enforces the first half in one line, because the guard is on the
author, whatever it wrote. The rest is checkable by reading a definition:
an assistant carries no tools of its own, and `defineHuman` refuses one that
does. What it holds is the runtime's, and the runtime hands it nothing
that reaches a product.

What the rule forbids, permanently:

- **Deciding.** An assistant holds how its person reads. Its person holds the
  decision.
- **Acting as them.** The assistant writes in its own name, stamped `from` the
  assistant. No message on the record ever bears its person's name because the
  assistant wrote it — the runtime stamps `from`, so machinery enforces this.
  That is rule 7, at the one place it is most tempting to bend.
- **Causing work.** A room that woke because somebody's assistant wanted
  something is a room being run by a proxy.

The runtime implements one function: consolidate. The assistant writes the
summary of an exchange, and its instructions shape that summary to how
its person reads. It writes by calling a tool, and the tools it holds
are the runtime's own: they reach the record and nothing else. A tool into
a product's state is what this rule forbids, and what `defineHuman`
refuses.

---

## 13. It is required

Every person brings an assistant. `defineHuman` takes `assistant` as a
required field, and refuses a definition that omits one.

**One person, one assistant, always.** A room never holds a person whose
exchange resolves differently from anybody else's: every question closes
through the same mechanism, in the same person's own assistant, whether the
room answered it once or ten times. There is no second code path for
"nobody is holding preferences for them," and so nothing in the runtime
branches on whether a person has one.

**The guarantee is unchanged where an assistant has nothing to add.** §4
still holds: one clean answer is left as it was given, and a summary is
written only when the room said more than one thing. Requiring an
assistant does not mean it always writes — it means somebody is always
there to judge whether writing would help.

**A restarted room still starts with none seated.** `Assistants` is run
state, like an exchange (§6): a person known from a replayed record has no
assistant seated again until they visit in the new run. `SeatInfo.assistant`
and `PersonView.assistant` stay optional in the types for exactly that
window, not because a person can go without one.

---

## 14. The shape

One required field, and no method:

```ts
const priya = defineHuman({
  name: 'priya',
  identity: 'Project manager, site office. Owns the programme.',
  assistant: defineAgent({
    name: 'priya-assistant',
    identity: 'Holds how Priya reads.',
    model: 'anthropic/claude-sonnet-5',
    instructions: `
      Lead with the decision Priya has to make and who holds it. Give her the
      facts that decision turns on — quantities, dates, owners, what is still
      unknown — and cut everything else the room said. Four sentences at most.
    `,
  }),
});
```

**A host never asks for a summary.** It is how the session works, and no
caller drives it. A question opens an exchange, the room works, the room
settles, and — if the room said more than one thing — the summary is
written and committed. It arrives on the `message` event that carries every
message on the record:

```ts
session.subscribe((event) => {
  if (event.type !== 'message') return;
  if (event.message.kind === 'summary') showAnswer(event.message);
  else showThinking(event.message);
});
```

`Visit` is unchanged, and there is no cursor to pass: the exchange names
its own span. `defineHuman` takes one required field beyond `identity`, the
record holds one more kind, a person's seat names the assistant they
brought and the assistant's own
seat names its person (`SeatInfo`, in [`presence.md`](presence.md) §10),
and a host that wants the one message waits for `quiet()`. **That is the
whole surface.**

**`settled()` does not wait for an assistant, and `quiet()` does.** `settled()`
reports that no seat which speaks for itself is taking an activation — an
assistant writing about an exchange is not the room still working on it, which is
the meaning §5 needs, and it is why an assistant's own activation closes no
exchange and cannot retry itself for ever. `quiet()` resolves when no seat is
taking an activation **and** no assistant still owes one, and a `quiet` event says the same
thing to a listener. That is what a host waits for when it wants the one
message a person reads. Nothing holds the room busy while an assistant writes:
the two promises name two different moments.
[`examples/site/src/demo.ts`](../examples/site/src/demo.ts) waits with
`quiet()`, and it is the only thing an assistant asks of a host.

**What an assistant is handed.** The same context every seat reads — the room's
goal, the roster, and the record as it renders now — and one line more: the
range it is closing, named at the end where a seat is asked to take its
turn. It reads the record folded, so what its person has already read
stands there as the summary that stands for it, and what this exchange said
stands there in full. That is one renderer for the room, and it is what
§16's symmetry rests on: an assistant reads exactly what the seats read. A
refused draft is told what landed, in the failure the tool returns, and the
range it drafts again over holds those messages too.

**What the runtime asks of every assistant.** Answer the question, and nothing
beside it. Keep a fact only when the answer depends on it. Keep what
changed while the room worked — a correction, a decision, a date that
moved — because its person did not see it happen. Drop everything else the
room raised, however true. The instructions on the definition say how this
person reads; the runtime says what a summary is for. A room that asked for
both in the definition would repeat itself in every assistant.

**What an assistant is given.** A model, instructions, and one tool of the
runtime's: `summarise({ text })`. It writes to the record and nothing
else — no `to`, because a summary is always addressed to its person.
`defineHuman` refuses an assistant that carries tools of its own, so §12's
rule — never call a tool that changes a product's state — stays a
checkable fact about the definition.

**Writing is a tool, and silence is a decision.** An assistant that ends its
activation without calling `summarise` leaves the range whole, and every reader
still sees all of it. That is rule 3 of the core, for an assistant: when the
room's answer already reads as one answer, standing between a person and it
would only add a voice. The threshold in §4 sits underneath as a cost
floor — below it the room spends no model call at all — and above it the
judgment is the assistant's, where the rest of the judgment lives.

**The tool bounds an activation.** Two drafts per activation (§5), and a cap
on how often the tool may be called at all.
A model that keeps calling a tool that keeps refusing would draft for ever,
so the tool ends the activation itself. Nothing else here bounds an
activation — which
is [`exchange.md`](exchange.md) §8's gap, closed where it can be closed.

**What the room reads it as.** A seat's context carries one paragraph about
folds, and only once somebody has visited: `hasAssistants` turns on at the
first visit and stays on for the run. A room nobody has yet visited renders
no fold, and no paragraph about one.

**Where its activation lands.** In a downstream session of its own,
`<room>:<assistant>`, by the same rule as every other seat. Rule 8 keeps every
activation auditable after the fact, and a summary is written by a model
like any other activation. The one message that reaches a person should be
the
easiest thing in the room to check.

---

## 15. Boundaries

Each boundary is stated so a later change has to argue with it.

- **Catch-up stays presence's.** A person returning after two days is
  [`presence.md`](presence.md) §8's business, and its anchor is untouched.
  Arriving opens no exchange, and a summary stands for one exchange (§3),
  so no summary ever reaches back over what somebody missed.
- **Nothing convenes.** There is no working group and nothing has members.
- **Activation triggers stay as they were.** No seat wakes because the
  room went quiet.
- **One clean answer passes through untouched.** It reaches the person as
  it was given, and anything outside an exchange stays as it landed.
- **The record keeps every message.** Only a seat's context changes. §8.
- **Durable facts live in product state.** A participant writes what must
  survive into the state it owns. §9.
- **The assistant holds no authority over the room.** §12 draws the line and
  names what is forbidden.
- **Every person brings an assistant.** `defineHuman` refuses a definition
  that omits one. §13.

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

**An aborted exchange still closes.** `abort()` cancels the activations in
flight and the room settles, so the exchange it was working on closes and
its owner's assistant writes for it. That is right — the exchange ended, and its
person still gets what the room reached before it was cut off — but the
message stands for work somebody stopped. `stopSession` is the other case,
below.

**A run that stops mid-exchange writes no summary.** `stopSession` aborts
the activations in flight, so the exchange never closes. It aborts a draft in
flight for the same reason, and a draft that does finish after the stop
commits nothing. The person asked and heard nothing, and the record shows a
question, some work and a shutdown. Accepted.

**A widened range is bounded by a race, and nothing else.** A summary
covers one exchange, so the only thing that can make a range large is what
lands while the assistant drafts. That is seconds of room at most. It is the
right bound to have, and it is the one the design leans
on now that a range no longer reaches back to a person's last summary.

**A stopped room never reports that it is quiet.** `quiet` says that no
seat is taking an activation and no assistant still owes one. A room that is
closing is
neither, so shutdown drains whoever waited on `quiet()` and emits nothing
afterwards.

**A summary can be owed for ever.** A race is handled inside the activation,
but an activation that fails outright, or that runs out of drafts, waits for the next
quiescence — and a room that is never woken again never has one. The range
stays whole and every reader still sees it, so nothing is lost; but the one
message never arrives, and nothing reports that it is owed. A run that ends
the day with an owed summary is the case to watch.

**What a client owes.** §10 asks a client to re-present past messages when
a new one arrives. That is more than a log does, and no client in this
repository does it.

**The room still chatters.** An assistant makes ten messages readable. It does
not make the room produce fewer, and the say instruction still rewards
adding something the record does not hold. Whether better prompting halves
the chatter is one run away, and it would change what an assistant has to do.

---

## 17. What proves it

The milestone tests live in
[`assistant.test.ts`](../packages/ambion/test/assistant.test.ts), one per claim this
document makes loudly:

- An exchange the room answered twice closes into one message, addressed to
  its person, contiguous with the range it covers, drafted from that range
  and with one hand that reaches the record and nothing else. §3, §4, §7,
  §14.
- One answer is left as it was given, in the voice that gave it. §4.
- `defineHuman` refuses a definition with no assistant. §13.
- A summary wakes nobody, and the next activation reads the fold and the
  summary in place of the messages, while the record keeps every one of
  them. §8, §11.
- A question that lands while a seat works on what nobody asked for still
  opens an exchange and owns it. §3.
- A draft refused because the room moved raises `conflict`, and the assistant
  redrafts over the widened range inside the same activation. §5.
- An assistant that keeps drafting into a room that keeps moving is stopped by
  the runtime, and writes at the next quiescence. §5, §14.
- An assistant that stands down without writing is owed nothing for it. §14.
- An activation that fails outright leaves the summary owed until the next
  quiet
  room. §16.
- The person whose question opened the exchange owns it, and a second
  person speaking into it gets nothing. §6.
- An assistant outlives its person's visit by one exchange. §6.
- An assistant's turns land in a downstream session of its own, and the room
  lists it as the seat it is, seated `none` and writing for its person.
  §2, §14.
- A second summary for the same person stands for their second question,
  and never for the exchange before it. §3.
- A room goes quiet when the summary lands, and settles before it. §14.
- A fold names the person its summary was written for, and two overlapping
  ranges stay apart. §5, §8.
- An empty say is refused, so nothing empty stands inside a range. §4.
- A room with a summary owed is quiet, because owing one is not working on
  one; and a stopped room never reports that it went quiet. §5, §16.
- `defineHuman` refuses an assistant that holds tools or takes its person's
  name, and `visitSession` refuses one whose name the room already holds.
  §12, §14.

All in-process, in vitest, on a scripted stream.

The runnable proof is [`examples/site`](../examples/site), where each of
the three people brings an assistant, and how each of them reads lives in that
assistant alone; no product's instructions carry a copy.

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
