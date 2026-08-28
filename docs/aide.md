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
person's own act, in their own words. §10 draws that line and says how far the
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

An exchange covers itself and nothing else: `from` is the question's seq,
`through` is the last seq at the close. **It never reaches back past the
question.**

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
> message from other participants. One message needs no consolidation.**

It counts messages, not speakers. The measured run's worst moment was one
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

## 5. Who owns an exchange

A room holds several people, and each may bring an aide. Only one writes per
exchange:

> **A person's question into an idle room opens an exchange and owns it.
> Messages that land while the room is active steer the seats already working
> and change nothing — not the owner, and not which aide writes at the close.**

The room holds one name while an exchange is open and drops it at the close.
That is run state, like the count of active seats. It does not survive a
restart, and neither does an exchange.

Sam may speak into Priya's exchange. His message steers whoever is working, as
rule 2 says, and it neither opens an exchange nor changes who owns this one.
**Sam gets no summary for a question he did not ask.** His own next question
opens his own exchange, and his own aide writes it.

This is a default and the simplest one that works. Two variants are plausible
and neither is chosen now: every person present at the close gets a summary
from their own aide, or a person who speaks during an exchange joins its
ownership. Both cost more model calls per exchange.

---

## 6. A summary is not something said

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
  /** The exchange it stands for: the question, and the work it caused. */
  covers: { from: Seq; through: Seq };
}

export type Message = SpokenMessage | PresenceMessage | SummaryMessage;
```

Three kinds, and each earns its name. `said` is what a participant told the
room. `arrived` and `left` are what a person did. `summary` is what one
exchange came to. A summary carries two fields no other message has — a reader
and a span — because it is the only message written _for_ somebody, about a
range of the record.

The kind is named for what it is rather than for who wrote it. An aide writes
these today. A room-level compactor might write one later, over a stretch
nobody asked about, and the record would not need a fourth kind for it.

---

## 7. The record only grows. What a seat reads does not.

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

§14 states what that costs: a summary that drops a fact takes it out of every
later context, and the seat that needs it does not know it is missing.

---

## 8. Presentation belongs to the client

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
what she sees: the room thinking, then the answer it came to. The working is
hidden from every reader, because it was working rather than conversation.
There is no per-person view to keep straight.

---

## 9. A summary wakes nobody

A summary that woke the room would start a new exchange about the exchange it
just closed.

The routing rule says so directly:

```ts
function wakes(seat, target, message) {
  if (isSummary(message)) return false;
  ...
}
```

One line, and it says what it means. An earlier draft leaned on an accident
instead — a `said` directed at a person resolves to no agent, so it happens to
wake nothing. A named kind lets the rule be stated rather than discovered.

Every seat still **reads** every summary. Waking and reading were always
different questions.

---

## 10. What an aide may become

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

All four keep one rule, and it is the rule that decides whether an aide is
still an aide:

> **An aide shapes, and never wakes.** It may steer a seat that is already
> working. It may never activate one, never call a tool that changes a
> product's state, and never speak under its person's name.

That is checkable rather than tasteful. What it forbids, permanently:

- **Deciding.** An aide holds the brief. Its person holds the decision.
- **Acting as them.** No message on the record ever carries their name because
  their aide wrote it. Rule 7 is at its most tempting here.
- **Causing work.** A room that woke because somebody's aide wanted something
  is a room being run by a proxy.

Rungs 3 and 4 are named so that building them is a decision rather than a
drift. Only rung 1 is specified below.

---

## 11. It is optional

A person may bring an aide. Most will. Nothing requires it.

**A question from somebody with no aide is never summarised.** The exchange it
opens runs and closes as it does today, every reader sees it whole, and no
range leaves any seat's context. A room where nobody brings an aide behaves in
every respect as the room behaves now.

That is the guarantee this design offers: **it adds one message, and it takes
nothing away that anybody can still reach.**

---

## 12. The shape

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

---

## 13. What this is not

Stated so a later change has to argue with it:

- **Not catch-up.** A person returning after two days is
  [`presence.md`](presence.md) §8's business, and its anchor is untouched.
  Arriving opens no exchange.
- **Not a working group.** Nothing convenes and nothing has members.
- **Not a new activation trigger.** No seat wakes because the room went quiet.
- **Not a summariser of everything.** One answer is left as it was given, and
  anything outside an exchange is untouched.
- **Not deletion.** The record keeps every message. Only a seat's context
  changes. §7.
- **Not an orchestrator.** §10 draws the line and names what is forbidden.
- **Not an obligation.** A person may have none, and then nothing changes.

---

## 14. Open questions

**A summary is lossy, and the loss is invisible to whoever it hurts.** This is
the risk that decides the design, and it is back because §7 is back. Materials
established _"stock 11.7t against 11.7t required — full cover."_ If the summary
says "rebar is covered", a later question about tonnage cannot be answered from
the seat's context, and the seat does not know the number is missing. The
aide's instructions make completeness its duty, which is a prompt, not a
guarantee. Three answers exist and none is chosen: give a seat a tool that
reads a covered range; hold a range uncompacted for one further exchange; or
accept the loss and measure it. **Do not build past this question.**

**Quiescence is now a reason to spend money.** No seat activates when the room
settles, so rule 1 keeps its letter. But the room now makes a model call that
no message asked for, and that is a new kind of trigger. It is the seam where
a later feature will want to hang an interim summary or a room-level
compactor. §13 forbids both by name; the mechanism to add them exists.

**A run that stops mid-exchange writes no summary.** `stopSession` aborts the
turns in flight, so the exchange never closes. The person asked and heard
nothing, and the record shows a question, some work and a shutdown. Accepted.

**What a client owes.** §8 asks a client to re-present past messages when a new
one arrives. That is more than a log does, and no client here has done it.

**The room still chatters.** An aide makes ten messages readable. It does not
make the room produce fewer, and the say instruction still rewards adding
something the record does not hold. Whether better prompting halves the
chatter is one run away, and it would change what an aide has to do.

---

## 15. What would prove it

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
