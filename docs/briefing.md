# The briefing agent

This document is the design for the briefing agent: the optional agent a
person brings, which turns a room's answer into one message when the room
gave more than one. **Nothing here is built.** Read [`agent.md`](agent.md)
and [`presence.md`](presence.md) first.

One sentence:

> **A person's exchange resolves to one message. When the room answered with
> one, that message is it. When the room answered with eleven, the person's
> briefing agent writes the one — and from then on it stands in for the
> eleven, for the person and for every seat activated afterwards.**

---

## 1. Two problems, both measured

The run in [`demos/`](../demos) is the evidence for both.

**A person reads a transcript instead of an answer.** Priya asked one
question: _can I tell the client Thursday for the pour?_ Her question woke
three products. They answered her, answered each other, corrected each other
and refined their own answers. Ten agent messages landed before she left. Four
addressed her. The room established that Thursday was impossible, why, and
what would make Saturday possible. It never assembled that into an answer,
because no participant has assembling as its job.

**The room re-reads everything, for ever.** Each activation renders the whole
record into a seat's context. Over 25 activations that run built 148,038
characters of context, and **the record was 77% of it**. The first context was
1,259 characters. The last was 10,081. Thirty messages did that.

A room that waits for months is the point of an ambient runtime. This one
could not afford a week. Both problems have one answer: **something has to
stand in for an exchange once it is over.**

---

## 2. It is optional, and the room without it is the room today

A person may bring a briefing agent. Most will. Nothing requires it.

**A person with no briefing agent reads the record.** All of it, chatter
included, exactly as they do today. No briefing is written on their account
and no span is compacted on their account. A room where nobody brings one
behaves in every respect as the room behaves now.

That is the guarantee this design offers, and the reason it is safe to try:
**it adds a reader, and it takes nothing away.**

One record then has three readers, and they see three different things:

| Reader                         | Sees                                        |
| ------------------------------ | ------------------------------------------- |
| A person with a briefing agent | Their own messages, and one per exchange    |
| A person with none             | Every message, as today                     |
| A seat                         | The record, with covered spans as briefings |

The record is one thing. The views differ, and each view is derived. A person
reading raw also sees other people's briefings, because a briefing is a
message on the record like any other, and reading it tells them what a
colleague was told.

---

## 3. The exchange

The unit is not a message and not a cursor window. It is the **exchange**:
everything the room does between a person speaking and the room going quiet
again.

Both edges already exist:

- **It opens** when a person's message lands in an idle room.
- **It closes** when no agent is active. `settled()` resolves.

**Quiescence is a true end, not a gap.** A seat that says something activates
its readers inside its own `say`, before its own turn finishes, so the active
count never dips to zero in the middle of a burst. A room that settles has
finished, and will not start again on its own.

Nothing between the edges needs counting. However many agents wake, however
many times they answer each other, however many turns it takes — the exchange
is done when the room is done.

---

## 4. One exchange, one message

The rule the whole design serves:

> **Every exchange resolves to exactly one message for its person.**

Most of the time the room has already done that. One product answers, once,
and that message is the answer. **A briefing agent does not engage.** The
person reads what the product said, in that product's own words, with its own
evidence.

A briefing agent engages when the room did not:

> **A briefing is written when an exchange closes and holds more than one
> message from other participants. One message needs no consolidation.**

It counts messages, not speakers. The measured run's worst moment was one
product saying four separate things to Priya, and that needs consolidating as
much as three products saying one each.

The threshold is not a saving to be measured later. It is most of the value:

| In the measured run                 |              |
| ----------------------------------- | ------------ |
| Exchanges                           | 11           |
| Exchanges that would write briefing | **3**        |
| Exchanges passed through untouched  | 8            |
| Agent messages consolidated         | **17 of 19** |

Eight exchanges cost nothing extra and keep the room's own voice. Three
exchanges account for almost all of the noise. **A design that briefed
everything would pay eleven times to fix three problems, and would flatten
eight answers that were already right.**

An exchange with no agent message at all writes nothing. The room had nothing
to say, and saying so is a host's business, not the record's.

---

## 5. Who owns an exchange

A room holds several people, and each may bring a briefing agent. Only one
writes per exchange, and this picks it:

> **A person's message into an idle room opens an exchange and owns it.
> Messages that land while the room is active steer the seats already working
> and change nothing — not the owner, and not which briefing agent writes at
> the close.**

The room holds one name while an exchange is open and drops it at the close.
That is run state, like the count of active seats. It does not survive a
restart, and neither does an exchange.

**Nothing is lost for the others. It is deferred.** Sam steers Priya's
exchange and gets no briefing now. His next message into an idle room opens
his own exchange, and his briefing covers from _his_ last briefing — which
includes the exchange he steered. He is briefed one turn later, by his own
agent, in his own terms.

**Arriving needs no separate mechanism.** An `arrived` is a message, so a
person arriving into an idle room opens an exchange they own. The briefing
covers everything since their last briefing, which is what they missed while
they were away. Catch-up falls out of the same rule and needs no cursor.

This is a default, and it is the simplest one that works. Two variants are
plausible and neither is chosen now: every person present at the close gets a
briefing from their own agent, or a person who speaks during an exchange joins
its ownership. Both cost more model calls per exchange. Neither is worth
paying for before the default has run.

---

## 6. A briefing is not something said

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
  /** The person it was written for. Always present. */
  to: string;
  text: string;
  /** The span of the record it stands in for. Always present. */
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

## 7. The thread of a person who has one

This is the assumption the design rests on, so it is stated as a rule:

> **A person who has a briefing agent reads their own messages, and the one
> message each of their exchanges resolved to. Nothing else. They may never
> see the chatter, and the design must not assume they will.**

Two things follow, and both constrain the briefing rather than the room.

**A briefing stands alone.** It cannot say "as discussed above", refer to who
raised what, or assume its reader saw a message it covers. Somebody reading
only their thread, from their first visit to their last, must have a coherent
account of the work.

**A follow-up is asked against that thread.** Priya's next question refers to
the words her last message used, because that is all she has. So the room must
answer from the same place. §9 arranges that: the seats read the briefing too.

For that person the chatter is therefore not hidden. **It is internal.** A
host may offer a way into a covered span, and that is a good thing to offer,
but nothing here depends on it.

---

## 8. One briefing, because it is the shared premise

A briefing has two readers: its person, and every seat activated afterwards.
The temptation is to write two documents — one shaped for the person, one
complete for the room.

**Do not.** The briefing is the one thing both the person and the room are
guaranteed to have read. It is their shared premise. Two accounts of one
exchange means the person's next question rests on one and the answer rests on
the other, and neither side can tell that they have diverged.

So what a briefing agent personalises is real but bounded:

> **A briefing agent chooses order, emphasis, and length. It does not choose
> what the room remembers.**

Priya's briefing agent may lead with the decision she holds and put the
tonnage last. It may not drop the tonnage, because dropping it is not a way of
writing — it is the room forgetting. §14 says what that costs.

---

## 9. What a seat reads afterwards

`renderRecord` renders the record for a seat. Where a briefing covers a span,
the span renders as the briefing:

```
[priya] Can I tell the client Thursday for the pour?          (2 hours ago)
── 10 messages stand summarised below ──
[priya-brief → priya] Thursday is out: the inspector needs 48h notice and is
  not booked. Earliest is Saturday 30 Aug. It needs four things: …
[sam] Rain all Thursday morning. I am not pouring into that.  (12 min ago)
```

**Compaction is a rendering rule, not a deletion.** The record keeps every
message for ever, `messages()` returns all of them, and seqs do not move — so
the say lock and the catch-up anchor are untouched. What changes is what a
seat is handed at its next activation. That is why this belongs in
`render.ts`, beside the room's other prose.

An exchange that wrote no briefing is not compacted. There is nothing to
compact: one message is already its own summary.

Two briefings may cover the same span. **Render the span once, and put every
briefing that covers it in its place, in seq order.** Two short accounts from
two angles still cost less than the chatter, and choosing between them would
need a rule nobody can justify.

---

## 10. A briefing wakes nobody

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

## 11. What a briefing agent is

A briefing agent is the reader a person brings, and the writer of one message
for the exchanges that need one.

**It does not participate.** It holds no seat, takes no turn, appears on no
roster, and is never activated. It cannot start work, join work or stop work.
It writes one kind of message, only when an exchange closes, and only when
that exchange gave more than one answer.

**It does not act for its person.** `deliver` stays the person's own act, in
their own words. A briefing is stamped `from` the briefing agent and never
from the person: rule 7 holds, and this is the most tempting place to break
it.

The name says the whole job. It briefs one person, and that is all it does.

---

## 12. The shape

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
      Write what the room established, once, for somebody who has read nothing
      else. Lead with the decision Priya has to make and who holds it. Keep
      every fact a colleague would need to work from — quantities, dates,
      owners, and what is still unknown. Leave out who said what, and in which
      order.
    `,
  }),
});
```

**A host never asks for a briefing.** Briefing is how the session works, not
something the caller drives. A person's message opens an exchange, the room
works, the room settles, and — if the room said more than one thing — the
briefing is written and committed. It reaches the host on the `message` event
that carries every message on the record:

```ts
session.subscribe((event) => {
  if (event.type !== 'message') return;
  if (event.message.kind === 'briefing') render(event.message);
});
```

`Visit` is unchanged. There is no cursor to pass, because the exchange names
its own span: it opens at the owner's message, it closes at quiescence, and
the briefing covers from that person's previous briefing to the close.

`defineHuman` gains one optional field and the record gains one kind. **That
is the whole surface.**

---

## 13. What this does not add

Stated so a later change has to argue with it:

- **No working group.** Nothing convenes and nothing has members. The exchange
  is bounded by quiescence, so who took part needs no recording.
- **No new activation trigger.** Nothing wakes because the room went quiet. A
  briefing agent is called, never activated.
- **No briefing that is not needed.** One answer is left as it was given. §4.
- **No deletion.** Compaction renders. The record forgets nothing.
- **No second account.** One briefing, because it is the shared premise. §8.
- **No instruction to the products.** A `say` directed at a person still means
  "this part is for them".
- **No obligation.** A person may have none, and then nothing changes. §2.
- **No speaking for a person.** Ever.

---

## 14. Open questions

**Compaction is lossy, and the loss is invisible to whoever it hurts.** This
decides whether the design is good. Materials established _"stock 11.7t
against 11.7t required — full cover."_ If the briefing says "rebar is
covered", a later question about tonnage cannot be answered, and the seat that
needs the number does not know it is missing. §8 makes this the briefing
agent's strictest duty, which is a prompt, not a guarantee. Three real answers
exist and none is chosen here: give a seat a tool that reads a covered span;
keep a covered span uncompacted for one further exchange; or accept the loss
and measure it. **Do not build past this question.** The threshold in §4
narrows it — only three exchanges in the measured run are exposed — but it
does not remove it.

**A person waits with nothing.** Priya asks, and reads nothing until the room
settles — twelve activations in the measured run. She cannot be shown progress
without being shown chatter, which §7 forbids. An interim line is a second
briefing, which §8 forbids. This is unresolved.

**An exchange with no end never briefs.** Two agents that keep answering each
other never settle. The room has no turn limit today and this design does not
add one, but it is the first thing that would notice the absence.

**A run that stops mid-exchange writes no briefing.** `stopSession` aborts the
turns in flight, so the exchange never closes. The work that landed is on the
record, and the owner's next briefing covers it, because a briefing covers
from their previous one. Deferred, not lost.

**A room without people never compacts.** Agents working unattended produce a
record that nothing checkpoints, and the growth in §1 continues. So does a
room where nobody brings a briefing agent. A room-level compactor is the
obvious answer and is not designed here.

**Briefings of briefings.** A later briefing covers a span that already holds
briefings. That is how a long-lived room stays bounded, and it makes the
record a tree rather than a line. One level is enough to test the idea.

---

## 15. What would prove it

Run the same scenario twice: once as it stands, and once with a briefing agent
for Priya.

It works if her briefing answers what she asked and reads as a whole to
somebody who has seen nothing else; if the eight exchanges that resolved in
one message are untouched and still in the room's own voice; if the record
still holds all thirty messages; if the run without a briefing agent is
unchanged; and if **a seat activated after the briefing can still do its job
from it.** The way to test that last one is to ask a follow-up whose answer is
buried in the compacted span.

It fails if the briefing reads like minutes rather than an answer, if a seat
answers worse after compaction than before, or if a person has to reach for
the chatter to trust what they were told — because the design says they will
never see it.

Three numbers: how many messages reach the person, how large a seat's context
is at the tenth activation with and without briefings, and whether the answers
hold up. The run in [`demos/`](../demos) is the baseline — 148,038 characters
of context over 25 activations, 77% of it record, and three exchanges out of
eleven carrying almost all the noise.
