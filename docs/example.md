# The example: Workbench

**One runnable example ships with Ambion. It is an agentic lab workbench.**
It is the room a new reader opens first, the host the deployment guide
describes, and the evidence that the release claims hold. The directory is `examples/workbench`.

Workbench is a narrow build of a larger idea. The
[Workbench repository](https://github.com/fastforwardengine/workbench) runs
that idea as a real application on Ambion.

The [Workbench README](../examples/workbench/README.md) holds the run
commands, the keys, and the terminal.

## Workbench: a lab bench for a toy Arduino kit

**A person and a few specialized agents work on one toy Arduino kit.** A
person asks a question. The agents read the datasheets, choose parts, and
plan tests, on the record. The example connects no real hardware, so every
measurement is a planned value.

### The people

**Three people share the kit. Each one reads a result a different way.** A
person joins a room, asks a question, and reads the summary.

| Person | Role              | Reads first                             |
| ------ | ----------------- | --------------------------------------- |
| Mira   | Hardware lead     | The part choice and the current margins |
| Theo   | Firmware engineer | The pin assignments and the timing      |
| Sol    | Lab technician    | The wiring steps in order               |

### The assistant and the specialists

**One assistant coordinates three specialists.** The assistant seats
a specialist, routes a request to a named specialist, and writes the closing
summary. It uses `defineAssistant` from `@ambionframework/assistant`, seated
at `broadcast`.

| Specialist      | Scope                                                      |
| --------------- | ---------------------------------------------------------- |
| **Datasheets**  | Reads `/library` and states exact limits with their source |
| **Design**      | Chooses parts and values, and shows the circuit math       |
| **Experiments** | Turns a question into a short, repeatable test plan        |

Each room seats the specialists it needs. The reserve holds the rest. The
specialists collaborate through directed messages and report once to the room.
The seats run on three executor kinds. The
[Workbench README](../examples/workbench/README.md#the-team) names the kind,
the model, and the key of each seat.

**Specialists do delegated work in breakout rooms.** The assistant and
every specialist hold the one canvas bundle: `breakout`, `tell`, `archive`,
and `report`. The assistant opens a breakout room and names the specialists
that staff it. A specialist works in a root room and in a breakout room with
one definition, one home, and the same tools. The room decides what it does.
In a breakout room it sends its result with `report`. A question for a person
goes to a person who is present. When nobody is present, the specialist
reports the question to the opener.

The assistant delegates a long task, and the specialists keep their narrow
scope in the room of the person. The report of a specialist reaches the
assistant in the parent room.

### One tool set, one filesystem, no native tool

**Every agent holds the same tools and reaches the same filesystem, and no
native tool of any harness is on.** One list of bundles serves every seat:
the workspace, the instrument, the widget, and the canvas tools, in that order. Each seat
also has the `compose` tool, which is the default of the executor packages. All three
executor kinds share one workspace instance, so a file that one agent writes is
the file that another agent reads. The workbench passes its own execution for
each executor kind, because it checks keys and lets a test script an
executor.

`test/tool-set.test.ts` fails when a definition drifts from this.
[Trust](trust.md#what-each-harness-exposes) states how each executor kind
enforces it and what the live test proves.

### The shared workspace

**Every room shares one directory workspace.** The workspace holds the
datasheets and the team's artifacts, over the directory binding of the
workspace resource.

- `/library`: datasheet summaries for the kit, copied from
  `examples/workbench/library`.
- `/shared`: `kit.md` and `notes.md`, the team's artifacts.
- `/workspace/audit.jsonl`: one line per tool call, from the workspace audit
  log.
- `/rooms/<room name>/messages.jsonl`: one line per message, mirrored from
  each room's own journal.

**The workspace's `sql` tool opens `lab.db`.** The SQLite backend keeps
this file beside the workspace directory, and the shell does not reach it.

**The workspace has a git backend, `justGitBackend` of
`@ambionframework/just-bash/git`, with its storage in `git.db`.** It holds
three read-only templates from `examples/workbench/templates`.
The template `firmware-sketch` holds a pin map, an Arduino sketch, and a
sweep of the LED resistor. An agent forks a template with `fork`, clones
the fork into its home, and pushes a branch with `git` in `bash`. A peer finds the fork with `repos` and uses `git clone` in `bash` to review. A push
survives a restart of the host. [Git](git.md) holds the contract.

**The sweep of `firmware-sketch` runs as a background process.** `sweep/sweep.sh`
steps the series resistor of the LED through ten values, one every 3
seconds, and writes `sweep/results.csv`. An agent starts it with `bash`
and a `name`, and the sweep runs past the exchange. A later exchange in the
same room reads its state with `ps` or `wait`, and the reminder
of each activation names it ([Processes](processes.md)).

**A process that serves HTTP needs the workstation backend.** The running
Workbench uses `directoryBackend`, which has no endpoints. Its terminal
workspace has no `fetch` tool. A workstation with endpoints provides `fetch`
for a Git template that serves on `$PORT`. The Workbench shows two patterns
over such processes: [Sensors](../examples/workbench/docs/sensors.md) and
[Actuators](../examples/workbench/docs/actuators.md). The
[workstation acceptance](../packages/workstation/test/sshd/process-http-lifecycle.test.ts)
runs a process of this kind.

The datasheets are simplified summaries for a runnable example. They are not
the manufacturer datasheets.

### The lab database and the instruments

**The lab records live in `lab.db`, apart from the journal.** The
`projects`, `test_plans`, `runs`, `results`, and `operations` tables hold
them. The host opens `sqliteBackend` with the lab schema. The `runs`
table has a UNIQUE constraint on its project and label, so a retried
INSERT fails and records no run twice. The instrument writes the agent, the
room, the activation, the exchange, and the time into each `operations`
row. The host opens the database at its start, so the terminal shows the
tables before the first question.

**Two simulated instruments sit on the lab database.** `led-current` has a
limit of 20 mA. `bench-supply` has a limit of 5 V. The Design specialist calls
`operate`.

- A setpoint at or below the limit runs. The tool appends a `done` row with
  the reading. The reading equals the setpoint.
- A setpoint above the limit does not run. The tool appends a `requested`
  row and names the `person` of the exchange as the approver. With no
  `person`, the tool refuses the operation.
- The agent asks that person. When the person answers, the agent calls
  `approve_operation`. The tool appends an `approved` or `denied` row with
  the `request_id`.

The instrument only appends to the `operations` table. The status of an
operation is its latest row. The instrument checks the numeric limit only. It
does not verify who approved.
The terminal shows a `requested` operation to the `person` of the exchange
until a later row answers it.

### The rooms

**Four rooms share one kit.** Each goal shows a distinct collaboration
pattern. Each room offers a suggested prompt.

| Room     | Pattern                         | Starting work                                             |
| -------- | ------------------------------- | --------------------------------------------------------- |
| bringup  | Datasheet check → design        | Blink one LED and choose its series resistor              |
| sensing  | Design → test plan              | Wire the HC-SR04 and plan a distance test                 |
| power    | Datasheet check → budget        | Add up the kit current and confirm USB power              |
| firmware | Template → fork → pushed branch | Fork the firmware sketch, set the pins, and push a branch |

## How the example maps onto the kernel

**Every application concept in Workbench is one kernel mechanism.** The
kernel owns the collaboration. The example owns the library files, the
domain instructions, and the terminal.

| Application concept       | Kernel mechanism                                                  |
| ------------------------- | ----------------------------------------------------------------- |
| A kit project             | One room per topic; rooms persist across questions                |
| A person                  | A visit with a definition and reading preferences                 |
| Four definitions          | The assistant and three specialists; the reserve holds spares     |
| Delegated work            | A breakout room that specialists staff                            |
| The assistant             | The assistant definition, seated at `broadcast`, with the summary |
| Bring in a specialist     | Attention `named`, and a directed say                             |
| Specialists work together | Directed says between seats                                       |
| One answer for the person | The summary activation writes one summary                         |
| Datasheets and artifacts  | The directory workspace, read and written through its tools       |
| History                   | The journal for collaboration; the workspace for files            |

A reader who swaps the library and the instructions for their own domain
keeps the rooms, the visits, and the exchanges.

## What the example shows

**The example is the evidence for the claims a reader tests first.** The
table states what each test proves today. A row marked "By hand" has no
automated test yet.

| Scenario                                                                    | Claim                                      | Evidence                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A resistor question is answered from `led-5mm.md` in `/library`             | A specialist works from a shared file      | Scripted: an agent reads the file. Live: the summary cites `/library`                                                                                                                                                                 |
| The assistant routes a question to the Design specialist                    | Selection, silence, and one summary        | Scripted: one summary after routing, and a silent close when no agent speaks                                                                                                                                                          |
| The assistant delegates a task to a specialist in a breakout room           | A report reaches the opener, who archives  | Scripted: a `breakout`, a `report` in the parent room, an `archive`, and a close notice for an exchange with no report. A restart resumes the room and posts no notice twice                                                          |
| A specialist writes a file to the workspace                                 | An artifact survives a restart             | Scripted: the file is written, and read again after a restart                                                                                                                                                                         |
| The Experiments specialist plans a distance test                            | A question becomes a written plan          | Live: the summary describes a test. No test checks the plan file                                                                                                                                                                      |
| A person adds a constraint while an agent works                             | Steering an open exchange                  | By hand: the thread shows the message in order                                                                                                                                                                                        |
| The host stops, fails to stop, and resumes                                  | Resume keeps the question and the files    | Scripted: clean stop, failed stop, failed save of the stopped state with retry, and resume from the journal                                                                                                                           |
| Two people work the kit through separate rooms                              | Visits, presence, and catch-up by position | Scripted                                                                                                                                                                                                                              |
| One specialist records a run and another reads it back                      | Records apart from the journal             | Scripted: an INSERT through `sql` lands, a SELECT reads the row from `lab.db`, and a second INSERT of the label fails                                                                                                                 |
| The Design specialist drives an instrument above its limit                  | An action that waits for a person          | Scripted: `operate` records a request, `approve_operation` records the answer                                                                                                                                                         |
| The terminal shows the cost of an exchange                                  | Cost per exchange is real                  | Scripted: formatting from synthetic usage. Live: `usage.cost` is positive                                                                                                                                                             |
| A message cites a snapshot, a commit, a file, a table, a room, or a message | Every ref kind opens where it belongs      | Scripted: refs resolve; a snapshot previews as text, a picture, tables, or a binary note; a commit previews its log entry, its changes, and where its branch points now; a room and a message open their room; a host path stays shut |
| A person attaches a local picture and sends it                              | `/attach` cites a snapshot of the file     | Scripted: the file lands in the workspace, its snapshot reads back, and the ref goes with the message                                                                                                                                 |
| A person pastes a bare picture path into an empty composer                  | The paste fills `/attach`, not the message | Scripted: `pastedImagePath` draws the line — a path, not a sentence, a multi-line paste, or a path with a space. By hand: the composer fills `/attach` only when it was empty                                                         |
| The terminal opens the steps of an activation                               | A drill-down into the trace                | Scripted: the host keeps the steps its logger receives, and the model groups passes and steps                                                                                                                                         |
| An exchange ends on a message to a person                                   | `awaiting` reads as waiting on that person | Scripted: the discussion flag, and a note for the person named                                                                                                                                                                        |
| An instrument request waits for its approver                                | The terminal shows an approval             | Scripted: the host lists the request, and drops it once a later row answers                                                                                                                                                           |
| The Design specialist starts the firmware from a template                   | A fork, a clone, and a pushed branch       | Scripted: Design forks `templates/firmware-sketch`, sets a pin, and pushes `sensing`. Experiments clones the fork and reads the pin                                                                                                   |
| A sweep runs in the background past its exchange                            | A later exchange reads the sweep's state   | Scripted: Design starts `sweep/sweep.sh`, and the next exchange finds it with `ps` and waits on its handle. Live: the second summary names the handle, and the sweep exits 0                                                          |

The kernel chaos tier covers a kill during work. This example does not.
