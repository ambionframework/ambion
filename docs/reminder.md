# The reminder

This document is the design contract for the reminder: a text an agent
writes for its later self, held in its workspace until it is due, and
delivered into the session as a message that wakes that agent. The reminder
is shipped. The draft, the clock and the two tools live in
[`reminder.ts`](../packages/ambion/src/reminder.ts), the store behind the
just-bash backends in [`just-bash.ts`](../packages/ambion/src/just-bash.ts),
the routing in [`seat.ts`](../packages/ambion/src/seat.ts), and the public
shapes in [`types.ts`](../packages/ambion/src/types.ts). Read
[`agent.md`](agent.md) and [`workspace.md`](workspace.md) first: a reminder
is the second kind of entity a workspace holds, and it enters the room under
the eight rules of the core.

One sentence:

> **An agent that needs something the record does not hold yet sets a
> reminder: a text, and a time. Its workspace holds it. When it is due, the
> session it was set in commits it as a message from that agent, and that
> agent wakes alone to act on it.**

---

## 1. A timer is an event source

[`README.md`](../README.md) names a timer firing as an event source of the
same kind as a person speaking: it enters a session as a message, and
[`agent.md`](agent.md) rule 1 covers what happens next. The reminder is that
event source, built.

**An agent is ambient, and the record is what it knows.** Between
activations it holds nothing. A product that says _"the rebar lands at 14:00"_
has no way to check at 14:00 unless something wakes it then. Before this,
the only things that woke a seat were a person and a colleague. A reminder
lets an agent wake itself, once, at a time it chose, for a reason it wrote
down.

**The agent writes the text; the clock decides the moment.** That is the
whole division. The runtime invents no words: what lands on the record at
14:00 is what the agent wrote at 09:12, stamped from that agent. Rule 7
holds. A reminder is the one message an author reads back, because it wrote
it for that purpose.

**It is not a task.** A reminder is delivered and it is done, or it repeats
on its own grid. Nothing tracks whether the agent acted on it, and nothing
holds state between one delivery and the next. Tasks stay in
[`workspace.md`](workspace.md) §11.

---

## 2. Setting one

An agent that names a workspace holds two more built-in tools, beside
`read`, `write`, `edit` and `bash` ([`workspace.md`](workspace.md) §5):

```ts
remind({ text, at?, after?, every? });
cancel_reminder({ id });
```

**`text` is what the agent reads when it is due.** The runtime's prompt tells
it to write for a reader with no memory of this turn: what to check, and
why. The tool refuses an empty text.

**`at` or `after` says when, and exactly one of them.** `at` is an ISO 8601
time, and it must be in the future; a time already passed is refused, so an
agent that computed a date wrong hears about it. `after` is a duration from
now: a count and one unit, `'90s'`, `'20m'`, `'2h'`, `'3d'`. The tool
refuses any other form.

**`every` repeats it.** The same form as `after`. Once the reminder is
delivered, its next due is one interval on, on its own grid (§4). The
interval is at least one minute: a seat that wakes itself every second is a
room that makes itself expensive, and the floor is the one bound the
runtime puts on it.

**What the seat is told.** The tool answers with the id, the due time, and
how far off it is: `Set r-4f2a1b3c: due 2026-09-02T14:00:00.000Z (in 4
hours). It reaches you alone, as a line on the record, and wakes you.`

**`cancel_reminder` takes an id, and only the caller's own.** An id that is
not the caller's, or that no reminder holds, is refused. The seat's pending
reminders render in its context with their ids (§6), so it has them to
hand.

**The names are reserved.** `defineAgent` refuses a custom tool named
`remind` or `cancel_reminder` for an agent that names a workspace, by the
same rule that keeps the four filesystem names free
([`workspace.md`](workspace.md) §3).

---

## 3. Where it lives: the workspace

```ts
interface Reminder {
  readonly id: string; // assigned when it is set
  readonly owner: string; // the agent that set it, and the only one it wakes
  readonly session: string; // the session it is delivered into
  readonly text: string;
  readonly due: string; // ISO, when it is next due
  readonly every?: number; // milliseconds; absent when delivered once
  readonly setAt: string; // ISO
}
```

**A reminder belongs to the workspace, under §1 of
[`workspace.md`](workspace.md).** It is the second kind of persistent
entity there, beside the filesystem. It is held under the workspace's name,
for as long as the workspace lasts, and it outlives any run of the session
it concerns. `destroyWorkspace` deletes it with everything else.

**The backend holds it.** `WorkspaceBackend` gains one member beside
`connect` and `destroy`:

```ts
interface WorkspaceBackend {
  connect(agent: AgentDefinition, signal?: AbortSignal): Promise<ExecutionEnv>;
  destroy(): Promise<void>;
  readonly reminders: ReminderStore;
}

interface ReminderStore {
  list(): Promise<Reminder[]>;
  put(reminder: Reminder): Promise<void>;
  remove(id: string): Promise<void>;
}
```

Three functions, and a backend author writes them once. A backend that
already holds a filesystem can hold reminders in it, which is what the two
shipped backends do.

**The just-bash backends keep one JSON file per reminder at
`/.ambion/reminders/<id>.json`**, in the workspace's own filesystem
(`REMINDER_DIR` in `just-bash.ts`). The in-memory default keeps them as
long as the handle lives. `directoryBackend(root)` writes them under
`<root>/.ambion/reminders/`, on disk, so a workspace defined again over the
same root finds them. `destroy()` removes them with the rest of the root's
contents.

**The store sits inside the nominal boundary.** An agent's `bash` can list
the directory, and can delete or overwrite a file there, the same way it
can read another agent's home ([`workspace.md`](workspace.md) §8). A file
that does not parse as a reminder is not listed. A file removed by hand is
a reminder cancelled (§4).

**A reminder is set into the session the call runs in.** `session` is
stamped from the room that bound the tool, the way `owner` is stamped from
the seat. Nothing sets a reminder into another session.

---

## 4. The clock belongs to the run

**Nothing about a workspace runs** ([`workspace.md`](workspace.md) §2), so
the workspace cannot deliver anything. The session can: it is the one thing
with a record to commit into and seats to wake. So the session keeps the
clock (`Clock` in `reminder.ts`), one per run, and the workspace keeps the
store.

**Setting a reminder arms it.** `remind` writes it to the store and arms it
in the running room, in one call. The timer is the room's; the reminder is
the workspace's.

**`startSession` arms what an earlier run left.** After the record replays,
the room reads every store its seated agents' workspaces hold and arms
every reminder that was set into this session by an agent seated now,
soonest first. A reminder already due is delivered at once, before
`settled()` or `quiet()` resolves, so a host that starts a room and waits on
it never resolves past an activation the room owed. A store that cannot be
read surfaces there, the same way a record that cannot open surfaces at the
first call that needs it.

**A reminder waits for a run that seats its owner.** One left by an agent
that is not in this run's composition stays in the store, untouched. The run
belongs to `startSession` ([`agent.md`](agent.md) §5), and so does the
choice of who is here to be woken.

**`stopSession` clears the clock and leaves the store.** What was armed
stays where it was set, and the next run arms it again.

**The store is the truth at the due moment.** When a timer ends, the clock
reads the reminder back from the store before it delivers. One that is gone
is delivered nowhere: cancelled through the tool, removed by hand, or held
by a workspace destroyed since. A destroyed workspace's store lists nothing,
so every reminder it held is dropped with it.

**Delivery, then settlement.** The clock commits the message first, then
settles the store: a reminder delivered once is removed, and a repeating one
is written back with its next due and armed again. A process that dies
between the two delivers the same reminder again at the next start. The
safe direction is a reminder heard twice, never one lost, by the same rule
[`presence.md`](presence.md) §8 gives a crash: a window widens, and nothing
hides.

**A repeating reminder keeps its own grid.** The next due is the first
point after now on the grid its first due started, one interval apart. A
reminder that came due many times while no run held its session is
delivered once and then keeps its rhythm; it does not deliver the backlog.

**A far due time is waited for in stretches.** Node holds a timer for about
24 days at most. The clock arms the longest stretch it can, and arms again
when it ends, until the due time is inside one.

**The clock holds the process open.** A timer armed in this run is a timer
Node waits for, so a run with a reminder pending does not exit on its own.
`stopSession` clears it. A host that wants the process to end stops the
room.

---

## 5. Coming due is a message

The record gains one kind:

```ts
interface ReminderMessage {
  kind: 'reminder';
  seq: Seq;
  at: string; // when it landed
  from: string; // the agent that set it — stamped from the reminder's owner
  text: string;
  setAt: string; // when the agent set it
}

type Message = SpokenMessage | PresenceMessage | SummaryMessage | ReminderMessage;
```

**It is not a `said`.** Nobody spoke at the moment it landed. `said` is what
a participant told the room, `arrived` and `left` are what a person did,
`summary` is what one exchange came to, and `reminder` is what an agent
asked to be told. It carries `setAt` because it is the one message written
at one time and landed at another, and a reader wants both.

**Rule 1 holds exactly, and rule 6 decides who wakes.** A reminder has a
reach, `named`, and it names its owner (`targetOf` in `seat.ts`). The owner
wakes for it however narrowly it is seated, the way a directed say wakes the
one it names; nobody else wakes. An assistant sits at `none` and holds no
workspace, so no reminder ever reaches one.

**The author hears it.** A seat never hears its own say: `dispatch` skips
the author of every other message. A reminder is the one exception, and the
exception is the point. The agent wrote it for this moment.

**Rule 2 holds.** A reminder that lands while its owner is mid-activation is
steered into that activation as `[new] · reminder for <owner>: <text>`, and
so is every other seat at work. Working views reset at idle, and the next
activation reads it from the record.

**It commits under no lock.** Rule 5 refuses a message drafted against a
record that moved. A reminder is drafted against nothing: the room observed
its own clock, the way it observes a visit opening, and commits it as it
commits a presence message. The text was fixed when the reminder was set.

**It opens no exchange.** [`exchange.md`](exchange.md) §3 says a person's
question opens one, and nothing else does. A reminder is not a question and
not a person. What its owner does at it is work the room does on its own
account, and what the owner says is a message like any other: a directed
say to an absent person waits on the record for them
([`presence.md`](presence.md) §6). A reminder that lands inside somebody's
open exchange steers the seats already working and changes nothing.

**Every seat reads it.** It is on the record, and the record is what every
activation renders. A colleague reads that the materials tracker's reminder
came due, and reads what the materials tracker then did. Only the owner
wakes.

**The stream carries it as `message`.** One message on the record, one
`message` event, whoever wrote it; no event is added for a reminder.

---

## 6. What the owner reads

Only a seat that can set a reminder is told what one is. Its system prompt
carries one paragraph, rendered when the agent names a workspace
(`REMINDER_PARAGRAPH` in `render.ts`):

> Waiting is the remind tool. When what you need is not on the record yet —
> a delivery that lands at 14:00, a reply that is not due until Monday —
> set a reminder instead of guessing or asking the room to wait. It reaches
> you alone, as a line on the record, at the time you named, and wakes you;
> nobody else wakes for it, and every seat reads it. Write its text for a
> reader with no memory of this turn: what to check, and why. A line reading
> "· reminder for <you>" is one of yours coming due: do what it was set for,
> and speak only if the room needs the result. It asks nobody anything and
> opens no exchange. Your pending reminders are listed above the record;
> cancel one with cancel_reminder when it no longer serves.

**Its context lists what it is waiting for.** Between the people and the
record, soonest first, with the id it would cancel by:

```
Your reminders (each reaches you alone, on the record, when it is due):
- r-4f2a1b3c, due in 4 hours (2026-09-02T14:00:00.000Z), set 12 minutes ago: Check that D-4471 landed; if not, move the pour.
```

A seat with none set reads `(none set)`. The list holds what is armed in
this run: a reminder the same agent set into another session is not shown,
because it will not reach this room. A seat with no workspace reads neither
the list nor the paragraph.

**The record line is an aside.** `· reminder for materials-tracker: Check
that D-4471 landed`, with its age beside it like every other line. A steer
carries the same line after `[new]`.

---

## 7. From a custom tool

`Workspace` gains its second property, as [`workspace.md`](workspace.md) §6
reserved:

```ts
interface Workspace {
  readonly name: string;
  readonly env: ExecutionEnv;
  readonly reminders: Reminders;
}

interface Reminders {
  set(input: ReminderInput): Promise<Reminder>;
  list(): Promise<Reminder[]>;
  cancel(id: string): Promise<boolean>;
}
```

**The value is bound to the calling agent and the running room.** `set`
writes the reminder to the store and arms it in this run, the same as the
`remind` tool does; `list` returns the calling agent's reminders in the
workspace, every session included, soonest first; `cancel` removes one of
the calling agent's and answers whether it did. A domain tool that books an
inspection can set the reminder for the day before in the same call.

**It resolves fresh on every call**, with the rest of `ctx.workspace()`
([`workspace.md`](workspace.md) §4). A destroyed handle resolves `undefined`
there, and a reminder set through a handle since destroyed is delivered
nowhere (§4).

---

## 8. What it costs

- **Setting one** costs a store write. No model call.
- **Coming due** costs one commit and one activation: the owner's. Every
  other idle seat stays at rest, and a seat at work pays a steer.
- **Repeating** costs that once per interval, for ever, until it is
  cancelled. The floor of one minute bounds the rate; nothing bounds the
  count.
- **A run with reminders pending** holds the process open (§4).

---

## 9. What is not decided

- **A calendar form.** `at`, `after` and `every` cover a time, a delay and a
  rate. _Every weekday at 07:00_ is a calendar rule, and a cron expression
  is the usual way to write one. It is a parser or a dependency, and neither
  is taken yet. [`FOLLOW_WORK.md`](../FOLLOW_WORK.md) holds it.
- **How many an agent may hold.** Nothing caps the pending count per owner.
  A seat that sets a reminder on every activation grows its own context list
  without bound.
- **A reminder for somebody else.** Every reminder wakes its owner. An agent
  that wants a colleague woken at 14:00 sets its own, and directs a say when
  it comes due. A reminder addressed to another seat is a directed say with
  a delay, and it would need the receiver's consent to cost it an
  activation.
- **What a task adds.** [`workspace.md`](workspace.md) §11 names tasks
  beside reminders. A task is state that outlives its deliveries, and this
  document builds none of it.

---

## 10. What proves it

The milestone tests live in
[`reminder.test.ts`](../packages/ambion/test/reminder.test.ts), one per
claim this document makes loudly:

- a reminder lands when due as a `reminder` message from the agent that set
  it, with `setAt` two hours before `at`, and wakes that agent alone while
  two colleagues stay at rest (§1, §5);
- the tool answers with the id and the due time, and the owner then reads
  the record line and an empty pending list (§2, §6);
- a pending reminder renders in its owner's context with its id, its due,
  its repeat and when it was set, and the paragraph reaches a seat with a
  workspace and no other (§6);
- a reminder wakes an owner seated `named`, steers a colleague already at
  work as a `[new]` line, and opens no exchange (§5);
- a due time forty days out is waited for in stretches (§4);
- `remind` refuses an empty text, both or neither of `at` and `after`, a
  past time, a time that is not ISO, a duration with no unit, and a repeat
  under a minute (§2);
- `cancel_reminder` removes the owner's own reminder and refuses an id that
  is not theirs, and nothing lands after (§2);
- a repeating reminder is delivered at each interval and stays in the store
  with its next due, and the grid is kept however many deliveries a gap
  missed (§4);
- a reminder survives `stopSession`, is delivered before `settled()`
  resolves in the run that finds it overdue, waits in the store for a run
  that seats its owner, and is delivered once (§4);
- a reminder in a destroyed workspace is delivered nowhere, and raises no
  error (§4);
- `directoryBackend` keeps one JSON file per reminder under
  `.ambion/reminders/`, and `destroy` removes it (§3);
- a custom tool sets, lists and cancels through `workspace.reminders`, and
  what it sets is armed in the running room (§7).

The tests run on vitest's fake timers, so a two-hour wait is one call.
[`workspace.test.ts`](../packages/ambion/test/workspace.test.ts) proves the
two tools bind beside the four, and that `defineAgent` keeps their names
free.

**What is built.** `remind`, `cancel_reminder`, the `Reminder` and
`ReminderMessage` shapes, `Workspace.reminders`,
`WorkspaceBackend.reminders`, the store in both just-bash backends, the
clock, and the routing that wakes an owner alone.

**What is not built.** A calendar form, a cap on the pending count, a
reminder for another seat, and tasks (§9). No live run of
[`examples/site`](../examples/site) has exercised a reminder yet; the
products are told to set one for a delivery's ETA, and the next dated
report in [`demos/`](../demos) is the one to watch.
