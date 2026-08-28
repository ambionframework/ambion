# The representative

This document is the design for the representative: the agent a person brings
into a session, which speaks to that person on the room's behalf. **Nothing
here is built.** Read [`agent.md`](agent.md) and [`presence.md`](presence.md)
first — this design adds one field to `defineHuman` and takes nothing away
from the eight rules.

One sentence:

> **A person who visits a room brings one agent of their own. The products
> talk to it, not to them. It waits for the room to stop moving, then gives
> the person one answer in the form they want.**

---

## 1. What the run showed

The run in [`demos/`](../demos) is the evidence for this design.

Priya opened the workspace and asked one question: _can I tell the client
Thursday for the pour?_ Before she left, eleven agent messages landed on the
record. Four of them addressed her directly. One went to another agent. Six
went to the room.

The task list answered her at message 4 — _"No — not yet"_ — and then said
three more things to her. Each addition was true and new. The materials
tracker refined the same rebar fact three times in front of her.

Nothing in that run was wrong. Every seat obeyed every rule. **The room has no
idea when a question is answered, because the largest unit it knows is one
message.** A person gets the room's whole thinking, in the order it happened.

The same run showed the other half. Priya came back to thirteen messages she
had not read. The seat that watches the door woke on her arrival and spoke to
Dan. The catch-up anchor was in its context and the divider was on its record.
No seat had the job of briefing her, so no seat did it.

Both faults have one shape: **the room holds no answer to "who is talking to
this person?"**

---

## 2. The representative

A representative is an agent that belongs to a person rather than to the room.

It carries two things the room cannot hold. First, how that person wants
information: what they act on, what they ignore, how long an answer they read.
Second, the obligation to answer them. A product answers out of its own data
and stops there. A representative answers the person.

Today the demo puts a person's preferences inside each product's instructions.
The materials tracker knows that Dan cares about cost, the task list knows
that Priya books building control, and the time tracker knows what Sam
supervises. Every product carries a copy of every person. That is a modelling
error. Preferences about Priya belong to Priya.

A representative is a normal agent. `defineAgent` makes it, it holds tools if
its author gives it tools, it activates by rule 1, the say lock binds it, and
its turns land in its own downstream session. **It is not an orchestrator.** It
calls nobody and schedules nothing.

---

## 3. What a person brings

The design adds one optional field:

```ts
const priya = defineHuman({
  name: 'priya',
  identity: 'Project manager, site office. Owns the programme.',
  represent: priyaRep,
});
```

`visitSession` seats `represent` for the length of the visit. `leave` unseats
it. `Attendance` already puts the person in the room and takes them out again;
it puts one more seat in and takes one more seat out.

That is the whole runtime change. Everything below is instructions and what a
host renders.

Three consequences follow, and each is a decision:

**The representative is seated `attentive`.** It wakes when its person
arrives, which is exactly the seat whose job is to meet them.

**A representative does not arrive.** People arrive; seats are seated. The
person's `arrived` message already says everything the record needs.

**A representative speaks as itself.** Rule 7 stamps `from` from the runtime,
and a representative is the most tempting place to break it. The person reads
a message from their representative, never a message under their own name.

This bends one sentence of [`presence.md`](presence.md) §1: "Seating is
composition. Visiting is presence." It becomes "Seating is composition; a
visit brings one seat with it." Say it that way rather than discover it.

---

## 4. The working group is not built

A question wakes the seats that have something to say about it. Those seats
are the working group. They select themselves by answering, and they change
from question to question.

**The design gives that group no representation at all.** No membership list,
no convene step, no group object. Three things would want a group, and each
has a better answer:

- _To know when the group has finished_ — "no agent is active" is simpler and
  is already true when the group is idle. See §5.
- _To hide the group's messages from the person_ — hiding follows the role a
  seat holds, not who joined a group. See §7.
- _To decide who may answer the person_ — §8 decides that.

A convene step would also add a phase to a runtime that has none, and a phase
is where an orchestrator gets in.

---

## 5. How a representative knows the room has stopped

The representative must speak once, at the end. It needs to know the products
have finished. **Two mechanisms already give it that, and the design adds
neither.**

**The roster says who is working.** Every activation renders the seats with
their status: `- tasks (active)`, `- materials (idle)`. A representative that
wakes while two products are still active reads that, and stays silent. When
it wakes and every product is idle, it speaks.

**The lock says when it was wrong.** The roster is a snapshot and the room can
move under it. Rule 5 catches that: a say commits only against a record its
seat has heard in full, and a representative that speaks too early is refused
and told what it missed. It reads the new messages and drafts again.

So quiescence is **discovered, not signalled**. The roster tells the
representative when to try; the lock tells it when it was wrong. Rule 1 keeps
its shape: no new activation trigger, and nothing on the record that is not a
message somebody meant.

A representative therefore wakes on every message and stays silent for most of
them. That is the cost of this design, and §11 states it plainly.

---

## 6. Why the representative's answer ends the wave

A representative always directs its say to its person.

The room routes a directed message to exactly its target, and it looks that
target up among the agents. A person is not an agent, so **a say directed at a
person wakes nobody.** The representative's answer lands on the record, the
person reads it, and no seat activates because of it.

That is not a special case written for this design. It is how rule 4 already
works, and it means the wave terminates by construction. Without it, an answer
would wake the products, which would answer, which would wake the
representative, and the room would never settle.

It also composes for several people. Priya, Sam and Dan each bring one
representative. Each waits for the room to stop, each speaks to its own
person, and none of them wakes anything — including each other.

---

## 7. What the person reads

Hiding the intermediate messages is a **read-side filter, and nothing more**.

The record keeps every message. The agents keep reading all of it — a product
that could not see its colleagues' work would answer worse. Rule 2 holds:
everything is a message on one record.

What changes is the view. A person who has a representative in the room reads
the messages addressed to them. The rest stays available, folded, one gesture
away, because a person who wants to see the room's working must be able to.

This belongs where the room's other prose belongs. `render.ts` renders the
record for a seat; rendering it for a person is the same concern, not a third
one.

**Do not put visibility on the message.** A product would then have to know
whether the person it is talking about has a representative, which couples
every product to this design. What the room commits and who reads it are two
questions, and only the second one changes here.

---

## 8. What the products are told

One paragraph in every seat's instructions, and one line on the roster.

The roster names the relation: `- priya (present, represented by priya-rep)`.
The paragraph reads from it: **when a person has a representative in the room,
address the representative rather than the person.** Say what you know, in
your own voice, with your own evidence. Their representative decides what
reaches them and in what form.

This is guidance, not a rule the runtime enforces. A product that must reach
somebody directly still can. Enforcement would make a room unusable the moment
a representative failed, and §11 says why that matters.

---

## 9. The briefing a returning person gets

[`presence.md`](presence.md) §8 puts the catch-up anchor on the record: the
seq of a person's last `left`, and everything after it. The last run proved
the anchor works and that nothing used it well.

A representative is what uses it. Its person arrives, it wakes on the arrival,
`since` names the window, and briefing them is its whole job. It reads
thirteen messages and writes one.

This is the clearest thing a representative does, and it needs no mechanism
that does not already exist.

---

## 10. What this design refuses to add

Stated so that a later change has to argue with it:

- **No working group object.** The group is emergent and observable. §4.
- **No quiescence trigger.** The room never activates a seat because it went
  quiet. The roster and the lock make quiescence readable instead. §5.
- **No visibility field on a message.** Hiding is a property of a reader. §7.
- **No rule that forbids a product from addressing a person.** Guidance, not
  enforcement. §8.
- **No nested session, and no consultation call.** An agent that drives
  another agent and waits is an orchestrator, and this design has none.

---

## 11. Open questions

These are not settled. Do not build past them without deciding.

**The representative is a single point of failure.** Today three products all
speak, so at least one answer reaches the person. With a representative, one
seat's silence is the person hearing nothing. A fallback is needed and none is
designed. Candidates: the products speak directly after a wave with no answer;
or the host shows the raw record when the person's view is empty.

**Latency changes what the room feels like.** Priya gets a partial answer after
one activation today. She would get one good answer after the whole wave. In
the measured run that wave ran about twelve activations. For an ambient
workspace that is fine. For somebody waiting at a prompt it may not be.

**A representative doubles the activations.** It wakes on every message and
stays silent for most of them. The run already spends about a third of its
cost on turns that say nothing. Measure this before believing the design pays
for itself.

**The direct voice is worth something.** _"Nothing on the materials side is
holding you up"_ reads better from the materials tracker than from a
summariser. A representative that flattens three experts into one voice loses
something real.

**A representative has a life outside a room.** It holds a person's
preferences, so it should learn them across sessions. The framework has no
concept that outlives a session. That is a workspace question, not this one,
and this design must not answer it by accident.

---

## 12. What would prove it

Run the same scenario, unchanged, with one representative for Priya.

The design works if her view holds one message where it held eleven, if that
message answers the question she asked, and if the products' own messages are
still on the record and still read by the products.

It fails if the answer arrives after she leaves, if the representative
summarises the room back to itself, or if the total cost rises without the
answer getting better.

Two numbers decide it: how many messages reach the person, and what the room
spends per answer. The run before it is the baseline, and it is in
[`demos/`](../demos).
