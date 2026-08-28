# The aide

This document is the design for the aide: the optional agent a person brings
into a session, which holds their brief and turns the room's work into one
message they read. **Nothing here is built.** Read [`agent.md`](agent.md) and
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
they act on, what they ignore, how long an answer they read. Today the demo
puts those inside each product's instructions, so every product carries a copy
of every person. That is a modelling error. What Priya wants belongs to Priya.

**An aide never decides and never acts as its person.** `deliver` stays the
person's own act, in their own words. §12 draws that line and says how far the
role may grow.

The name sets the authority. An aide briefs, reminds, and says _"she will want
the tonnage"_. It does not run the room and it does not answer for anyone.

---

## 3. The exchange

The unit is the **exchange**: a question, and everything the room does until it
goes quiet again. The room goes from idle, to active, and back to idle.

- **It opens** when a person's `said` lands in an idle room.
- **It closes** when no agent is active. `settled()` resolves.

**Only a question opens one.** Arriving and leaving are messages, and they may
wake a seat, but they open no exchange and are never summarised. A room where
nobody asks anything is never summarised at all.

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
the commit is refused and the aide is handed what it missed — the same
`missed` list a seat gets, for the same reason.

**A refused summary drafts again at the next quiescence.** Its range is a live
read, so the retry covers what it covered before plus whatever won the race.
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
default, and it needed no special case.

One naming consequence: the event the room emits on a refusal is currently
`say_conflict`. The lock is not about says any more. It should be `conflict`,
carrying the author and what they missed.

---

## 6. Who owns an exchange

A room holds several people, and each may bring an aide. Only one writes per
exchange:

> **A person's question into an idle room opens an exchange and owns it.
> Messages that land while the room is active steer the seats already working
> and change nothing — not the owner, and not which aide writes at the close.**

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
the session renders the range as its summary instead of its messages:

```
[priya] Can I tell the client Thursday for the pour?          (2 hours ago)
── 10 messages, summarised below ──
[priya-aide → priya] Thursday is out: the inspector needs 48h notice and is
  not booked. Earliest is Saturday 30 Aug. It needs four things: …
[sam] Rain all Thursday morning. I am not pouring into that.  (12 min ago)
```

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

---

## 11. Nothing an aide writes wakes anybody

A summary that woke the room would start a new exchange about the exchange it
just closed. So the routing rule refuses it — and it refuses on the author,
not on the kind:

```ts
function wakes(seat, target, message) {
  if (fromAide(message)) return false;
  ...
}
```

**The guard belongs to the author.** An earlier draft put it on the message
kind, `isSummary(message)`, which held for the one thing an aide writes today
and would have held for nothing it writes tomorrow. §12 lets an aide speak
during an exchange; a rule about summaries would not have covered that, and
the boundary would have been prose rather than code.

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

1. **Consolidate.** Write the summary of an exchange. **This is what gets
   built.**
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
definition: an aide is given no tools.

What the rule forbids, permanently:

- **Deciding.** An aide holds the brief. Its person holds the decision.
- **Acting as them.** See above; the runtime stamps `from`, so this is not a
  matter of good behaviour.
- **Causing work.** A room that woke because somebody's aide wanted something
  is a room being run by a proxy.

Rungs 3 and 4 are named so that building them is a decision rather than a
drift. Only rung 1 is specified below.

---

## 13. It is optional

A person may bring an aide. Most will. Nothing requires it.

**A question from somebody with no aide is never summarised.** The exchange it
opens runs and closes as it does today, every reader sees it whole, and no
range leaves any seat's context. A room where nobody brings an aide behaves in
every respect as the room behaves now.

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
own span. `defineHuman` gains one optional field and the record gains one
kind. **That is the whole surface.**

**What an aide is handed.** The room's goal, the roster, and the range it is
about to cover — the question and every message after it. Not the record before
that range: a summary its person has already read is theirs, not its. On a
refused commit it is handed the same `missed` list a seat gets, and drafts
again over the widened range.

**What an aide is given.** A model and instructions, and no tools. §12's rule —
never call a tool that changes a product's state — is then a fact about the
definition rather than a promise about behaviour.

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
exists to keep that class empty. Whether a real room keeps §8 is the thing to
watch.

**Quiescence is now a reason to spend money.** No seat activates when the room
settles, so rule 1 keeps its letter. But the room now makes a model call that
no message asked for, and that is a new kind of trigger. It is the seam where
a later feature will want to hang an interim summary or a room-level
compactor. §15 forbids both by name; the mechanism to add them exists.

**A run that stops mid-exchange writes no summary.** `stopSession` aborts the
turns in flight, so the exchange never closes. The person asked and heard
nothing, and the record shows a question, some work and a shutdown. Accepted.

**What a client owes.** §10 asks a client to re-present past messages when a new
one arrives. That is more than a log does, and no client here has done it.

**The room still chatters.** An aide makes ten messages readable. It does not
make the room produce fewer, and the say instruction still rewards adding
something the record does not hold. Whether better prompting halves the
chatter is one run away, and it would change what an aide has to do.

---

## 17. What would prove it

Run the same scenario twice: once as it stands, and once with an aide for
Priya.

It works if her summary answers what she asked and reads whole to somebody who
has not read the working; if the two messages outside her exchange are
untouched and still in the product's own voice; if the record holds all thirty
messages plus the summaries with nothing rewritten; if a seat's context at the
tenth activation is smaller than it is today; and if **a seat activated after
the summary can still do its job from it.** Test the last by asking a
follow-up whose answer is inside the summarised range.

It fails if the summary reads like minutes rather than an answer, if a seat
answers worse after the range leaves its context, or if the record has to
change shape to make the presentation work.

Three numbers: how many messages a person reads per question, how large a
seat's context is at the tenth activation with and without an aide, and
whether the answers hold up. The run in [`demos/`](../demos) is the
baseline — three questions, 17 of 19 agent messages inside them, 148,038
characters of context over 25 activations.
