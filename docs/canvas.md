# The canvas

> **Status: design. Nothing on this page exists yet.** The page states the
> design of the canvas for review. The first step, rooms on a canvas and
> breakout rooms, is the scope of 0.7.0 in [the plan](../planning/next.md).
> Widgets are a later step. The package, the tools, the store, and the
> host view do not exist yet. Every kernel part that the page names exists
> today.

**The canvas is the surface where agents and people meet.** It holds the
rooms of a deployment. Later it also holds widgets: views of data that
agents place for people. A person opens the canvas, sees its rooms, and
visits one. An agent opens a room on the canvas for background work, and
the canvas reports the work back.

**The canvas is the counterpart of the workspace.** The workspace is the
substrate where agents do the work. The canvas is the front end where the
work meets people. Each one is a container with a store, a bundle of
tools, a reminder, and a host view.

| Property     | Workspace                                     | Canvas                                         |
| ------------ | --------------------------------------------- | ---------------------------------------------- |
| Serves       | Agents, which act on files, tables, processes | People and agents, which meet in rooms         |
| Holds        | Homes, files, tables, processes, snapshots    | Rooms, then widgets                            |
| Opened with  | `openWorkspace({ name, backend })`            | `openCanvas({ name, runtime, agents, store })` |
| Agent bundle | `workspace.tools()`                           | `canvas.tools()`                               |
| Agent read   | A reminder for processes, and the files       | A reminder for rooms, then for widgets         |
| Host view    | `processes.subscribe`, and the mirror file    | `canvas.subscribe`, and `canvas.rooms()`       |
| Identity     | The agent name                                | The room name                                  |

**Each concern keeps one owner.** The room owns its journal and every
rule of collaboration. The workspace owns the substrate. The canvas owns
which rooms exist, how they relate, and how people reach them. A canvas
holds no collaboration state: each journal stays the source of its room
([Durability](durability.md)).

## Why a container of rooms

**A host already keeps a list of rooms.** The workbench keeps one in
`workbench_rooms`: the name, the goal, and whether the room runs. The
host reads it at a start and resumes each room. Every host that runs more
than one room writes the same table and the same resume loop. The canvas
gives that list one owner.

**Delegated work needs a room of its own.** An agent that delegates work
has three options in Ambion today. Each option fails on one property.

| Option                            | Where the work lives                     | What fails                                                                                                        |
| --------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| A native subagent of the executor | The vendor session of one activation     | A crash loses the work. No entry records it. The host cannot see or bound its spend. Each executor turns it off   |
| A worker seat in the parent room  | The journal of the parent room           | Each note of the work is an entry of the parent room. It fills the window of every seat in that room              |
| A `bash` process                  | A child process of the workspace backend | It runs a command. It cannot hold a conversation between agents                                                   |
| **A breakout room on the canvas** | **A journal of its own**                 | **It keeps each property.** The work is durable, it replays, a person can visit it, and its spend is per exchange |

**The executors turn their native subagents off.** The Claude executor
passes `tools: []`, so the executable has no `Task` tool
([Claude](claude.md)). The Codex executor turns `multi_agent` and
`multi_agent_v2` off ([Codex](codex.md)). The Pi executor gives a seat
only the tools that the room binds ([Pi](pi.md)). The canvas keeps that
rule.

**A breakout room runs work between agents in the background.** A `bash`
process runs a command in the background and gives a handle
([Processes](processes.md)). A breakout room gives a room name in the
same way. The opener ends its activation, and
a report from the breakout room activates it again.

**Widgets need the same container.** A widget shows data to the people
of a room. A widget that shows a breakout room needs to know the rooms
and their relations. That knowledge lives in the canvas, so the widgets
come later on the same canvas.

## The model

**A canvas holds rooms in a tree.** A room that a host or a person opens
is a root. A room that an agent opens is a breakout room, with a parent
room and an opener.

```mermaid
flowchart TD
  C[Canvas: lab] --> R1[Room: design]
  C --> R2[Room: ops]
  R1 --> B1[Breakout: design-survey<br/>opener: surveyor]
  R1 --> B2[Breakout: design-tests<br/>opener: planner]
  C -. later .-> W[Widgets]
```

**The store holds one row for each room.**

| Field    | Holds                                                   |
| -------- | ------------------------------------------------------- |
| `name`   | The room name, which follows the room name rule         |
| `goal`   | The goal of the room                                    |
| `parent` | The parent room, for a breakout room                    |
| `opener` | The agent that opened the breakout room                 |
| `depth`  | 0 for a root room, 1 for a breakout room                |
| `state`  | `running` or `stopped`, which is the intent of the host |

**The store is the one durable record outside the journals.** It holds
hosting intent and the tree. It holds no message, no lease, and no
exchange. A port defines it, and a SQLite store and a memory store
implement it, as the workspace backends do.

**The host opens one canvas and resumes it.** `openCanvas` takes the
runtime, the agent definitions, the store, and an optional workspace.
`canvas.resume()` reads the store and resumes each room with the state
`running`. A room that the host does not resume does no work: its pending
work and its scheduled says wait in its journal.

**`canvas.open` takes the options of `startRoom`.** It takes every option
except `name`, `runtime`, and `agents`, which the canvas supplies: the
seats, the assistant, the summary writer, seating, and the execution. A
root room of the workbench keeps its assistant and its scenario seats.

**The canvas attaches the mirror of each room.** With a workspace, the
canvas calls `workspace.mirror(room)` after each start and each resume.
A failed attach goes to the `onError` of the canvas, and the room keeps
running. The mirror is the read path of an opener, so the host sees the
failure.

**`canvas.stop()` stops every room and keeps each row `running`.** A host
shutdown is no decision about a room. The next `canvas.resume()` starts
each room again, the breakout rooms included.

```ts
const canvas = openCanvas({
  name: 'lab',
  runtime,
  agents,
  workspace,
  store: sqliteCanvas('./data/canvas.db'),
});
await canvas.resume();
const design = await canvas.open({ name: 'design', goal: 'Design the drift test', seats });
```

## Breakout rooms

**An agent opens a breakout room with a goal and its workers.** The
canvas writes the row, starts the room, seats the workers, and posts the
start. The workers speak in the journal of the breakout room. A person
can visit it at any time. The canvas reports each closed exchange to the
opener.

### The tools

**`canvas.tools()` gives the opener bundle.** The bundle is the
authority to open: a seat without it cannot open a room.

| Tool       | Parameters                      | Effect                                                                                  |
| ---------- | ------------------------------- | --------------------------------------------------------------------------------------- |
| `breakout` | `name`, `goal`, `agents`, `to?` | Opens the room `<parent>-<name>`, seats `agents`, and posts the start to `to` or to all |
| `tell`     | `room`, `text`, `to?`, `refs?`  | Posts into a breakout room that the caller opened. A post to a seat at work steers it   |

**`breakout` is idempotent by name.** A call with a name that the
caller already opened returns the same room. A call with a name that
another opener holds is a refusal. The result gives the room name, the
room URI, and the mirror path.

**A worker ends its exchange with a `say`.** A worker has no report
tool. The canvas reports each closed exchange, so a worker tool that
posts to the opener would activate the opener twice for one exchange.

**The reminder lists the breakout rooms of the opener.** It gives one
line for each room: the name, the state, the open exchange, and the seq
of its last message. The reminder reads the store. It also guards a
retry (see [Durability](#durability)).

### The report

**The canvas reports each closed exchange once.** It reads the closed
exchanges of each breakout room with `room.read()`. For each one, it
posts one line to the opener in the parent room:

```ts
for (const exchange of closed) {
  await parent.post({
    to: opener,
    text: `breakout ${name}: exchange #${exchange.from} is ${exchange.outcome}. ${lastSay}`,
    refs: [messageUri(name, exchange.through)],
    key: `breakout:${name}:${exchange.from}`,
  });
}
```

**The report carries the last say of the exchange.** The text is cut to
a fixed byte count. The opener reads the result in the report, and reads
the full range only when it needs more. The range comes from the mirror
at `/rooms/<room>/messages.jsonl`, which is a best-effort copy
([Workspace](workspace.md#mirror-a-rooms-messages)).

**The report reads `room.read()`.** The `exchange_closed` event carries
the range alone, with no outcome and no usage. The canvas runs the report
on each `exchange_closed` event, and over every closed exchange at each
start. A resume seeds the closes that it heard from the state, so the run
at the start is required.

**A post opens an exchange with no person.** Such an exchange owes no
summary ([Exchange](exchange.md#4-who-directs-one-and-who-receives-its-result)).
The report cites the range in place of a summary.

```mermaid
sequenceDiagram
  participant O as Opener seat
  participant P as Parent room
  participant C as Canvas
  participant B as Breakout room
  participant W as Worker seat
  O->>C: breakout({ name, goal, agents })
  C->>C: write the row
  C->>B: open, then post (key breakout-start)
  B->>W: activation
  O-->>P: activation ends
  W->>B: say, and the exchange closes
  B-->>C: exchange_closed
  C->>P: post to opener (key breakout:<name>:<from>)
  P->>O: activation
  O->>C: tell({ room, text })
  C->>B: post to worker
```

### The composition

**A breakout room holds its workers alone.** It has no assistant, and
each worker attends at `broadcast`. The reserve is empty, and seating is
off (`seating: false`), so no worker can seat another agent. A visitor
gets no summary in the first step.

**A breakout room seats only definitions that its parent does not
seat.** The workspace keys homes, processes, and the process reminder by
the agent name ([Workspace](workspace.md)). Two seats of one name in two
rooms would share one home and one process list. A host therefore names
a worker team: definitions that it seats in no root room. The `agents`
bound of the canvas is that team.

### Bounds

**An open is spend, so the host bounds it.** An agent can only lower its
own attention, and the host owns every operation that adds activations.
The canvas checks these bounds before it writes the row:

- **Count.** The most breakout rooms that one opener holds open.
- **Depth.** One. A worker has no opener bundle, so it cannot open a room.
- **Agents.** The definitions that a breakout room may seat. A name
  outside the list is a refusal.

**The canvas bounds the exchanges of a breakout room.** A returned say
in a breakout room opens an exchange, and the canvas reports it. The
count bound does not bound such a chain. The canvas therefore stops a
breakout room after a fixed count of exchanges, and the last report
says so. A kernel bound on the chain is a later design. [D1](../planning/backlog.md#designs-with-a-shape)
holds the accounting and the enforcement.

**Spend is readable per exchange.** Each closed `Exchange` of a breakout
room carries `usage`. An attempt that the room ends (`expired`,
`revoked`, `abandoned`) carries none ([Durability](durability.md#5-what-the-room-does-not-promise)),
so a sum reads less than the spend.

### The life of a breakout room

**A breakout room lives while its opener sits in its parent.** A room is
ambient: it stays available between exchanges. A host shutdown stops the
parent and the breakout room together, and both resume at the next
start (see [The model](#the-model)).

**The canvas learns of a departure from the roster of the parent.**
Before each report, the canvas reads the roster of the parent with
`readRoom`. When the opener is no longer seated, the canvas sets the row
to `stopped`, stops the breakout room, and posts each pending report to
the parent with no `to`, under the same keys. The run at each start
makes the same check, so a departure during a shutdown is found at the
next start.

**A report goes with no `to` when the opener cannot receive it.** A post
to a seat with the attention `none` is a refusal
([Exchange](exchange.md#7-the-edges-a-host-sees)). The canvas reads the
attention of the opener with the roster and posts with no `to` in that
case.

**A stopped room keeps its journal.** `readRoom` and the mirror still
read it.

**Nothing deletes a breakout room.** A journal and its keys stay while
the record is kept. A later design can retire a stopped room.

## Durability

**Each journal holds its own entries.** No entry refers to a host object.
The posts carry the refs between the two rooms, and their keys record
which reports landed. The canvas keeps no cursor.

| Write          | Key                          | A repeat after a crash      |
| -------------- | ---------------------------- | --------------------------- |
| The row        | The room name                | Finds the row and continues |
| The start post | `breakout-start:<name>`      | Returns the same handle     |
| A `tell` post  | `tell:<activation>:<callId>` | Lands once for one call     |
| A report       | `breakout:<name>:<from>`     | Returns the same handle     |

**A crash at any step leaves a state that the next start completes.**

| Crash point                                  | What the next start does                                |
| -------------------------------------------- | ------------------------------------------------------- |
| After the row, before the room starts        | `readRoom` finds no room, so the canvas starts it       |
| After the room starts, before the start post | The canvas posts the start again under its key          |
| After an exchange closes, before its report  | The run at the start posts the report under its key     |
| After the opener leaves, before the reports  | The roster check posts the pending reports with no `to` |
| During a host shutdown                       | `canvas.resume()` starts each `running` room again      |

**A retried opener reads the reminder first.** A `tell` key lands once
for one tool call. An activation that expires and runs again makes new
calls, and the model can pick a new name for `breakout`. The reminder
lists the rooms that the opener holds, so the retried activation sees
the room that it opened. The count bound caps the worst case. A tool
effect can repeat ([Durability](durability.md#5-what-the-room-does-not-promise)).

**The store has no fence.** One host owns a canvas, as one host owns a
workspace. The journal fences a second host of a room. Stop one host
before the next one opens the same store.

## Visits

**A person visits a room of the canvas as any other room.** The person
reads its exchanges and can speak. The first person who speaks in an
exchange becomes its `person`. A worker can ask a visiting person a
question with `say({ to })`, and the `awaiting` outcome holds the wait.

**`canvas.subscribe` gives the host the tree.** It emits an event when a
room opens, stops, or reports. A host draws the tree from
`canvas.rooms()` and the events, and a person picks a room to visit.

## Trust

**A post has no author.** A worker reads a `tell` post as a message of
the system, and the label in its text names the source. The canvas adds
no author across rooms, so it adds no new trust surface.

**The rooms of a canvas share one workspace.** The mirror needs it, and a
shared workspace is one filesystem boundary
([Workspace](workspace.md#mirror-a-rooms-messages)). A worker can read
every room that the workspace mirrors. A room that needs isolation uses
another workspace and gives up mirror reads.

## Widgets, a later step

**A widget is a view and a source.** The view is a kind from the catalog
of the host and a configuration. The source names data that the host
reads with no activation: a sensor, a query, a file, a snapshot, a
process, a room, a message, or inline text. The host closes the fast
loop, and the agent closes the slow loop
([Actuators](actuators.md#the-loop)).

**A widget belongs to a room of the canvas.** The store keeps one row
for each widget, with a revision. A `room` widget shows a breakout room
to the people of its parent. The opener places it in the activation that
calls `breakout`.

**The widget design carries over from the review of 2026-10-03.** The
bundle gains `place`, `update`, and `remove`. `place` creates and never
replaces. `update` and `remove` carry the revision that the agent read.
The host declares a catalog of kinds, and an agent writes no code for a
widget. A press or a submit by a person is a `visit.send` from that
person, with the label `canvas:`, a ref
`canvas://<room>/<id>/<rev>`, and a key for each press.

**The store of a widget moves to the canvas.** The review placed
widgets in a folder of the workspace. The canvas now has a store of its
own, so a widget row sits beside its room row. A widget shows data that
the host reads as `workspace.mirrorAgent`, and the host allows a list of
paths and tables.

## What does not change

- **The kernel.** The canvas adds no entry kind and no kernel operation.
  It composes `startRoom`, `resumeRoom`, `readRoom`, `room.post` with
  `to` and `key`, `room.read()`, the `exchange_closed` event, and the
  `remind` text of a bundle.
- **The executors.** Pi, Claude, and Codex receive the canvas as a
  bundle, the same as the workspace.
- **The prompt.** A seat sees the canvas only through the reminder.
  `execution/render.ts` stays pure and stateless.
- **Recall.** `recall` reads the room of the activation alone.

## Decisions

**The owner set these on 2026-10-03 and 2026-10-04.** A later review can
reopen each one.

| Decision              | Choice                                                                     |
| --------------------- | -------------------------------------------------------------------------- |
| The scope of a canvas | One canvas holds the rooms of a deployment. Widgets belong to a room of it |
| Delegated work        | A breakout room on the canvas. No `task()` or subagent tool                |
| The record of an act  | A `visit.send` with the `canvas:` label. No kind of entry for acts         |
| The first host        | The workbench                                                              |
| Code from an agent    | Out of scope. If it comes later, it starts as a Git template               |

## Open decisions

1. **Who may open a breakout room.** The recommendation: an agent that
   the host gives the opener bundle, a count of three for each opener,
   depth one, and a list of definitions to seat.
2. **An author across rooms.** The recommendation: none in the first
   step. A report carries the label `breakout <name>:`.
3. **The name of a breakout room.** The recommendation: `<parent>-<name>`,
   checked against the room name rule with one length bound (S1 in the
   plan).
4. **The composition of a breakout room.** The recommendation is in
   [The composition](#the-composition).
5. **A worker that ends with text and no `say`.** The recommendation: the
   text stays lost, as on every executor today. The report names the
   exchange with no message.
6. **What a person can change.** A person can visit, speak, and act. The
   question is whether a person can open a room or place a widget.
7. **The widgets of an unseated author.** They can stay, go with the
   author, or pass to the host.
