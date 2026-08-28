# The avatar

This document is the design for the avatar: the agent that turns one exchange
between many agents into one briefing — the only thing its person reads, and
what the room remembers of that exchange afterwards. **Nothing here is built.**
Read [`agent.md`](agent.md) and [`presence.md`](presence.md) first.

One sentence:

> **A person asks. The room works — several agents, as many turns as it
> takes — until it goes idle. The avatar writes one briefing, and from then on
> that briefing is the exchange: it is all the person ever reads, and it is
> what the seats read in place of the chatter that produced it.**

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
characters of context, and **the record was 77% of it**. The first context was
1,259 characters. The last was 10,081. Thirty messages did that.

A room that waits for months is the point of an ambient runtime. This one
could not afford a week. Both problems have one answer: **something has to
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

## 3. A briefing is not something said

The record gains one kind. It is not a `said`, because nobody said it. A
person did not hear it in a room; an avatar wrote it for them.

```ts
/** What one person was told. An avatar writes it. Nobody speaks it. */
export interface BriefingMessage {
  kind: 'briefing';
  seq: Seq;
  at: string;
  /** The avatar that wrote it. */
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

## 4. The person's thread

This is the assumption the whole design rests on, so it is stated as a rule
rather than left to a host:

> **A person reads their own messages and the briefings addressed to them.
> Nothing else. They may never see the chatter, and the design must not assume
> they will.**

Two things follow, and both are constraints on the briefing rather than on the
room.

**A briefing stands alone.** It cannot say "as discussed above", refer to who
raised what, or assume its reader saw a message it covers. Somebody reading
only briefings, from their first visit to their last, must have a coherent
account of the work.

**A follow-up is asked against briefings.** Priya's next question refers to
the words her last briefing used, because that is all she has. So the room
must be able to answer it from the same place. That is what §6 arranges: the
seats read the briefing too.

The chatter is therefore not hidden. **It is internal.** A host may offer a
way into a covered span, and that is a good thing to offer, but nothing in
this design depends on it.

---

## 5. One briefing, because it is the shared premise

A briefing has two readers: its person, and every seat activated afterwards.
The temptation is to write two documents — one shaped for the person, one
complete for the room.

**Do not.** The briefing is the one thing both the person and the room are
guaranteed to have read. It is their shared premise. Two accounts of one
exchange means the person's next question rests on one and the answer rests on
the other, and neither side can tell that they have diverged.

So the personalising an avatar does is real but bounded:

> **An avatar chooses order, emphasis, and length. It does not choose what the
> room remembers.**

Priya's avatar may lead with the decision she holds and put the tonnage last.
It may not drop the tonnage, because dropping it is not a way of writing —
it is the room forgetting. §11 says what that costs.

---

## 6. What a seat reads afterwards

`renderRecord` renders the record for a seat. Where a briefing covers a span,
the span renders as the briefing:

```
[priya] Can I tell the client Thursday for the pour?          (2 hours ago)
── 11 messages stand summarised below ──
[priya-avatar → priya] Thursday is out: the inspector needs 48h notice and is
  not booked. Earliest is Saturday 30 Aug. It needs four things: …
[sam] Rain all Thursday morning. I am not pouring into that.  (12 min ago)
```

**Compaction is a rendering rule, not a deletion.** The record keeps every
message for ever, `messages()` returns all of them, and seqs do not move — so
the say lock and the catch-up anchor are untouched. What changes is what a
seat is handed at its next activation. That is why this belongs in
`render.ts`, beside the room's other prose.

Two briefings may cover the same span, when two people ask inside one
exchange. **Render the span once and put every briefing that covers it in its
place, in seq order.** Two short accounts from two angles still cost less than
the chatter, and choosing between them would need a rule nobody can justify.

---

## 7. A briefing wakes nobody

A briefing that woke the room would start a new exchange about the exchange it
just closed.

The routing rule says so directly:

```ts
function wakes(seat, target, message) {
  if (isBriefing(message)) return false;
  ...
}
```

One line, and it says what it means. An earlier draft of this design leaned on
an accident instead — a `said` directed at a person resolves to no agent, so
it happens to wake nothing. A named kind lets the rule be stated rather than
discovered.

Every seat still **reads** every briefing. Waking and reading were always
different questions.

---

## 8. What an avatar is

An avatar is the reader a person brings, and the writer of one briefing per
exchange.

**An avatar does not participate.** It holds no seat, takes no turn, appears
on no roster, and is never activated. It cannot start work, join work or stop
work. It writes one kind of message, and only when an exchange closes.

**An avatar does not act for its person.** `deliver` stays the person's own
act, in their own words. A briefing is stamped `from` the avatar and never
from the person: rule 7 holds, and this is the most tempting place to break
it.

The name deserves a caution. An avatar in a game acts as you. This one runs
the other way: it is the room's work, turned to face you.

---

## 9. The shape

```ts
const priya = defineHuman({
  name: 'priya',
  identity: 'Project manager, site office. Owns the programme.',
  avatar: defineAgent({
    name: 'priya-avatar',
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

```ts
await visit.deliver({ text: 'Can I tell the client Thursday for the pour?' });

const briefing = await visit.brief();
// briefing.text   — one message, not eleven
// briefing.covers — the span it now stands in for
```

`brief()` waits for the room to go idle, writes the briefing, commits it, and
returns it. **Quiescence is the method's contract, not the caller's
homework.** It resolves at once when nothing is active.

```ts
brief(options?: { since?: Seq }): Promise<BriefingMessage>;
```

`since` defaults to `visit.since`, the catch-up anchor
[`presence.md`](presence.md) §8 already derives from the record. **The design
keeps no cursor of its own.** That makes two cases one case: a person who just
asked gets their answer, and a person who came back after two days gets what
they missed — and the room gets a checkpoint over either.

`defineHuman` gains one optional field, `Visit` gains one method, and the
record gains one kind. That is the whole surface.

---

## 10. What this does not add

Stated so a later change has to argue with it:

- **No working group.** Nothing convenes and nothing has members. The exchange
  is bounded by quiescence, so who took part needs no recording.
- **No new activation trigger.** Nothing wakes because the room went quiet. An
  avatar is called, never activated.
- **No deletion.** Compaction renders. The record forgets nothing.
- **No second account.** One briefing, because it is the shared premise. §5.
- **No instruction to the products.** A `say` directed at a person still means
  "this part is for them". It now reaches them through their avatar, which is
  what a directed say was always for: marking what matters to whom.
- **No speaking for a person.** Ever.

---

## 11. Open questions

**Compaction is lossy, and the loss is invisible to whoever it hurts.** This
decides whether the design is good. Materials established _"stock 11.7t
against 11.7t required — full cover."_ If the briefing says "rebar is
covered", a later question about tonnage cannot be answered, and the seat that
needs the number does not know it is missing. §5 makes this the avatar's
strictest duty, which is a prompt, not a guarantee. Three real answers exist
and none is chosen here: give a seat a tool that reads a covered span; keep a
briefing's covered span uncompacted for one further exchange; or accept the
loss and measure it. **Do not build past this question.**

**A person waits with nothing.** Priya asks, and reads nothing until the room
settles — twelve activations in the measured run. She cannot be shown progress
without being shown chatter, which §4 forbids. An interim line from the avatar
is possible and is a second briefing, which §5 forbids. This is unresolved.

**A room without people never compacts.** Agents working unattended produce a
record that nothing checkpoints, and the growth in §1 continues. A room-level
compactor is the obvious answer and is not designed here.

**Briefings of briefings.** A later briefing covers a span that already holds
briefings. That is how a long-lived room stays bounded, and it makes the
record a tree rather than a line. One level is enough to test the idea.

**A person who leaves mid-exchange.** Priya asked and walked out. The room
settled after she left. Her briefing is written and waits, and nothing tells
her it exists.

---

## 12. What would prove it

Run the same scenario, unchanged, and give Priya an avatar.

It works if her briefing answers what she asked and reads as a whole to
somebody who has seen nothing else; if the record still holds all thirty
messages; and if **a seat activated after the briefing can still do its job
from it.** The way to test the last one is to ask a follow-up whose answer is
buried in the compacted span.

It fails if the briefing reads like minutes rather than an answer, if a seat
answers worse after compaction than before, or if a person has to reach for
the chatter to trust what they were told — because the design says they will
never see it.

Three numbers: how many messages reach the person, how large a seat's context
is at the tenth activation with and without briefings, and whether the answers
hold up. The run in [`demos/`](../demos) is the baseline — 148,038 characters
of context over 25 activations, 77% of it record.
