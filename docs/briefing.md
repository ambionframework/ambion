# The briefing agent

This document is the design for the briefing agent: the optional agent a
person brings, which consolidates the answer when a question wakes several
agents and they talk it out. **Nothing here is built.** Read
[`agent.md`](agent.md) and [`presence.md`](presence.md) first.

One sentence:

> **A person asks a question. Several agents wake and work it out between
> them. When the room goes quiet, that person's briefing agent writes the one
> message the exchange resolved to — and from then on that message stands in
> for the chatter, for everybody and for every seat activated afterwards.**

This design covers one thing: **a question, the agents that answer it, and
hiding the working.** It is not about presence, catch-up, or what a person
sees when they arrive. [`presence.md`](presence.md) owns those and this
document changes none of them.

---

## 1. The problem, measured

The run in [`demos/`](../demos) is the evidence.

**A person reads a transcript instead of an answer.** Priya asked one
question: _can I tell the client Thursday for the pour?_ It woke three
products. They answered her, answered each other, corrected each other and
refined their own answers. Ten agent messages landed before she left. Four
addressed her. The room established that Thursday was impossible, why, and
what would make Saturday possible. It never assembled that into an answer,
because no participant has assembling as its job.

**The room re-reads all of it, for ever.** Each activation renders the whole
record into a seat's context. Over 25 activations that run built 148,038
characters of context, and **the record was 77% of it**. The first context was
1,259 characters. The last was 10,081. Thirty messages did that.

One thing answers both: **something has to stand in for an exchange once it is
over.**

---

## 2. The exchange

The unit is the **exchange**: a question, and everything the room does until
it goes quiet again.

- **It opens** when a person's `said` lands in an idle room.
- **It closes** when no agent is active. `settled()` resolves.

**Only a question opens one.** Arriving and leaving are messages, and they may
wake a seat, but they do not open an exchange and are never briefed. A room
where nobody asks anything is never briefed at all.

**Quiescence is a true end, not a gap.** A seat that says something activates
its readers inside its own `say`, before its own turn finishes, so the active
count never dips to zero in the middle of a burst. A room that settles has
finished, and will not start again on its own.

Nothing between the edges needs counting. However many agents wake, however
many times they answer each other, however many turns it takes — the exchange
is done when the room is done.

An exchange covers itself and nothing else: `from` is the question's seq,
`through` is the last seq at the close. **It never reaches back past the
question.** Whatever happened before the person asked is not theirs to be
briefed on, and is somebody else's exchange or nobody's.

---

## 3. One exchange, one message

The rule the design serves:

> **Every exchange resolves to exactly one message for the person who asked.**

Most of the time the room may already have done that. One product answers,
once, and that message is the answer. **A briefing agent does not engage.** The
person reads what the product said, in that product's own words, with its own
evidence.

It engages when the room did not:

> **A briefing is written when an exchange closes and holds more than one
> message from other participants. One message needs no consolidation.**

It counts messages, not speakers. The measured run's worst moment was one
product saying four separate things to Priya, and that needs consolidating as
much as three products saying one each.

What the run shows:

| In the measured run                   |              |
| ------------------------------------- | ------------ |
| Questions asked                       | 3            |
| Exchanges that would write a briefing | 3            |
| Exchanges that would pass through     | 0            |
| Agent messages consolidated           | **17 of 19** |
| Agent messages outside any exchange   | 2            |

**Every question in this run drew more than one answer, so the threshold never
fired.** It is a rule about a case this run does not contain, and it is kept
because the case is real: a single clean answer should reach a person in the
voice that gave it. The two messages outside any exchange — a product speaking
when somebody arrived — stay exactly as they are, because no question opened
them.

An exchange with no agent message writes nothing. The room had nothing to say,
and telling the person so is a host's business, not the record's.

---

## 4. Who owns an exchange

A room holds several people, and each may bring a briefing agent. Only one
writes per exchange:

> **A person's question into an idle room opens an exchange and owns it.
> Messages that land while the room is active steer the seats already working
> and change nothing — not the owner, and not which briefing agent writes at
> the close.**

The room holds one name while an exchange is open and drops it at the close.
That is run state, like the count of active seats. It does not survive a
restart, and neither does an exchange.

Sam may speak into Priya's exchange. His message steers whoever is working, as
rule 2 says, and it neither opens an exchange nor changes who owns this one.
**Sam gets no briefing for a question he did not ask.** His own next question
opens his own exchange, and his own briefing agent writes it.

This is a default, and the simplest one that works. Two variants are plausible
and neither is chosen now: every person present at the close gets a briefing
from their own agent, or a person who speaks during an exchange joins its
ownership. Both cost more model calls per exchange, and neither is worth
paying for before the default has run.

---

## 5. A briefing is not something said

The record gains one kind. It is not a `said`, because nobody said it. A
person did not hear it in a room; a briefing agent wrote it for them.

```ts
/** What one person was told. A briefing agent writes it. Nobody speaks it. */
export interface BriefingMessage {
  kind: 'briefing';
  seq: Seq;
  at: string;
  /** The briefing agent that wrote it. */
  from: string;
  /** The person whose question opened the exchange. Always present. */
  to: string;
  text: string;
  /** The exchange it stands in for: the question, and the work it caused. */
  covers: { from: Seq; through: Seq };
}

export type Message = SpokenMessage | PresenceMessage | BriefingMessage;
```

Three kinds, and each earns its name. `said` is what a participant told the
room. `arrived` and `left` are what a person did. `briefing` is what a person
was told. A briefing carries two fields no other message has — a reader and a
span — because it is the only message written _for_ somebody rather than _to_
the room.

---

## 6. What the room shows afterwards

**One record, one rendering, for everybody.** Where a briefing covers an
exchange, the exchange renders as the briefing — in a seat's context, in a
person's view, in the host's log:

```
[priya] Can I tell the client Thursday for the pour?          (2 hours ago)
── 10 messages stand summarised below ──
[priya-brief → priya] Thursday is out: the inspector needs 48h notice and is
  not booked. Earliest is Saturday 30 Aug. It needs four things: …
[sam] Rain all Thursday morning. I am not pouring into that.  (12 min ago)
```

There is no per-reader view to keep straight. Priya sees her briefing instead
of the chatter, and so do Sam, Dan and every product. **The working is hidden
from everyone, because it was working, not conversation.**

Everything outside an exchange renders as it always did. A product that speaks
when somebody arrives is read in its own words.

**Compaction is a rendering rule, not a deletion.** The record keeps every
message for ever, `messages()` returns all of them, and seqs do not move — so
the say lock and the catch-up anchor are untouched. What changes is what a
reader is handed. That is why this belongs in `render.ts`, beside the room's
other prose, and why a host can always expand a covered span if it wants to
offer that.

---

## 7. One briefing, because it is the shared premise

A briefing has two readers: its person, and every seat activated afterwards.
The temptation is to write two documents — one shaped for the person, one
complete for the room.

**Do not.** The briefing is the one thing both the person and the room are
guaranteed to have read. It is their shared premise. Two accounts of one
exchange means the person's next question rests on one and the answer rests on
the other, and neither side can tell that they have diverged.

Two things follow.

**A briefing stands alone.** It cannot say "as discussed above", name who
raised what, or assume its reader saw a message it covers. A follow-up
question will be asked against it, and answered from it.

**What a briefing agent personalises is bounded.**

> **A briefing agent chooses order, emphasis, and length. It does not choose
> what the room remembers.**

Priya's briefing agent may lead with the decision she holds and put the
tonnage last. It may not drop the tonnage, because dropping it is not a way of
writing — it is the room forgetting. §13 says what that costs.

---

## 8. A briefing wakes nobody

A briefing that woke the room would start a new exchange about the exchange it
just closed.

The routing rule says so directly:

```ts
function wakes(seat, target, message) {
  if (isBriefing(message)) return false;
  ...
}
```

One line, and it says what it means. An earlier draft leaned on an accident
instead — a `said` directed at a person resolves to no agent, so it happens to
wake nothing. A named kind lets the rule be stated rather than discovered.

Every seat still **reads** every briefing. Waking and reading were always
different questions.

---

## 9. What a briefing agent is

A briefing agent is the writer of one message, for the questions its person
asks that draw more than one answer.

**It does not participate.** It holds no seat, takes no turn, appears on no
roster, and is never activated. It cannot start work, join work or stop work.

**It does not act for its person.** `deliver` stays the person's own act, in
their own words. A briefing is stamped `from` the briefing agent and never
from the person: rule 7 holds, and this is the most tempting place to break
it.

The name says the whole job. It briefs one person, on one exchange, and that
is all it does.

---

## 10. It is optional

A person may bring a briefing agent. Most will. Nothing requires it.

**A question from somebody with no briefing agent is never briefed.** The
exchange it opens runs and closes as it does today, and the record shows it
whole, to everyone. A room where nobody brings one behaves in every respect as
the room behaves now.

That is the guarantee this design offers, and the reason it is safe to try:
**it adds a writer, and it takes nothing away.**

---

## 11. The shape

One optional field, and no method:

```ts
const priya = defineHuman({
  name: 'priya',
  identity: 'Project manager, site office. Owns the programme.',
  briefingAgent: defineAgent({
    name: 'priya-brief',
    identity: 'Writes the briefings Priya reads.',
    model: 'anthropic/claude-sonnet-5',
    instructions: `
      Answer Priya's question, once, for somebody who has read nothing else.
      Lead with the decision she has to make and who holds it. Keep every fact
      a colleague would need to work from — quantities, dates, owners, and
      what is still unknown. Leave out who said what, and in which order.
    `,
  }),
});
```

**A host never asks for a briefing.** Briefing is how the session works, not
something the caller drives. A question opens an exchange, the room works, the
room settles, and — if the room said more than one thing — the briefing is
written and committed. It reaches a host on the `message` event that carries
every message on the record:

```ts
session.subscribe((event) => {
  if (event.type !== 'message') return;
  if (event.message.kind === 'briefing') render(event.message);
});
```

`Visit` is unchanged, and there is no cursor to pass: the exchange names its
own span. `defineHuman` gains one optional field and the record gains one
kind. **That is the whole surface.**

---

## 12. What this is not

Stated so a later change has to argue with it:

- **Not catch-up.** A person returning from two days away is
  [`presence.md`](presence.md) §8's business, and the anchor there is
  untouched. Arriving opens no exchange and writes no briefing.
- **Not a working group.** Nothing convenes and nothing has members. The
  exchange is bounded by quiescence, so who took part needs no recording.
- **Not a new activation trigger.** Nothing wakes because the room went quiet.
  A briefing agent is called, never activated.
- **Not a summariser of everything.** One answer is left as it was given, and
  anything outside an exchange is untouched.
- **Not a deletion.** Compaction renders. The record forgets nothing.
- **Not two accounts.** One briefing, because it is the shared premise. §7.
- **Not an obligation.** A person may have none, and then nothing changes.
- **Not speaking for a person.** Ever.

---

## 13. Open questions

**Compaction is lossy, and the loss is invisible to whoever it hurts.** This
decides whether the design is good. Materials established _"stock 11.7t
against 11.7t required — full cover."_ If the briefing says "rebar is
covered", a later question about tonnage cannot be answered, and the seat that
needs the number does not know it is missing. §7 makes this the briefing
agent's strictest duty, which is a prompt, not a guarantee. Three real answers
exist and none is chosen here: give a seat a tool that reads a covered span;
keep a covered span uncompacted for one further exchange; or accept the loss
and measure it. **Do not build past this question.**

**A person waits with nothing.** Priya asks and reads nothing until the room
settles — twelve activations in the measured run. Showing progress means
showing the working, which is what the design hides. An interim line is a
second account, which §7 forbids. This is unresolved.

**An exchange with no end never briefs.** Two agents that keep answering each
other never settle. The room has no turn limit today and this design does not
add one, but it is the first thing that would notice the absence.

**A run that stops mid-exchange writes no briefing.** `stopSession` aborts the
turns in flight, so the exchange never closes. The chatter stays on the record
uncompacted, and the person got no answer. That is honest, and it is also the
worst case: the person asked and heard nothing.

**A room without questions never compacts.** Agents working unattended, and
rooms where nobody brings a briefing agent, produce records that nothing
checkpoints. The growth in §1 continues. A room-level compactor is the obvious
answer and is not designed here.

**Briefings of briefings.** A later briefing covers an exchange whose span
already holds one. That is how a long-lived room stays bounded, and it makes
the record a tree rather than a line. One level is enough to test the idea.

---

## 14. What would prove it

Run the same scenario twice: once as it stands, and once with a briefing agent
for Priya.

It works if her briefing answers what she asked and reads as a whole to
somebody who has seen nothing else; if the two messages outside her exchange
are untouched and still in the product's own voice; if the record still holds
all thirty messages; if the run without a briefing agent is unchanged; and if
**a seat activated after the briefing can still do its job from it.** The way
to test that last one is to ask a follow-up whose answer is buried in the
compacted span.

It fails if the briefing reads like minutes rather than an answer, if a seat
answers worse after compaction than before, or if a person has to expand the
covered span to trust what they were told.

Three numbers: how many messages reach the person, how large a seat's context
is at the tenth activation with and without briefings, and whether the answers
hold up. The run in [`demos/`](../demos) is the baseline — 148,038 characters
of context over 25 activations, 77% of it record, and 17 of 19 agent messages
sitting inside three exchanges.
