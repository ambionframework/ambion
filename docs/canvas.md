# The canvas

> **Status: design. Nothing on this page exists yet.** The page states the
> design of backlog item D5 for review. The package, the tools, the
> catalog, `canvas.subscribe`, the `canvas` layout path, and the host view
> do not exist yet. Every other part that the page names exists today.

**The canvas is the surface that people see, and agents arrange it.** An
agent places widgets and binds each one to a source of data. The host
draws the widgets and keeps the data current. The interface of a room
grows from the work of its agents.

**The canvas is the counterpart of the workspace.** The workspace is the
place where agents do the work. The canvas is the place where the work
shows to people. The canvas is a folder of the workspace, so it is
shared, durable, and outside the journal ([Resources](resources.md)).

| Property        | Workspace                                                       | Canvas                                       |
| --------------- | --------------------------------------------------------------- | -------------------------------------------- |
| Serves          | Agents, which act on files, tables, and processes               | People, who read the room and act on it      |
| Reached through | Workspace tools behind the port                                 | Canvas tools, which write through the port   |
| State           | Files, rows, processes, snapshots                               | One file for each widget                     |
| Provenance      | The audit log and the provenance columns                        | The audit log of the workspace               |
| Host view       | `sensors.subscribe`, `processes.subscribe`, and the mirror file | `canvas.subscribe`                           |
| Agent read      | Files, `jq`, and a reminder for processes                       | A reminder for widgets, and the widget files |

## Why a folder of the workspace

**The state of a canvas lives outside the journal.** An entry for each
canvas operation would give replay and the fence. It would also add
entry kinds and body schemas to the kernel. Each change of a widget
would enter the record that every seat reads. [Breakout
rooms](breakout.md) keep work out of the parent journal for the same
reason.

**One test sorts the state.** If a loss changes what the room decided,
the state is an entry. If a loss changes only what people see, the state
belongs to the canvas. A decision that a person makes on the canvas
becomes a message (see [Acts](#acts)), so the journal keeps every
decision.

**The workspace already gives what the canvas needs.** It gives one
queue, the audit log with provenance, a host read through the port, and
a layout path ([Workspace](workspace.md#the-layout-and-the-host-identity)).
Most sources of a widget are workspace data. A second resource would
repeat each of these parts.

**The canvas package owns four things.** It owns the catalog, the three
tools, the reminder, and `canvas.subscribe`. The tools emit each change
to `canvas.subscribe` in process, as the process tools emit to
`processes.subscribe`. A room with no workspace has no canvas.

**The canvas decides nothing.** It is a view that agents arrange. The
journal stays the authority of the room
([Durability](durability.md)). A crash between a canvas write and the
journal write of the activation leaves a widget for an activation that
the journal never committed. The widget changes no decision, so the room
accepts this.

**The design adds no entry kind and no kernel operation.**

| Need                        | Part                                                               |
| --------------------------- | ------------------------------------------------------------------ |
| Store and queue the widgets | A new `canvas` path in `WorkspaceLayout`, written through the port |
| Tools for a seat            | A bundle, as `workspace.tools()` gives one                         |
| The agent reads the canvas  | The `remind` text of a bundle, as the process reminder gives       |
| Provenance of each change   | `ToolContext` in the audit log of the workspace                    |
| Live data for the host      | `workspace.sensors.get`, `workspace.sql`, the port, `readRoom`     |
| A person acts               | `room.visit` and `visit.send`, with a ref to the widget            |
| Join several placements     | `compose` and [macros](macros.md), through declared outputs        |

## Widgets

**A widget is a view and a source.** The view is a kind from the catalog
of the host and a configuration. The source names data that the host
reads without the agent. The agent sets the source once. The host
refreshes the data at the rate that the kind allows.

**The host closes the fast loop, and the agent closes the slow loop.**
The [actuator](actuators.md#the-loop) page states the same split for a
controller. A widget that the agent fills on each change costs one
activation for each change. A widget with a source costs one tool call
for its life. The agent changes the layout and the sources when the work
changes.

**A source names data that exists today.**

| Source     | Names                   | The host reads it with                                 |
| ---------- | ----------------------- | ------------------------------------------------------ |
| `sensor`   | `<connection>/<sensor>` | `workspace.sensors.get` and the standard sensor client |
| `sql`      | A query that reads      | `workspace.sql`, under `PRAGMA query_only`             |
| `file`     | A workspace path        | The port                                               |
| `snapshot` | A snapshot ref          | The object store; the bytes never change               |
| `process`  | A process handle        | `processes.subscribe` and the output file              |
| `room`     | `ambion://room/<name>`  | `readRoom` and the mirror                              |
| `message`  | A message ref           | The journal                                            |
| `inline`   | Text or a small table   | The configuration itself                               |

**The host reads each source as the host agent.** That agent is
`workspace.mirrorAgent`, `<name>-host`. A widget shows what the host
agent can read, to every person who sees the canvas. The host refuses a
source outside the paths and the tables that it allows. It refuses a
process handle of an agent other than the author of the widget.

**Each refresh is host spend, so the host bounds it.** Each kind has a
lowest refresh period that the host sets. A widget shows the time of
its last read. After a failed read, it shows the last value with a stale
mark, as the camera-chat preview keeps its `failure`.

**A live widget is not evidence.** A `sensor` widget shows temporary
frames, as the camera-chat preview does today. A `snapshot` widget shows
retained bytes, and a message can cite them. To cite a measurement, the
agent calls `observe` and places the snapshot ref
([Sensors](sensors.md#observe-and-retain-evidence)).

### The catalog

**The host declares the kinds that it can draw.** Each kind has a name
and a TypeBox schema for its configuration. The bundle guidance lists the
catalog of the host. A terminal host and a web host give different
catalogs, and an agent places only a kind that the host can draw. A
widget of a kind that the host no longer draws shows as one line that
names its id and kind.

**The full catalog has nine kinds.** The workbench starts with four of
them (see [Decisions](#decisions)).

| Kind       | Shows                                            |
| ---------- | ------------------------------------------------ |
| `markdown` | Formatted text                                   |
| `table`    | Rows, from `sql`, `file`, or `inline`            |
| `chart`    | A series over time or over a category            |
| `image`    | One image, from `sensor`, `snapshot`, or `file`  |
| `log`      | The tail of a file or of a process               |
| `metric`   | One value with a label and a unit                |
| `room`     | The state and the last messages of another room  |
| `form`     | Fields that a person fills; the submit is an act |
| `actions`  | Buttons; a press is an act                       |

**An agent writes no code for a widget.** Code from an agent that runs
in the view of a person is a new trust surface. A later design can make a
custom kind a Git template, as a sensor server is: fork, customize,
validate, commit, and run ([Sensors](sensors.md#run-a-server-from-git)).

### Layout

**The agent states intent, and the host places the widget.** A model
that places widgets by coordinates makes them overlap. A widget carries
an `area` (`main`, `side`, or `pinned`), an `order`, and a `size`
(`small`, `medium`, or `wide`). The host fits these to its screen.

**A person can arrange the view for themselves.** A change of order or
size by a person stays in the host. The host can keep it for that
person. It does not change the shared canvas.

## The tools

**The bundle has three tools.** `canvas.tools()` returns them with
guidance and a reminder. The bundle is the authority to place: a seat
without it cannot change the canvas.

| Tool     | Parameters                                                    | Effect                                                                      |
| -------- | ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `place`  | `id`, `kind`, `config`, `source?`, `area?`, `order?`, `size?` | Creates one widget. The tool checks `kind` and `config` against the catalog |
| `update` | `id`, `rev`, `change`                                         | Changes the configuration, the source, or the layout                        |
| `remove` | `id`, `rev`                                                   | Removes one widget                                                          |

**An id is the name that the agent gives.** It follows the name rule of
an agent (`^[a-z][a-z0-9-]*$`).

**Each tool declares its output.** The `details` hold the widget and its
new `rev`, so `compose` binds the result
([Agents](agent.md#declared-outputs)).

**The reminder lists the widgets.** It gives one line for each widget:
the id, the kind, the source, the author, and the `rev`. The process
reminder works the same way ([Processes](processes.md#reminders)). The
reminder gives at most a fixed count of lines. A longer canvas ends with
a line that names the canvas folder.

## Contention

**Each widget has a revision.** `update` and `remove` carry the `rev`
that the agent read. A stale `rev` is a tool error that holds the
current widget. The agent reads it and decides again. The journal
applies a like rule to an append: a stale position gets `missed`
([Durability](durability.md)).

**`place` creates and never replaces.** A `place` with an id that exists
is a tool error that holds the current widget. A retried activation that
places `build-status` again reads the widget that it placed, and it
cannot overwrite an `update` of another seat. A retried `remove` after a
crash finds no widget, and the error says so. A tool effect can repeat
([Durability](durability.md)).

**A widget has no owner lock.** One seat can steer or unseat another by
design ([Trust](trust.md#what-one-seat-can-do-to-another)). The canvas
follows that rule. The audit log names the agent of each change, so the
host can show which seat changed a widget.

**Two seats on two widgets never contend.** The revision belongs to one
widget, and each widget is one file.

**The canvas has a freshness rule of its own.** The resource contract
gives no freshness guarantee, and the room's freshness rule governs only
what an agent says ([Resources](resources.md#the-resource-contract)). The
revision governs only the widget that it names.

## Acts

**A person does two kinds of things on a canvas.**

| Kind   | Examples                                | Where it goes               |
| ------ | --------------------------------------- | --------------------------- |
| A view | Scroll, sort, expand, hide, rearrange   | It stays in the host        |
| An act | A button press, a form submit, approval | `visit.send` as that person |

**An act is a message of the person.** `send` belongs to a live visit
([Presence](presence.md#3-visiting)). A person can look at a canvas
while absent, so the host calls `room.visit(person)` before it sends the
act. The text starts with the label `canvas:` and states the act. A ref
names the widget at its revision. The `to` of the message is the author
of the widget, so a seat below `broadcast` activates for its own form. A
`room.post` carries no human direction and has no author, so it does not
fit an act.

**The exchange of an act has a `person`.** It is eligible for a summary,
and a configured summary writer then writes one
([Summaries](summary.md)). An act that answers an agent's question to a
person clears an `awaiting` outcome
([Exchange](exchange.md#7-the-edges-a-host-sees)).

**A form is a question with a shape.** An agent asks a person with a
form and ends its activation. When a post or a returned say opened the
exchange, the exchange closes `awaiting`. When the person opened the
exchange, the form is the answer to that person, and the exchange closes
`complete`. The submit is the person who speaks. It activates the agent
with the answer.

**An act lands once.** The key of the send is
`canvas:<widget>:<rev>:<nonce>`. The client makes the nonce once for each
press. A replay of one press lands once, and two presses land twice
([Exchange](exchange.md#7-the-edges-a-host-sees)).

**The record shows the widget that the person acted on.** The ref names
the revision, and the audit log keeps the call that wrote that
revision. A widget can change after the act, and the record still
names what the person saw.

**The ref is a URI that the application chooses.** The kernel owns the
`ambion` scheme and refuses a form that it does not define
([Agents](agent.md#tools)). The canvas uses `canvas://<room>/<id>/<rev>`,
so the first step needs no kernel change.

## Ripple effects

**The kernel does not change.**

**The executors do not change.** Pi, Claude, and Codex receive the canvas
as a bundle, the same as the workspace. A vendor surface that draws for
a person stays off. It writes no entry, and the host cannot see it. The
executors turn off native subagents for the same reason
([Breakout rooms](breakout.md#why-a-room)).

**The prompt sees the canvas only through the reminder.**
`execution/render.ts` stays pure and stateless.

**Each host draws its own catalog.**

| Host        | Effect                                                                                                                        |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Workbench   | The files panel, the process panel, and the previews give a first catalog of four kinds. The feed and the composer stay fixed |
| Camera chat | The preview that opens on `connected` becomes a `sensor` widget that the agent places                                         |
| Cloudflare  | A later step. A Cloudflare room has no workspace today, and the adapter has no WebSocket or fetch handler for a browser       |

**Macros can build a canvas in one call.** A skill can store a macro,
such as `lab-dashboard`, that places five widgets with sources. The
first canvas of a room then costs one tool call and no code from the
model ([Macros](macros.md)). No measurement of macro tokens exists yet.

**A breakout room has a canvas of its own.** A person who visits the
breakout room sees it. The canvas of the parent room holds a `room`
widget with the breakout room as its source: its open exchange, its last
lines, and its outcome. The opener places it in the activation that
calls `breakout`. The bridge does not change ([Breakout
rooms](breakout.md#the-bridge)).

**Sensors keep their wire API.** The `sensor` widget reads through the
standard client, as the camera-chat preview does today. The `api`
version and the evidence path through `observe` do not change.

**An ambient room keeps its canvas current.** Between exchanges, each
widget with a source refreshes with no activation. A scheduled say
brings an agent back to change the canvas on the room's clock.

**The simulator needs a text view of the canvas.** The actor and the
judge read text. The reminder lines give that view. An actor needs a
tool that acts as the person, such as a press of a button.

**The canvas adds a trust surface: agent text that a person sees.** The
host draws only kinds from its catalog. It removes terminal escapes and
raw HTML. It opens refs as the workbench opens them today
([Trust](trust.md#what-the-kernel-does-not-defend)). A seat can place a
button that misleads. The act names the revision, so the record shows
the exact widget.

**A widget shows what the host agent can read.** A `file` or `process`
source can show a file in the home of another agent. A `sql` source runs
agent text as the host on each refresh. The host allows a list of paths
and tables, and it runs each query under `PRAGMA query_only`.

## Decisions

**The owner accepted the recommendations of the review on 2026-10-03.**
Each one holds for now, and a later review can reopen it.

| Decision              | Choice                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------- |
| The scope of a canvas | One canvas for each room. The per-person arrangement in [Layout](#layout) covers the rest |
| The record of an act  | A `visit.send` with the `canvas:` label. No kind of entry for acts                        |
| The first host        | The workbench, with four kinds: file text, a table, an image, and a process log           |
| Code from an agent    | Out of scope. If it comes later, it starts as a Git template                              |

## Open decisions

1. **What a person can change.** A person can arrange and act. The
   question is whether a person can also place a widget, such as a note.
   It stays open for now. One option allows `markdown` alone, with the
   host as the author.
2. **Bounds.** A cap on the widgets of a canvas and on the bytes of an
   `inline` source. [D1](../planning/backlog.md#designs-with-a-shape)
   holds the accounting.
3. **The widgets of an unseated author.** They can stay, go with the
   author, or pass to the host.
