# The briefing agent

This document is the design for the briefing agent: the optional agent a
person brings, which consolidates the answer when a question wakes several
agents and they talk it out. **Nothing here is built.** Read
[`agent.md`](agent.md) and [`presence.md`](presence.md) first.

One sentence:

> **A person asks a question. Several agents wake and work it out between
> them. When the room goes quiet, that person's briefing agent writes one more
> message — the answer the exchange arrived at — and a client shows them that
> instead of the working.**

This design covers one thing: **a question, the agents that answer it, and one
message that stands for the answer.** It is not about presence, catch-up, or
what a person sees when they arrive. It does not compact anything. It adds one
message to the record and takes nothing away.

---

## 1. The problem, measured

The run in [`demos/`](../demos) is the evidence.

Priya asked one question: _can I tell the client Thursday for the pour?_ It
woke three products. They answered her, answered each other, corrected each
other and refined their own answers. Ten agent messages landed before she
left. Four addressed her.

The room established that Thursday was impossible, why, and what would make
Saturday possible. **It never assembled that into an answer**, because no
participant has assembling as its job, and because the room's largest unit is
one message.

So Priya read the room thinking out loud. She wanted the conclusion.

---

## 2. The exchange

The unit is the **exchange**: a question, and everything the room does until
it goes quiet again.

- **It opens** when a person's `said` lands in an idle room.
- **It closes** when no agent is active. `settled()` resolves.

**Only a question opens one.** Arriving and leaving are messages, and they may
wake a seat, but they open no exchange and are never briefed. A room where
nobody asks anything is never briefed at all.

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

## 3. One exchange, one message

The rule the design serves:

> **Every exchange resolves to exactly one message for the person who asked.**

Most of the time the room may already have done that. One product answers,
once, and that message is the answer. **A briefing agent does not engage.** The
person reads what the product said, in that product's own words.

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
| Agent messages inside an exchange     | **17 of 19** |
| Agent messages outside any exchange   | 2            |

**Every question in this run drew more than one answer, so the threshold never
fired.** It is a rule about a case this run does not contain, and it is kept
because the case is real: a single clean answer should reach a person in the
voice that gave it.

An exchange with no agent message writes nothing. The room had nothing to say.

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
ownership. Both cost more model calls per exchange.

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
  /** The exchange it answers: the question, and the work it caused. */
  covers: { from: Seq; through: Seq };
}

export type Message = SpokenMessage | PresenceMessage | BriefingMessage;
```

Three kinds, and each earns its name. `said` is what a participant told the
room. `arrived` and `left` are what a person did. `briefing` is what a person
was told. A briefing carries two fields no other message has — a reader and a
span — because it is the only message written _for_ somebody rather than _to_
the room.

`covers` is not an instruction to the runtime. It is what a client needs in
order to know which messages this one answers.

---

## 6. The record only grows

**Nothing here replaces, rewrites, hides or removes a message.** A briefing is
appended like every other message: it takes the next seq, it lands after
everything it covers, and the messages it covers stay exactly where they are.

That is the point at which an earlier draft of this design went wrong. It made
a briefing a checkpoint that stood in for its span in what a seat reads,
which bought the room a smaller context and cost the record its one property
worth defending. **The record is append-only, its seqs are monotonic, and the
past does not change under a reader.**

So the seats read what they always read: the whole record, chatter included,
plus one briefing per exchange. A briefing is a message a colleague may find
useful. It is not the room's memory and it does not replace the room's memory.

Making a long record affordable is a real problem, and it is not this one.
[`agent.md`](agent.md) §8 already lists per-seat compaction of long records as
its own document. It should stay that way, because compacting what a seat
reads and answering what a person asked are two jobs, and one message cannot
be shaped for both without being worse at each.

---

## 7. Presentation belongs to the client

A person should not read the working. That is a statement about presentation,
and it is settled where presentation is settled: **in the client, not in the
record and not on the wire.**

The runtime commits messages in order and streams them. What a client does
with them:

- **While the room works**, render the chatter as a thinking state. Somebody
  waiting sees that three products are working and can watch them do it, the
  way any agent's own reasoning is shown. They are not being handed answers to
  read.
- **When the briefing lands**, fold the span it covers back into that thinking
  state, and show the briefing as the answer. `covers` says exactly which
  messages to fold.

This asks one thing of a client that a plain log does not do: **it must be
able to change how it presents past messages when a new message arrives.** A
client that only appends cannot do this and will show the working as
conversation.

It also settles the question of what a person sees while they wait. They see
the room thinking, which is honest, and they see the answer when there is one.
No interim briefing is written, so there is never a second account of one
exchange.

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
exchange it opens runs and closes as it does today, and every reader sees it
whole. A room where nobody brings one behaves in every respect as the room
behaves now.

That is the guarantee this design offers, and the reason it is safe to try:
**it adds one message, and it takes nothing away.**

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
      Answer Priya's question, once, for somebody who has not read the working.
      Lead with the decision she has to make and who holds it. Keep the facts
      she needs to act — quantities, dates, owners, and what is still unknown.
      Leave out who said what, and in which order.
    `,
  }),
});
```

**A host never asks for a briefing.** Briefing is how the session works, not
something the caller drives. A question opens an exchange, the room works, the
room settles, and — if the room said more than one thing — the briefing is
written and committed. It arrives on the `message` event that carries every
message on the record:

```ts
session.subscribe((event) => {
  if (event.type !== 'message') return;
  if (event.message.kind === 'briefing') showAnswer(event.message);
  else showThinking(event.message);
});
```

`Visit` is unchanged, and there is no cursor to pass: the exchange names its
own span. `defineHuman` gains one optional field and the record gains one
kind. **That is the whole surface.**

---

## 12. What this is not

Stated so a later change has to argue with it:

- **Not compaction.** Nothing is replaced in what a seat reads. Making a long
  record affordable is [`agent.md`](agent.md) §8's business. §6.
- **Not catch-up.** A person returning after two days is
  [`presence.md`](presence.md) §8's business, and its anchor is untouched.
  Arriving opens no exchange.
- **Not a working group.** Nothing convenes and nothing has members.
- **Not a new activation trigger.** Nothing wakes because the room went quiet.
  A briefing agent is called, never activated.
- **Not a summariser of everything.** One answer is left as it was given, and
  anything outside an exchange is untouched.
- **Not a wire or storage format.** Folding the working is what a client does
  with `covers`. §7.
- **Not an obligation.** A person may have none, and then nothing changes.
- **Not speaking for a person.** Ever.

---

## 13. Open questions

**The person and the room read different things.** Priya's follow-up is asked
against her briefing. The seats answering it read the whole record — the
chatter, and the briefing. They have more than she does, not less, so the
usual failure of a summary does not apply here. What is untested is the other
direction: whether a question phrased in a briefing's words lands cleanly on
seats that remember the argument behind it.

**A briefing is one more message in every seat's context.** Small, and in the
wrong direction. The design pays it to keep the record honest, and §6 says why.

**A run that stops mid-exchange writes no briefing.** `stopSession` aborts the
turns in flight, so the exchange never closes. The person asked and heard
nothing, and the record shows exactly that: a question, some work, a shutdown.
Accepted. A briefing here would summarise an argument that never finished.

**What a client owes.** §7 asks a client to re-present past messages when a new
one arrives. That is more than a log does, and no client here has done it yet.
The example is where to find out whether it is as small as it sounds.

---

## 14. What would prove it

Run the same scenario twice: once as it stands, and once with a briefing agent
for Priya.

It works if her briefing answers what she asked and reads whole to somebody who
has not read the working; if the two messages outside her exchange are
untouched and still in the product's own voice; if the record holds all thirty
messages plus the briefings, in order, with nothing rewritten; and if the run
without a briefing agent is unchanged.

It fails if the briefing reads like minutes rather than an answer, if a
follow-up asked in the briefing's words confuses the seats, or if the record
has to change shape to make the presentation work.

Two numbers, and one judgement: how many messages a person must read per
question, what a briefing costs against the exchange that produced it, and
whether the answer is one somebody could act on. The run in
[`demos/`](../demos) is the baseline — three questions, 17 of 19 agent
messages inside them.
