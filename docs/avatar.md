# The avatar

This document is the design for the avatar: the agent that turns one exchange
between many agents into one message a person reads. **Nothing here is
built.** Read [`agent.md`](agent.md) and [`presence.md`](presence.md) first.
This design adds one field to `defineHuman`, one method to a visit, and no
rule.

One sentence:

> **A person asks. The room works — several agents, as many turns as it
> takes — until it goes idle. The avatar turns that whole exchange into one
> message for its person, and the room keeps every word of it.**

---

## 1. The problem, measured

The run in [`demos/`](../demos) is the evidence.

Priya asked one question: _can I tell the client Thursday for the pour?_ Her
question woke three products. They answered her, answered each other,
corrected each other and refined their own answers. Eleven agent messages
landed before she left, across twelve activations. Four addressed her.

Nothing there is wrong. Every seat obeyed every rule, and the work was good —
the room established that Thursday was impossible, why, and what would make
Saturday possible. **It never assembled that into an answer**, because no
participant has assembling as its job, and because the room's largest unit is
one message.

So Priya read the room thinking out loud. She wanted the conclusion.

---

## 2. The exchange

The unit this design needs is not a message and not a cursor window. It is
the **exchange**: everything the room does between a person speaking and the
room going quiet again.

An exchange has two edges, and the runtime already knows both:

- **It opens** with a message. Usually the person's own.
- **It closes** when no agent is active. `settled()` resolves and the
  `settled` event fires.

Nothing between those edges needs counting. However many agents wake, however
many times they answer each other, however many turns it takes — the exchange
is done when the room is done. That is exactly the multi-turn burst a person
should not have to read.

**Quiescence here is a true end, not a gap.** A seat that says something
activates its readers inside its own `say`, before its turn finishes, so the
active count never dips to zero in the middle of a burst. A room that settles
has finished, and will not start again on its own.

---

## 3. What an avatar is

An avatar is the reader a person brings with them. It takes an exchange and
returns one message: structured, short, in the form that person wants.

**An avatar does not participate.** It holds no seat, takes no turn, appears
on no roster, and never calls `say`. The products do not know it exists.

**An avatar does not act for its person.** `deliver` stays the person's own
act, in their own words. It faces the person, not the room.

The name deserves one caution. An avatar in a game acts as you. This one runs
the other way: it is the room's work, turned to face you. It reads for you and
never speaks for you.

---

## 4. Why "it never writes" is the whole design

One constraint carries this, and it is worth seeing what it removes. Because
an avatar never commits a message:

- **Rule 1 is untouched.** An avatar is not a seat, so nothing new activates.
- **Rule 5 does not apply.** The say lock guards the record. An avatar never
  reaches the record, so it cannot race and cannot be refused.
- **Rule 7 cannot break.** Nothing lands under anybody's name.
- **The exchange cannot recurse.** An avatar's output is not a message, so it
  wakes nothing and cannot reopen the exchange it just summarised.
- **The products change nothing.** No instruction, no roster line, no rule
  about who may address whom.
- **A failure is cheap.** If the avatar call fails, the host shows the record
  as it does today. Nobody is left unanswered.

Every one of those was a problem in a design where the reader spoke. They
disappear together, because they came from one assumption.

---

## 5. The shape

A person may bring an avatar:

```ts
const priya = defineHuman({
  name: 'priya',
  identity: 'Project manager, site office. Owns the programme.',
  avatar: defineAgent({
    name: 'priya-avatar',
    identity: 'Reads the room for Priya.',
    model: 'anthropic/claude-sonnet-5',
    instructions: `
      Give Priya one answer to what she asked. Lead with the decision and who
      holds it. Name the blocker, not the discussion. Leave out cost unless it
      moves a date. Five lines at most.
    `,
  }),
});
```

A visit asks for the exchange:

```ts
await visit.deliver({ text: 'Can I tell the client Thursday for the pour?' });

const brief = await visit.brief();
// brief.text     — one message, not eleven
// brief.from     — the seq the exchange opened after
// brief.through  — the seq it closed on
// brief.covered  — how many messages it replaces
```

**`brief()` waits for the room to go idle before it renders.** The host does
not have to remember to; quiescence is the method's contract, not the
caller's homework. It resolves at once when nothing is active.

```ts
brief(options?: { since?: Seq }): Promise<Brief>;

interface Brief {
  text: string;
  from: Seq;
  through: Seq;
  covered: number;
}
```

`since` defaults to `visit.since`, the catch-up anchor
[`presence.md`](presence.md) §8 already derives from the record. A host that
briefs repeatedly passes back the `through` it last received. **The design
keeps no read cursor of its own** — a second store is what the presence
design spent its whole effort avoiding.

This makes the two cases one case. A person who just asked gets the answer to
their question. A person who just arrived after two days gets what they
missed. Both are "the exchange since I was last up to date".

---

## 6. What the host renders

The `Brief` determines the view, so the toggle is mechanical:

- Show `brief.text`.
- Collapse the messages in `(from, through]` behind one control, labelled with
  `brief.covered`.
- Leave that control there. **A person who wants to see the room's working
  must always be able to**, or the brief is something to be trusted rather
  than checked.

The record keeps every message and the agents keep reading all of it. A
product that could not see its colleagues' work would answer worse. Hiding is
what one reader sees, never what the room holds.

---

## 7. Where it sits

The session already renders the record for a seat. `renderContext` builds the
clock, the roster and the record, and hands a seat what it needs for a turn.
`render.ts` holds that prose, pure and stateless.

An avatar is the same operation with a different reader. A seat reads
structure, so a function is enough. A person wants an answer, so it takes a
model.

That symmetry is the test of whether this belongs in the runtime at all. **The
session owns the record and owns what its readers see.** A seat's view and a
person's view are one concern, not a third one.

The avatar's call is a Pi agent with no tools and one prompt. Its turn lands
in a downstream session, `<room>:<person>`, beside the seats' own, so a
person's briefs stay auditable the way rule 8 keeps a seat's turns auditable.

---

## 8. What this does not add

Stated so a later change has to argue with it:

- **No working group.** Nothing convenes and nothing has members. The
  exchange is bounded by quiescence, so who took part needs no recording.
- **No new activation trigger.** The room never wakes anything because it went
  quiet. `settled()` already exists and an avatar is not woken; it is called.
- **No visibility field on a message.** Hiding is what a reader sees. §6.
- **No claim on a question.** Seats speak as they do today.
- **No rule about addressing a person.** A product says what it knows to
  whoever it likes, and the avatar sorts it out afterwards.
- **No speaking for a person.** Ever.

---

## 9. Open questions

**An exchange with no end.** Two agents that keep answering each other never
settle, and `brief()` never resolves. The room has no turn limit today and
this design does not add one, but it is the first thing that would notice the
absence.

**A person who leaves mid-exchange.** Priya asked and walked out. The room
settled after she left. Whose brief is that, and does it wait for her return?
The anchor makes it work — her next visit briefs from her `left` — but the
answer she asked for sat unread, and nothing told her it existed.

**Two people, one settle.** Priya and Sam both ask, and one quiescence closes
both exchanges. Each avatar takes the slice after its own person's message, so
the slices overlap. That is correct and it costs two model calls over mostly
the same messages.

**The brief loses the direct voice.** _"Nothing on the materials side is
holding you up"_ reads better from the materials tracker than from a
summariser. The record still holds it and §6 keeps it reachable. Whether
people want the summary or the sources is worth watching.

**An avatar has a life outside one room.** It holds how a person reads, which
should not be re-declared per session. That is a workspace question. Do not
answer it here by accident.

---

## 10. What would prove it

Run the same scenario, unchanged, and give Priya an avatar.

It works if her brief answers the question she asked, if it is one message
where the exchange holds eleven, and if the record and the products are byte
for byte what they are today. That last part is the real test: **an avatar
that changes the room has failed, whatever its output reads like.**

It fails if the brief drops the thing she had to act on, if it reads like
minutes rather than an answer, or if a person ends up needing the raw record
to trust it.

Two numbers: how many messages reach the person, and what one brief costs
against the twelve activations that produced the exchange. The run in
[`demos/`](../demos) is the baseline.
