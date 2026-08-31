# The aide

This document is the design contract for the aide: the optional agent a person
brings into a session, which holds their brief and turns the room's work into
one message they read. It is shipped. The code lives with the rest of the
runtime in [`packages/ambion/src`](../packages/ambion/src) — the exchange and
the summary in [`session.ts`](../packages/ambion/src/session.ts), the fold a
seat reads in [`render.ts`](../packages/ambion/src/render.ts), the shapes in
[`types.ts`](../packages/ambion/src/types.ts). Read [`agent.md`](agent.md) and
[`presence.md`](presence.md) first.

One sentence:

> **A person asks a question. Several agents wake and work it out between
> them. When the room goes quiet, that person's aide writes one summary of
> what they arrived at — the person reads that instead of the working, and
> from the next activation the seats read it too.**

---

## 1. The problem, measured

The run in [`demos/`](../demos) is the evidence for both halves.

**A person reads a transcript instead of an answer.** Priya asked one
question: _can I tell the client Thursday for the pour?_ It woke three
products. They answered her, answered each other, corrected each other and
refined their own answers. Ten agent messages landed before she left. Four
addressed her. The room established that Thursday was impossible, why, and
what would make Saturday possible. **It never assembled that into an answer**,
because no participant has assembling as its job.

**The room re-reads all of it, for ever.** Each activation renders the record
into a seat's context. Over 25 activations that run built 148,038 characters
of context, and **the record was 77% of it**. The first context was 1,259
characters. The last was 10,081. Thirty messages did that.

One message answers both.

---

## 2. The aide

An aide is a person's counterpart in a room: one aide, one person, for as long
as they are in it.

It holds two things nothing else in the room holds. **The brief** — what its
person asked, and what they are trying to decide. **The preferences** — what
they act on, what they ignore, how long an answer they read. Put those inside
each product's instructions and every product carries a copy of every person,
so each new person lengthens every product's prompt. That is a modelling
error. What Priya wants belongs to Priya, so it lives in her aide and nowhere
else.

**An aide never decides and never acts as its person.** `deliver` stays the
person's own act, in their own words. §12 draws that line and says how far the
role may grow.

The name sets the authority. An aide briefs, reminds, and says _"she will want
the tonnage"_. It does not run the room and it does not answer for anyone.

---

## 3. The exchange

The unit is the **exchange**: a question, and everything the room does until it
goes quiet again. The room goes from idle, to active, and back to idle.

- **It opens** when a person's `said` lands and no exchange is open.
- **It closes** when no agent is active. `settled()` resolves.

**Only a question opens one.** Arriving and leaving are messages, and they may
wake a seat, but they open no exchange and are never summarised. A room where
nobody asks anything is never summarised at all.

In an idle room no exchange is open, because one closes the moment the room
goes quiet. So the first clause reads as "into an idle room" almost always. It
is written on the exchange rather than on the room's status for the case that
is busy and has no owner: somebody arrives, the seat that watches the door
wakes, and the question lands on top of work nobody asked for. The question
still owns what follows. A rule read off the room's status would leave that
question unsummarised for ever.

**Quiescence is a true end, not a gap.** A seat that says something activates
its readers inside its own `say`, before its own turn finishes, so the active
count never dips to zero in the middle of a burst. A room that settles has
finished, and will not start again on its own.

An exchange covers itself and nothing else. `from` is the seq after this
person's last summary, or their first question if they have none; `through` is
the last seq when the summary commits. In the ordinary case those are the
question and the close. **It never reaches back past a summary its person has
already read**, and it is a live read of the record, not a cursor kept beside
it.

The close is a race, and §5 settles it with the lock the room already has.

[`agent.md`](agent.md) §7 records the gap underneath this: nothing bounds how
long an exchange may run. That is the core's to fix, and this design assumes
it will be.

---

## 4. One exchange, one message

The rule the design serves:

> **Every exchange resolves to exactly one message.**

Most of the time the room may already have done that. One product answers,
once, and that message is the answer. **An aide does not engage.** The person
reads what the product said, in that product's own words, and the seats keep
reading it too.

It engages when the room did not:

> **A summary is written when an exchange closes and holds more than one
> message from the agents. One message needs no consolidation.**

It counts what the room produced, not what people said into it: a second
person speaking is a steer, and two people talking to each other is not
something an aide consolidates. And it counts messages, not speakers. The measured run's worst moment was one
product saying four separate things to Priya, and that needs consolidating as
much as three products saying one each.

What the run shows:

| In the measured run                  |              |
| ------------------------------------ | ------------ |
| Questions asked                      | 3            |
| Exchanges that would write a summary | 3            |
| Exchanges that would pass through    | 0            |
| Agent messages inside an exchange    | **17 of 19** |
| Agent messages outside any exchange  | 2            |

**Every question in this run drew more than one answer, so the threshold never
fired.** It is a rule about a case this run does not contain, and it is kept
because the case is real: a single clean answer should reach a person in the
voice that gave it.

An exchange with no agent message writes nothing.

---

## 5. A summary commits under the same lock as a say

An aide takes seconds to write. The room is idle while it works, so a new
question may land, open the next exchange and wake seats before the summary is
ready. A summary that committed anyway would sit in the record after work it
does not cover, and both readers would have to cope with a fold that is no
longer next to the message doing the folding.

Nothing new is needed. **Rule 5 already refuses a message that was drafted
against a record that has moved**, and it refuses an aide exactly as it
refuses a seat:

> **A message commits only against a record its author has read in full.**

The aide reads the record to `through` and drafts. At the moment it commits,
the room checks: if the record has not moved, the summary lands immediately
after the range it covers, contiguous and in order. If the record has moved,
the commit is refused, and the host hears the same `conflict` event a refused
seat raises, naming the aide and what it missed.

**A refused aide is told, in its own turn.** It writes by calling a tool
(§14), so the refusal reaches it the way a refused say reaches a seat: as the
tool's failure, listing what landed. The range widens to hold those messages,
and the aide drafts again over it immediately. It gets two drafts. After the
second refusal the room is moving faster than the aide writes, and the turn
ends rather than drafting for ever.

**A summary the turn could not land drafts again at the next quiescence.** Its
range is a live read, so the retry covers what it covered before plus whatever
won the race. The two halves of the rule divide the work: the aide redrafts
inside its turn while that is still useful, and the next quiet room catches a
turn that ran out of drafts or failed outright.

Two questions asked in quick succession become one summary, which is right:
they were one conversation. If somebody else's exchange won the race, it falls
inside the range too, and its person reads what happened while they were
waiting. That is the price of the race, it is not wrong, and one message still
serves.

Three things follow, and each removes a problem the design would otherwise
have.

**A summary is always contiguous with what it covers.** So `render.ts`
replaces a block that ends immediately before the summary, and a client folds a
run that ends at the message it just received. Neither has to reason about
interleaving.

**`settled()` keeps its meaning.** The exchange does not have to stay open
until its summary lands, and the room does not have to be held busy while an
aide writes. Quiescence is still simply "no agent is active".

**A failed model call is a refused commit with extra steps.** If the aide's
turn errors, no summary is written, the range stays uncompacted and fully
visible, and the next quiescence is another chance. The safe direction is the
default, and it takes no special case.

The event the room emits on a refusal is `conflict`, and it carries the author
and what they missed. It names the author rather than the seat, because the
lock is not about says alone.

---

## 6. Who owns an exchange

A room holds several people, and each may bring an aide. Only one writes per
exchange:

> **A person's question opens an exchange and owns it. Messages that land into
> an open exchange steer the seats already working and change nothing — not the
> owner, and not which aide writes at the close.**

The room holds one name while an exchange is open and drops it at the close.
That is run state, like the count of active seats. It does not survive a
restart, and neither does an exchange.

**An aide outlives its person's visit by one exchange.** Priya may ask and walk
out before the room settles. The exchange is still hers, it still closes, and
her aide still writes its summary — addressed to her, waiting for her. An
exchange that opened is finished properly or not at all, and a person leaving
is not a reason to leave the room's work unresolved.

Sam may speak into Priya's exchange. His message steers whoever is working, as
rule 2 says, and it neither opens an exchange nor changes who owns this one.
**Sam gets no summary for a question he did not ask.** His own next question
opens his own exchange, and his own aide writes it.

This is a default and the simplest one that works. Two variants are plausible
and neither is chosen now: every person present at the close gets a summary
from their own aide, or a person who speaks during an exchange joins its
ownership. Both cost more model calls per exchange.

---

## 7. A summary is not something said

The record gains one kind. It is not a `said`, because nobody said it. A
person did not hear it in a room; an aide wrote it.

```ts
/** What one exchange came to. An aide writes it. Nobody speaks it. */
export interface SummaryMessage {
  kind: 'summary';
  seq: Seq;
  at: string;
  /** The aide that wrote it. */
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
exchange came to. A summary carries two fields no other message has — a reader
and a span — because it is the only message written _for_ somebody, about a
range of the record.

**A summary is always addressed to its person.** `to` is the person whose
question opened the exchange, and it is never absent. That is what makes a
summary a message somebody was told rather than a note the room left itself.
A later room-level compactor, working over a stretch nobody asked about, is
writing a different thing and needs its own kind.

---

## 8. The record only grows. What a seat reads does not.

Two statements, and both hold.

**The record is append-only.** A summary takes the next seq and lands after
everything it covers. Nothing is deleted, nothing is rewritten, seqs are
monotonic, and `messages()` returns every message for ever. The past does not
change under a reader.

**A summarised range leaves the seats' context.** From the next activation,
the session renders the range as its count and the summary that stands for it:

```
· priya arrived                                               (2 hours ago)
── 11 messages, summarised below ──
[priya-aide → priya] Thursday is out: the inspector needs 48h notice and is
  not booked. Earliest is Saturday 30 Aug. It needs four things: …
[sam] Rain all Thursday morning. I am not pouring into that.  (12 min ago)
```

The question folds with the answers, because the range starts at the question
(§3). Nothing is lost by that: the summary answers what she asked, so it
carries the question inside it. `renderRecord` reads the fold off the record
itself — a summary carries the range it stands for — so the renderer keeps no
state and a seat reads the same room whoever renders it.

**Storage and context are different questions.** What a session keeps is the
record. What a seat is handed at an activation is a rendering of it, built
fresh each time by `render.ts`. This changes only the second, which is why it
costs the first nothing.

It is also what makes the design pay for the room and not only for the person.
Without it a seat's context grows with every message for ever. With it, an
exchange costs the room one message once it is over.

§9 says why that is safe to do, and §16 says what it still costs.

---

## 9. The record is discussion, not state

This is what makes §8 safe, and it is a constraint on how a room is built
rather than on what an aide writes.

**A product answers out of its own data.** `stock_check()` returns 11.7 tonnes
because that is what the materials tracker holds, not because somebody said so
on the record. No product in the measured run answered outside its own API. So
a fact that leaves a seat's context is not lost — the product that owns it
reads it again, on demand, the next time anybody asks.

**Anything that must survive an exchange belongs in a product's state.** What
a summary can genuinely lose is not a fact but a commitment: _"Sam confirms
rebar fixing by Friday"_, _"Dan approved the overtime"_. No API holds those
unless a product wrote them down. In the measured run the task list wrote three
of them, and one of them carried the entire Saturday contingency into T-121's
note.

That is the rule the room must keep for compaction to be safe:

> **The record is what was said. It is not where anything is kept.** A
> participant that establishes something durable writes it into the state it
> owns, in the same turn.

A room that keeps this loses nothing to a summary that it could not also have
lost to a person who stopped reading. A room that does not keep it is storing
its decisions in a transcript, and would have been fragile before an aide
existed.

---

## 10. Presentation belongs to the client

A person should not read the working. That is a statement about presentation,
and it is settled in the client, not in the record and not on the wire.

The runtime commits messages in order and streams them. What a client does
with them:

- **While the room works**, render the chatter as a thinking state. Somebody
  waiting sees that three products are working and can watch them do it, the
  way any agent's own reasoning is shown. They are not handed answers to read.
- **When the summary lands**, fold the range it covers back into that thinking
  state and show the summary as the answer. `covers` says which messages to
  fold.

This asks one thing of a client that a plain log does not do: **it must be
able to change how it presents past messages when a new message arrives.** A
client that only appends will show the working as conversation.

**Everybody present folds the same range.** Sam watching Priya's exchange sees
what she sees: the room thinking, then the answer it came to. This holds
whether or not Sam brought an aide of his own — folding follows the summary
that exists, not the reader. The working is hidden from every reader, because
it was working rather than conversation, and there is no per-person view to
keep straight.

The example client does the smaller half of this. A terminal cannot re-present
what it has already printed, so
[`main.ts`](../examples/site/src/main.ts) marks a summary with `∎` and prints
the span it stands for — `∎ priya-aide → priya (2–12)` — rather than folding
the lines above it. Folding is the job of a client that can re-render, and
`covers` is what it needs to do it.

---

## 11. Nothing an aide writes wakes anybody

A summary that woke the room would start a new exchange about the exchange it
just closed. So the routing rule refuses it — and it refuses on the author,
not on the kind:

```ts
function wakes(seat, target, message, fromAide) {
  if (fromAide) return false;
  ...
}
```

**The guard belongs to the author.** A guard on the message kind —
`isSummary(message)` — holds for the one thing an aide writes today and for
nothing it writes tomorrow. §12 lets an aide speak during an exchange, and a
rule about summaries does not cover that: the boundary would be prose rather
than code.

Written this way, one line enforces the whole of §12's rule at every rung. An
aide may say anything into a room that is already working, and none of it can
start work.

Every seat still **reads** everything an aide writes. Waking and reading were
always different questions.

---

## 12. What an aide may become

An aide is a person's counterpart, and the pull to give it more will be
constant. The functions form a ladder, and the rungs look adjacent but are
not:

1. **Consolidate.** Write the summary of an exchange. **This is the rung the
   runtime implements.**
2. **Hold preferences.** Shape that summary to what its person acts on. Comes
   with rung 1: it is the aide's instructions, not new machinery.
3. **Speak during the work.** Tell the seats mid-exchange that _"Priya will
   not act on cost unless it moves a date"_, or that nobody has answered what
   she asked. Rule 2 already carries this: a message steers the seats that are
   already active.
4. **Remind and criticise.** Raise what its person has been waiting on, and
   check the answer against the question before the exchange closes.

Rungs 3 and 4 are done **on behalf of its person, in a limited capacity**. The
aide is not passing on a message she wrote. It is holding her interest in a
room that is working, with authority she gave it by bringing it.

Two words carry the weight, and they are worth separating:

- **On behalf of** — the aide speaks in its own name, stamped `from` the aide,
  carrying her interest. It never speaks _as_ her. No message on the record
  ever bears her name because her aide wrote it. That is rule 7, at the one
  place it is most tempting to bend.
- **In a limited capacity** — it may shape what is already happening. It may
  not make anything happen.

Which is the rule that decides whether an aide is still an aide:

> **An aide shapes, and never wakes.** It may steer a seat that is already
> working. It may never activate one, never call a tool that changes a
> product's state, and never speak under its person's name.

§11 enforces the first half in one line, at every rung, because the guard is on
the author rather than on what it wrote. The rest is checkable by reading a
definition: an aide carries no tools of its own, and `defineHuman` refuses one
that does. What it holds is the runtime's, and the runtime hands it nothing
that reaches a product.

What the rule forbids, permanently:

- **Deciding.** An aide holds the brief. Its person holds the decision.
- **Acting as them.** See above; the runtime stamps `from`, so this is not a
  matter of good behaviour.
- **Causing work.** A room that woke because somebody's aide wanted something
  is a room being run by a proxy.

Rungs 3 and 4 are named so that building them is a decision rather than a
drift. Only rung 1 is specified below.

Rung 1 gives them a shape to arrive in. An aide writes by calling a tool, so
rung 3 is a second tool — a `say` that speaks into a room already working —
rather than a new mechanism. §11's guard is what keeps that safe: it refuses
on the author, so nothing an aide says through any tool can wake a seat. The
tools an aide holds are the runtime's own, and they reach the record and
nothing else; a tool into a product's state is what §12 forbids, and what
`defineHuman` refuses.

---

## 13. It is optional

A person may bring an aide. Most will. Nothing requires it.

**A question from somebody with no aide is never summarised.** The exchange it
opens runs and closes with nothing written at the end of it, every reader sees
it whole, and no range leaves any seat's context. A room where nobody brings
an aide is a room an aide changes in no respect.

That is the guarantee this design offers: **it adds one message, and it takes
nothing away that anybody can still reach.**

---

## 14. The shape

One optional field, and no method:

```ts
const priya = defineHuman({
  name: 'priya',
  identity: 'Project manager, site office. Owns the programme.',
  aide: defineAgent({
    name: 'priya-aide',
    identity: "Holds Priya's brief.",
    model: 'anthropic/claude-sonnet-5',
    instructions: `
      Answer Priya's question, once, for somebody who has not read the working.
      Lead with the decision she has to make and who holds it. Keep the facts a
      colleague would need to work from — quantities, dates, owners, and what
      is still unknown. Leave out who said what, and in which order.
    `,
  }),
});
```

**A host never asks for a summary.** It is how the session works, not
something the caller drives. A question opens an exchange, the room works, the
room settles, and — if the room said more than one thing — the summary is
written and committed. It arrives on the `message` event that carries every
message on the record:

```ts
session.subscribe((event) => {
  if (event.type !== 'message') return;
  if (event.message.kind === 'summary') showAnswer(event.message);
  else showThinking(event.message);
});
```

`Visit` is unchanged, and there is no cursor to pass: the exchange names its
own span. `defineHuman` takes one optional field, the record holds one more
kind, and a person's seat names the aide they brought (`SeatInfo`, in
[`presence.md`](presence.md) §10). **That is the whole surface.**

**`settled()` does not wait for an aide.** It reports that no agent is active,
which is the meaning §5 needs it to keep, and the aide starts after that. So a
host that wants the summary before it does the next thing waits for the
`message` event that carries it, rather than for the room. Nothing holds the
room busy while an aide writes.
[`examples/site/src/demo.ts`](../examples/site/src/demo.ts) shows that wait,
and it is the only thing an aide asks of a host.

**What an aide is handed.** The room's goal, the roster, and the range it is
about to cover — the question and every message after it. Not the record before
that range: a summary its person has already read is theirs, not its. A refused
draft is told what landed, in the failure the tool returns, and the range it
drafts again over holds those messages too.

**What an aide is given.** A model, instructions, and one tool of the
runtime's: `summarise({ text })`. It writes to the record and nothing else — no
`to`, because a summary is always addressed to its person. `defineHuman`
refuses an aide that carries tools of its own, so §12's rule — never call a
tool that changes a product's state — stays a fact about the definition rather
than a promise about behaviour.

**Writing is a tool, and silence is a decision.** An aide that ends its turn
without calling `summarise` leaves the range whole, and every reader still sees
all of it. That is rule 3 of the core, for an aide: when the room's answer
already reads as one answer, standing between a person and it would only add a
voice. The threshold in §4 sits underneath as a cost floor — below it the room
spends no model call at all — and above it the judgment is the aide's, where
the rest of the judgment lives.

**A turn is bounded by the tool, not by the model's good sense.** Two drafts
per turn (§5), and a cap on how often the tool may be called at all. A model
that keeps calling a tool that keeps refusing would draft for ever, so the
tool ends the turn itself rather than asking the model to stop. Nothing else
here bounds a turn — which is [`agent.md`](agent.md) §7's gap, closed where it
can be closed.

**What the room reads it as.** A seat's context carries one paragraph about
folds, and only in a room where somebody brought an aide. A room with no aide
in it renders no fold, and no paragraph about one.

**Where its turn lands.** In a downstream session, `<room>:<person>`, beside
the seats' own. Rule 8 keeps every activation auditable after the fact, and a
summary is written by a model like any other turn. The one message that reaches
a person should be the easiest thing in the room to check.

---

## 15. What this is not

Stated so a later change has to argue with it:

- **Not catch-up.** A person returning after two days is
  [`presence.md`](presence.md) §8's business, and its anchor is untouched.
  Arriving opens no exchange.
- **Not a working group.** Nothing convenes and nothing has members.
- **Not a new activation trigger.** No seat wakes because the room went quiet.
- **Not a summariser of everything.** One answer is left as it was given, and
  anything outside an exchange is untouched.
- **Not deletion.** The record keeps every message. Only a seat's context
  changes. §8.
- **Not a place to keep anything.** A participant writes what must survive into
  the state it owns. §9.
- **Not an orchestrator.** §12 draws the line and names what is forbidden.
- **Not an obligation.** A person may have none, and then nothing changes.

---

## 16. Open questions

**What a summary loses, and why that is accepted.** A summarised range leaves
the seats' context, so a fact the summary drops is gone from every later
activation. That is accepted, on two conditions the design states rather than
hopes for.

The first is symmetry. **What never entered a person's context cannot come
back as a question they ask.** They read the summary; the seats read the
summary. Neither can be surprised by the other, because they hold the same
premise — and the seats hold strictly more, since they also have everything
after it and their own tools. The room is never behind the person it is
answering.

The second is §9. A fact is re-derivable, because the product that owns it
reads it again. A commitment is durable, because whoever made it wrote it into
their own state. **A room that keeps §9 loses nothing to a summary that it
would not also lose to a person who stopped reading.**

What remains, and is not solved: a person carries context from outside the
session. Priya reads a delivery note on her desk and asks about a tonnage no
summary prepared her for. The seats answer anyway, out of their own APIs —
which is §9 again. The case that would genuinely break is a question about
something established in a summarised range that no product owns, and §9
exists to keep that class empty. Whether a real room keeps §9 is the thing to
watch.

**Quiescence is a reason to spend money.** No seat activates when the room
settles, so rule 1 keeps its letter. But the room makes a model call that no
message asked for, and that is a second kind of trigger. It is the seam where
a later feature will want to hang an interim summary or a room-level
compactor. §15 forbids both by name; the mechanism to add them exists.

**A run that stops mid-exchange writes no summary.** `stopSession` aborts the
turns in flight, so the exchange never closes. It aborts a draft in flight for
the same reason, and a draft that does finish after the stop commits nothing.
The person asked and heard nothing, and the record shows a question, some work
and a shutdown. Accepted.

**A first summary reaches back as far as the record does.** `from` is the seq
after this person's last summary, and a person who has none is covered from
their first question. In a room they have used for a week without an aide,
their first summary covers the week. The rule is right — they have read none
of it — but the first one is expensive, and nothing bounds it. A person who
joins a long record is the case to watch.

**A summary can be owed for ever.** A race is handled inside the turn, but a
turn that fails outright, or that runs out of drafts, waits for the next
quiescence — and a room that is never woken again never has one. The range
stays whole and every reader still sees it, so nothing is lost; but the one
message never arrives, and nothing reports that it is owed. A run that ends
the day with an owed summary is the case to watch.

**What a client owes.** §10 asks a client to re-present past messages when a
new one arrives. That is more than a log does, and no client in this repository
does it.

**The room still chatters.** An aide makes ten messages readable. It does not
make the room produce fewer, and the say instruction still rewards adding
something the record does not hold. Whether better prompting halves the
chatter is one run away, and it would change what an aide has to do.

---

## 17. What proves it

The milestone tests live in
[`aide.test.ts`](../packages/ambion/test/aide.test.ts), one per claim this
document makes loudly:

- An exchange the room answered twice closes into one message, addressed to
  its person, contiguous with the range it covers, drafted from that range and
  with one hand that reaches the record and nothing else. §3, §4, §7, §14.
- One answer is left as it was given, in the voice that gave it. §4.
- A person with no aide is never summarised, in a room whose prompt does not
  mention a fold. §13.
- A summary wakes nobody, and the next activation reads the fold and the
  summary in place of the messages, while the record keeps every one of them.
  §8, §11.
- A question that lands while a seat works on what nobody asked for still
  opens an exchange and owns it. §3.
- A draft refused because the room moved raises `conflict`, and the aide
  redrafts over the widened range inside the same turn. §5.
- An aide that keeps drafting into a room that keeps moving is stopped by the
  runtime rather than by its own good sense, and writes at the next
  quiescence. §5, §14.
- An aide that stands down without writing is owed nothing for it. §14.
- A turn that fails outright leaves the summary owed until the next quiet
  room. §16.
- The person whose question opened the exchange owns it, and a second person
  speaking into it gets nothing. §6.
- An aide outlives its person's visit by one exchange. §6.
- An aide's turns land in `<room>:<person>`, and the aide it brought is named
  on the seat a host reads. §14.
- `defineHuman` refuses an aide that holds tools or takes its person's name,
  and `visitSession` refuses one whose name the room already holds. §12, §14.

All in-process, in vitest, on a scripted stream.

The runnable proof is [`examples/site`](../examples/site), where each of the
three people brings an aide, and what each of them acts on lives in that aide
rather than in every product's instructions.

---

## 18. What would still prove it

The tests prove the mechanism. They do not prove that the one message is worth
reading, and that needs a live run.

Run the same scenario twice: once with the aides taken out of
[`workspace.ts`](../examples/site/src/workspace.ts), and once as it stands.

It works if Priya's summary answers what she asked and reads whole to somebody
who has not read the working; if the two messages outside her exchange are
untouched and still in the product's own voice; if the record holds every
message plus the summaries with nothing rewritten; if a seat's context at the
tenth activation is smaller with the aides than without them; and if **a seat
activated after the summary can still do its job from it.** The scripted run
asks that last question outright: Priya comes back and asks a follow-up whose
answer is inside the range that has left every seat's context.

It fails if the summary reads like minutes rather than an answer, if a seat
answers worse after the range leaves its context, or if the record has to
change shape to make the presentation work.

Three numbers: how many messages a person reads per question, how large a
seat's context is at the tenth activation with and without an aide, and
whether the answers hold up. The run in [`demos/`](../demos) is the
baseline — three questions, 17 of 19 agent messages inside them, 148,038
characters of context over 25 activations. **That comparison is not run.**
