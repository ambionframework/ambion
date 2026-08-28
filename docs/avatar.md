# The avatar

This document is the design for the avatar: the agent that turns one exchange
between many agents into one message, for the person who asked and for the
room that has to remember it. **Nothing here is built.** Read
[`agent.md`](agent.md) and [`presence.md`](presence.md) first.

One sentence:

> **A person asks. The room works — several agents, as many turns as it
> takes — until it goes idle. The avatar writes what the room established as
> one message on the record, and from then on that message stands in for the
> exchange: for the person who reads it, and for the seats that come after.**

---

## 1. Two problems, both measured

The run in [`demos/`](../demos) is the evidence for both.

**A person reads a transcript instead of an answer.** Priya asked one
question: _can I tell the client Thursday for the pour?_ Her question woke
three products. They answered her, answered each other, corrected each other
and refined their own answers. Eleven agent messages landed across twelve
activations. Four addressed her. The room established that Thursday was
impossible, why, and what would make Saturday possible. It never assembled
that into an answer, because no participant has assembling as its job.

**The room re-reads everything, for ever.** Each activation renders the whole
record into a seat's context. Over 25 activations that run built 148,038
characters of context, and **the record was 77% of it**. The first context
was 1,259 characters. The last was 10,081. Thirty messages did that.

A room that waits for months is the point of an ambient runtime. This one
cannot afford a week. The two problems have one answer: **something has to
stand in for an exchange once it is over.**

---

## 2. The exchange

The unit is not a message and not a cursor window. It is the **exchange**:
everything the room does between a person speaking and the room going quiet
again.

Both edges already exist:

- **It opens** with a message. Usually the person's own.
- **It closes** when no agent is active. `settled()` resolves.

Nothing between them needs counting. However many agents wake, however many
times they answer each other, however many turns it takes — the exchange is
done when the room is done.

**Quiescence is a true end, not a gap.** A seat that says something activates
its readers inside its own `say`, before its own turn finishes, so the active
count never dips to zero in the middle of a burst. A room that settles has
finished, and will not start again on its own.

---

## 3. The brief is a message

When an exchange closes, the avatar writes one message and commits it to the
record. That message is a **checkpoint**.

```ts
export interface SpokenMessage {
  kind: 'said';
  seq: Seq;
  at: string;
  from: string;
  to?: string;
  text: string;
  /** An avatar sets this: the span of the record this message stands in for. */
  covers?: { from: Seq; through: Seq };
}
```

**One optional field, and no new kind.** A brief is something a participant
wrote, so it is a `said`. Code that ignores `covers` renders it as an ordinary
message and stays correct. The message kinds stay at two.

The checkpoint has two readers and one duty to each:

- **Its person** reads it instead of the exchange. It answers what they asked,
  in the form they read.
- **The room** reads it instead of the exchange, from the next activation on.
  It must hold everything a colleague would need to work from.

Those two duties are not the same, and §9 says so plainly. One message serves
both because two would have to be kept in step, and a record with two accounts
of one exchange has no account of it.

---

## 4. What a seat reads afterwards

`renderRecord` renders the record for a seat. With a checkpoint on it, the
span the checkpoint covers renders as the checkpoint:

```
[priya] Can I tell the client Thursday for the pour?          (2 hours ago)
── 11 messages, summarised below by priya-avatar ──
[priya-avatar → priya] Thursday is out: the inspector needs 48h notice and
  is not booked. Earliest is Saturday 30 Aug, and it needs four things: …
[sam] Rain all Thursday morning. I am not pouring into that.  (12 min ago)
```

**Compaction is a rendering rule, not a deletion.** The record keeps every
message for ever. `messages()` returns all of them. Seqs do not move, so the
say lock and the catch-up anchor are untouched. What changes is what a seat is
handed at its next activation.

That is why this belongs in `render.ts` beside the room's other prose. The
session owns the record and owns what its readers see, and a compacted view is
still a view.

---

## 5. Why a checkpoint wakes nobody

A checkpoint that woke the room would start a new exchange about the exchange
it just closed.

It does not, and no rule is bent to stop it. **A brief is directed at its
person.** The room routes a directed message to exactly its target and looks
that target up among the agents; a person is not an agent, so a say directed
at a person wakes nobody. Rule 4 already works this way.

Every seat still sees it. `to` governs who wakes, never who reads. So the
checkpoint reaches the room's memory without costing the room a turn.

---

## 6. What an avatar is

An avatar is the reader a person brings, and the writer of one message per
exchange.

**An avatar does not participate.** It holds no seat, takes no turn, appears
on no roster, and is never activated. It cannot start work, join work, or stop
work. It writes exactly one kind of message and only when an exchange closes.

**An avatar does not act for its person.** `deliver` stays the person's own
act, in their own words. A brief is stamped `from` the avatar, never from the
person: rule 7 holds, and this is the most tempting place to break it.

The name deserves a caution. An avatar in a game acts as you. This one runs
the other way: it is the room's work, turned to face you.

---

## 7. The shape

```ts
const priya = defineHuman({
  name: 'priya',
  identity: 'Project manager, site office. Owns the programme.',
  avatar: defineAgent({
    name: 'priya-avatar',
    identity: 'Writes the record for Priya.',
    model: 'anthropic/claude-sonnet-5',
    instructions: `
      Write what the room established, once. Lead with the decision Priya has
      to make and who holds it. Keep every fact a colleague would need to work
      from — quantities, dates, owners, and what is still unknown. Leave out
      who said what and in which order.
    `,
  }),
});
```

```ts
await visit.deliver({ text: 'Can I tell the client Thursday for the pour?' });

const checkpoint = await visit.brief();
// checkpoint.text   — one message, not eleven
// checkpoint.covers — the span it now stands in for
```

`brief()` waits for the room to go idle, renders the exchange, commits the
message, and returns it. **Quiescence is the method's contract, not the
caller's homework.** It resolves at once when nothing is active.

```ts
brief(options?: { since?: Seq }): Promise<SpokenMessage>;
```

`since` defaults to `visit.since`, the catch-up anchor
[`presence.md`](presence.md) §8 already derives from the record. **The design
keeps no cursor of its own.** That makes two cases one case: a person who just
asked gets their answer; a person who just came back after two days gets what
they missed, and the room gets a checkpoint over both.

`defineHuman` gains one optional field, `Visit` gains one method, and
`SpokenMessage` gains one optional field. That is the whole surface.

---

## 8. What the person reads

The `covers` span determines the view, so the toggle is mechanical:

- Show the checkpoint.
- Collapse the messages in `(covers.from, covers.through]` behind one control.
- **Leave that control there.** A person who wants the room's working must
  always be able to reach it, or the brief is something to trust rather than
  something to check.

---

## 9. What this does not add

Stated so a later change has to argue with it:

- **No working group.** Nothing convenes and nothing has members. The exchange
  is bounded by quiescence, so who took part needs no recording.
- **No new activation trigger.** Nothing wakes because the room went quiet. An
  avatar is called, never activated.
- **No new message kind.** A brief is a `said` with a span.
- **No deletion.** Compaction renders; the record forgets nothing.
- **No second account.** One checkpoint serves the person and the room.
- **No speaking for a person.** Ever.

---

## 10. Open questions

**Compaction is lossy, and the loss is invisible to whoever it hurts.** This
is the risk that decides whether the design is good. Materials established
_"stock 11.7t against 11.7t required — full cover."_ If the checkpoint says
"rebar is covered", a later question about tonnage cannot be answered, and the
seat that needs it does not know it is missing. Three answers are possible and
none is chosen here: write the checkpoint for the room first and let the
person's view trim it; give a seat a tool that reads a covered span; or accept
the loss and measure it. **Do not build past this question.**

**Whose idiom compacts the room?** Priya's avatar drops cost detail because
Priya does not want it. If her checkpoint stands in for the exchange, Dan's
cost detail is gone from what every seat can see. The instructions in §7 push
back on this — keep every fact a colleague would need — but a preference and
a duty are fighting inside one prompt.

**A room without people never compacts.** Agents working unattended produce a
record that nothing checkpoints. The growth in §1 continues. A room-level
compactor is the obvious answer and is not designed here.

**Checkpoints of checkpoints.** A later brief covers a span that already holds
briefs. That is how a long-lived room stays bounded, and it makes the record a
tree of checkpoints rather than a line. One level is enough to test the idea.
Do not build the tree before the first level has run.

**A person who leaves mid-exchange.** Priya asked and walked out. The room
settled after she left. Her checkpoint is written and waits, and nothing tells
her it exists.

---

## 11. What would prove it

Run the same scenario, unchanged, and give Priya an avatar.

It works if her checkpoint answers the question she asked; if it is one message
where the exchange holds eleven; if the record still holds all thirty messages;
and if **a seat activated after the checkpoint can still do its job from it.**
The last one is the test that matters, and the way to run it is to ask a
follow-up question whose answer is buried in the compacted span.

It fails if the checkpoint reads like minutes rather than an answer, if a seat
gives a worse answer after compaction than before, or if a person needs the raw
record to trust what they were told.

Three numbers: how many messages reach the person, how large a seat's context
is at the tenth activation with and without checkpoints, and whether the
answers hold up. The run in [`demos/`](../demos) is the baseline — 148,038
characters of context over 25 activations, 77% of it record.
