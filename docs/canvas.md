# The canvas

> **Status: design. Nothing on this page exists yet.** The page states the
> design of backlog item D5 for review. It names each kernel part that the
> design uses, and each of those parts exists today. The package, the
> tools, the catalog, and the host view that this page describes do not
> exist yet.

**The canvas is the surface that people see, and agents arrange it.** An
agent places widgets and binds each one to a source of data. The host
draws the widgets and keeps the data current. The interface of a room
grows from the work of its agents.

**The canvas is the counterpart of the workspace.** The workspace is the
place where agents do the work. The canvas is the place where the work
shows to people. Both are resources: shared, durable, and outside the
journal ([Resources](resources.md)).

| Property        | Workspace                                            | Canvas                                     |
| --------------- | ---------------------------------------------------- | ------------------------------------------ |
| Serves          | Agents, which act on files, tables, and processes    | People, who read the room and act on it    |
| Reached through | Workspace tools behind the port                      | Canvas tools behind a port                 |
| State           | Files, rows, processes, snapshots                    | Widgets: a kind, a configuration, a source |
| Provenance      | The audit log and the provenance columns             | An operation log with the same stamp       |
| Host view       | `mirror`, `sensors.subscribe`, `processes.subscribe` | `canvas.subscribe`                         |
| Agent read      | Files, `jq`, and a reminder for processes            | A reminder for widgets, and a JSON mirror  |

## Why a resource

**The state of a canvas lives outside the journal.** A canvas operation
as an entry gives replay, the fence, and freshness at no cost. It also
adds entry kinds and body schemas to the kernel. Each change of a widget
then enters the record that every seat reads. [Breakout
rooms](breakout.md) keep work out of the parent journal for the same
reason.

**One test sorts the state.** If a loss changes what the room decided,
the state is an entry. If a loss changes only what people see, the state
belongs to the canvas. A decision that a person makes on the canvas
becomes a message (see [Acts](#acts)), so the journal keeps every
decision.

**The canvas decides nothing.** It is a view that agents arrange. The
journal stays the authority of the room
([Durability](durability.md)). A crash between a canvas operation and the
journal write of the activation leaves a widget for an activation that
the journal never committed. The widget changes no decision, so the room
accepts this.

**The design adds no entry kind and no kernel operation.** It is one
package, `@ambionframework/canvas`, on the resource contract. The package
uses parts that exist today:

| Need                         | Part                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------- |
| One queue and a backend      | `openResource({ name, backend })` from `@ambionframework/workspace/resource` |
| Tools for a seat             | A bundle, as `workspace.tools()` gives one                                   |
| The agent reads the canvas   | The `remind` text of a bundle, as the process reminder gives                 |
| Provenance of each operation | `ToolContext`: `room`, `activation`, `exchange`, and the agent               |
| Live data for the host       | `workspace.sensors.get`, `workspace.sql`, the port, `readRoom`               |
| A person acts                | `visit.send`, with a ref to the widget                                       |
| Join several placements      | `compose` and [macros](macros.md), through declared outputs                  |

## Widgets

**A widget is a view and a source.** The view is a kind from the catalog
of the host and a configuration. The source names data that the host
reads without the agent. The agent sets the source once. The host
refreshes the data at the rate that the kind needs.

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
| `sql`      | A query that reads      | `workspace.sql`                                        |
| `file`     | A workspace path        | The port                                               |
| `snapshot` | A snapshot ref          | The object store; the bytes never change               |
| `process`  | A process handle        | `processes.subscribe` and the output file              |
| `room`     | `ambion://room/<name>`  | `readRoom` and the mirror                              |
| `message`  | A message ref           | The journal                                            |
| `inline`   | Text or a small table   | The configuration itself                               |

**A live widget is not evidence.** A `sensor` widget shows temporary
frames, as the camera-chat preview does today. A `snapshot` widget shows
retained bytes, and a message can cite them. To cite a measurement, the
agent calls `observe` and places the snapshot ref
([Sensors](sensors.md#observe-and-retain-evidence)).

### The catalog

**The host declares the kinds that it can draw.** Each kind has a name
and a TypeBox schema for its configuration. The bundle guidance lists the
catalog of the host. A terminal host and a web host give different
catalogs, and an agent places only a kind that the host can draw.

**A first catalog has nine kinds.**

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
places widgets badly by coordinates. A widget carries an `area` (`main`,
`side`, or `pinned`), an `order`, and a `size` (`small`, `medium`, or
`wide`). The host fits these to its screen.

**A person can arrange the view for themselves.** A change of order or
size by a person stays in the host. The host can keep it for that
person. It does not change the shared canvas.

## The tools

**The bundle has three tools.** `canvas.tools()` returns them with
guidance and a reminder.

| Tool     | Parameters                                                    | Effect                                                                           |
| -------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `place`  | `id`, `kind`, `config`, `source?`, `area?`, `order?`, `size?` | Writes one widget. The tool checks `kind` and `config` against the catalog       |
| `update` | `id`, `rev`, `change`                                         | Changes the configuration, the source, or the layout. A stale `rev` is a refusal |
| `remove` | `id`, `rev?`                                                  | Removes one widget                                                               |

**An id is the name that the agent gives.** It follows the name rule of
an agent (`^[a-z][a-z0-9-]*$`). A retried activation that places
`build-status` again writes the same widget, so a retry makes no copy.

**Each tool declares its output.** The `details` hold the widget and its
new `rev`, so `compose` binds the result ([Agents](agent.md#declared-outputs)).

**The reminder lists the widgets.** It gives one line for each widget:
the id, the kind, the source, the author, and the `rev`. The process
reminder works the same way ([Processes](processes.md#reminders)). The
reminder gives at most a fixed count of lines. A longer canvas ends with
a line that names the JSON mirror, `/canvas/<room>/canvas.json`.

## Contention

**Each widget has a revision.** `update` and `remove` carry the `rev`
that the agent read. A stale `rev` returns the current widget as a tool
error, and the agent reads it and tries again. A stale `say` returns
`missed` in the same way ([Durability](durability.md)). The journal
applies the same rule as a conditional append.

**A widget has no owner lock.** One seat can steer or unseat another by
design ([Trust](trust.md#what-one-seat-can-do-to-another)). The canvas
follows that rule. The operation log names the agent of each change, so
the host can show which seat changed a widget.

**Two seats on two widgets never contend.** The revision belongs to one
widget, and the directory backend writes one file for each widget.

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

**An act is a message of the person.** The host sends it with
`visit.send`. The text states the act, and a ref names the widget at its
revision. The message opens or joins an exchange that has a `person`. It
owes a summary, and it clears an `awaiting` outcome
([Exchange](exchange.md#7-the-edges-a-host-sees)). A `room.post` carries
no human direction and has no author, so it does not fit an act.

**A form is a question with a shape.** An agent asks a person with a
form and ends its activation. The exchange closes `awaiting`. The submit
is the person who speaks, and it activates the agent with the answer.

**The record shows the widget that the person acted on.** The ref names
the revision, and the operation log keeps that revision. A widget can
change after the act, and the record still names what the person saw.

**The ref needs a form.** The kernel owns the `ambion` scheme and four
forms today ([Agents](agent.md#tools)). The design adds
`ambion://canvas/<canvas>/widget/<id>/rev/<n>`, or it uses a URI that the
application chooses.

## Ripple effects

**The kernel does not change.** The one possible change is the fifth
form of an `ambion:` ref.

**The executors do not change.** Pi, Claude, and Codex receive the canvas
as a bundle, the same as the workspace. A vendor surface that draws for
a person stays off. It writes no entry, and the host cannot see it. The
executors turn off native subagents for the same reason
([Breakout rooms](breakout.md#why-a-room)).

**The prompt sees the canvas only through the reminder.**
`execution/render.ts` stays pure and stateless.

**Each host draws its own catalog.**

| Host        | Effect                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------- |
| Workbench   | The files panel, the process panel, and the previews become the first catalog. The feed and the composer stay fixed |
| Camera chat | The preview that opens on `connected` becomes a `sensor` widget that the agent places                               |
| Cloudflare  | A backend on a Durable Object, one for each canvas. A browser subscribes over a WebSocket                           |

**Macros build a canvas in one call.** A skill can store a macro, such
as `lab-dashboard`, that places five widgets with sources. The first
canvas of a room then costs one tool call and no code from the model.
The live evidence shows that macros, and not free code, save tokens
([Macros](macros.md)).

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

**The canvas keeps its own history.** The operation log holds each
operation with its provenance. A host can show the canvas at a past
revision with no replay of the journal. At a start, the host reads the
canvas and opens each source again.

## Open decisions

1. **The scope of a canvas.** One canvas for each room, which every
   visitor sees. Or one view for each person, so an agent can show two
   people different widgets.
2. **What a person can change.** A person can arrange and act. The
   question: can a person also place a widget, such as a note or a
   pinned message?
3. **The record of an act.** An act as a `visit.send` needs no kernel
   change. A kind of entry for acts would keep typed words apart from
   presses on the record.
4. **The first host.** The workbench is fast to try, and a terminal limits
   the catalog. A web host over Cloudflare is where a canvas gives the
   most.
5. **Code from an agent in a widget.** Out of scope for the first step.
   If it comes later, it starts as a Git template.
