# The avatar

This document is the design for the avatar: the agent that turns a room's
work into one message a person reads. **Nothing here is built.** Read
[`agent.md`](agent.md) and [`presence.md`](presence.md) first. This design
adds one field to `defineHuman`, one method to a visit, and no rule.

One sentence:

> **An avatar reads the record for one person and writes them one
> well-structured answer. It never writes to the record, so it changes
> nothing about how the room works.**

---

## 1. The problem, measured

The run in [`demos/`](../demos) is the evidence.

Priya asked one question: _can I tell the client Thursday for the pour?_
Eleven agent messages landed before she left. Four addressed her. One went to
another agent. Six went to the room. The task list answered at message 4 and
then said three more things to her. The materials tracker refined one rebar
fact three times in front of her.

Nothing there is wrong. Every seat obeyed every rule. The room did good work
and handed her the whole of it, in the order it occurred to three products.

**The room's output is a transcript. A person needs an answer.** That is the
entire problem, and it is a problem of presentation, not of routing.

---

## 2. What an avatar is

An avatar is the reader a person brings with them.

It takes the messages that landed since that person last read, and returns
one message: structured, short, in the form that person wants. The room's
back and forth becomes the material for an answer instead of the answer.

**An avatar does not participate.** It holds no seat, it takes no turn, it
appears on no roster, and it never calls `say`. The products do not know it
exists. It cannot start work, join work, or stop work.

**An avatar does not act for its person.** `deliver` stays the person's own
act, in their own words. An avatar that spoke for somebody would put words
under their name, which is what rule 7 exists to prevent. It faces the
person, not the room.

The name is worth one caution. An avatar in a game acts as you. This one is
the opposite direction: it is the room's work, turned to face you. It reads
for you; it never speaks for you.

---

## 3. Why "it never writes" is the whole design

One constraint carries this design, and it is worth seeing what it removes.

Because an avatar never commits a message:

- **Rule 1 is untouched.** An avatar is not activated, because it is not a
  seat. Nothing new wakes anything.
- **Rule 5 does not apply.** The say lock guards the record. An avatar does
  not reach the record, so it cannot race and cannot be refused.
- **Rule 7 cannot break.** Nothing lands under anybody's name.
- **No wave to end.** An avatar's answer wakes nobody, because it is not a
  message. There is no loop to cut.
- **The products change nothing.** No instruction, no new roster line, no
  rule about who may address whom.
- **A failure is cheap.** If the avatar call fails, the host shows the record
  as it does today. Nobody is left unable to speak.

Every one of those was a problem in a design where the avatar spoke. They
disappear together, because they all came from the same assumption.

---

## 4. The shape

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
      Give Priya one answer. Lead with the decision she has to make and who
      holds it. Name the blocker, not the discussion. Leave out cost unless
      it moves a date. Five lines at most.
    `,
  }),
});
```

A visit reads:

```ts
const visit = await visitSession(session, priya);
await visit.deliver({ text: 'Can I tell the client Thursday for the pour?' });
await session.settled();

const brief = await visit.read();
// brief.text    — one message, not eleven
// brief.through — the last seq it covered
```

`read` takes the messages after a cursor and returns prose:

```ts
read(options?: { since?: Seq }): Promise<{ text: string; through: Seq }>;
```

The cursor defaults to `visit.since`, which
[`presence.md`](presence.md) §8 already derives from the record. A host that
reads repeatedly passes back the `through` it last received. **The design
keeps no read cursor of its own**, because a second store is what the
presence design spent its whole effort avoiding.

`defineHuman` gains one optional field. `Visit` gains one method. That is the
whole surface.

---

## 5. Where it sits

The session already renders the record for a seat. `renderContext` builds the
clock, the roster and the record, and hands a seat what it needs to take a
turn. `render.ts` holds that prose, pure and stateless.

An avatar is the same operation with a different reader. A seat reads
structure, so a function is enough. A person wants an answer, so it takes a
model.

That symmetry is the test of whether this belongs in the runtime at all.
**The session owns the record and owns what its readers see.** A seat's view
and a person's view are the same concern, and neither is a third one.

The avatar's call is a Pi agent with no tools and one prompt. Its turn lands
in a downstream session, `<room>:<person>`, beside the seats' own, so a
person's briefs stay auditable the way rule 8 keeps a seat's turns auditable.

---

## 6. What this does not add

Stated so a later change has to argue with it:

- **No working group.** Nothing convenes, nothing has members.
- **No quiescence trigger.** The room never activates anything because it
  went quiet. A host reads when it wants, and `settled()` already tells it
  when the room stopped.
- **No visibility field on a message.** The record keeps everything and the
  agents keep reading everything. Hiding is what one reader sees.
- **No claim on a question.** Seats speak as they do today.
- **No rule about addressing a person.** A product says what it knows to
  whoever it likes. The avatar sorts it out afterwards.
- **No speaking for a person.** Ever.

---

## 7. Open questions

**Two reads in one visit cover the same window.** The cursor comes from the
last `left`, so a second `read` with no argument repeats the first. A host
that passes `through` back avoids this, and that is the MVP answer. If it
proves annoying, the fix is a `read` message on the record — reading is a
thing that happened — and not a cursor kept beside it.

**A read mid-wave gives a partial answer.** The room may still be working.
The host decides: read now and read again, or wait for `settled()`. The
design does not choose, because a terminal and a dashboard want different
things.

**The brief loses the direct voice.** _"Nothing on the materials side is
holding you up"_ reads better from the materials tracker than from a
summariser. The record still holds it, and a host can offer it. Whether
people want the summary or the sources is worth watching.

**An avatar has a life outside one room.** It holds how a person reads, which
should not be re-declared per session. That is a workspace question. Do not
answer it here by accident.

---

## 8. What would prove it

Run the same scenario, unchanged, and give Priya an avatar.

It works if her brief holds the answer to the question she asked, if it is one
message where the record holds eleven, and if the record and the products are
byte for byte what they are today. The last part is the real test: **an avatar
that changes the room has failed, whatever its output reads like.**

It fails if the brief drops the thing she had to act on, if it reads like
minutes rather than an answer, or if a person ends up needing the raw record
to trust it.

Two numbers: how many messages reach the person, and how much one brief costs
against the twenty-five activations that produced it. The run in
[`demos/`](../demos) is the baseline.
