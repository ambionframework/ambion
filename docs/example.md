# The example: Workbench

**One runnable example ships with 0.1.0. It is an agentic lab workbench.**
It replaces the site example and Relay. It is the room a new reader opens
first, the host the deployment guide describes, and the evidence that the
release claims hold. The directory is `examples/workbench`.

Workbench is a narrow build of a larger idea. This page describes what the
example does today, on the current kernel API. The section
[Beyond the current scope](#beyond-the-current-scope) lists the lab
capabilities that wait for later phases in [next.md](../planning/next.md).

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

**One assistant coordinates three specialists.** The assistant answers
ordinary messages, seats a specialist, and writes the closing summary. It
uses `defineAssistant` from `@ambionframework/assistant`, seated at
`broadcast`. It writes the closing summary.

| Agent           | Scope                                                      | Family |
| --------------- | ---------------------------------------------------------- | ------ |
| **Datasheets**  | Reads `/library` and states exact limits with their source | Pi     |
| **Design**      | Chooses parts and values, and shows the circuit math       | Claude |
| **Experiments** | Turns a question into a short, repeatable test plan        | Codex  |

Each room seats the specialists it needs. The reserve holds the rest. The
specialists collaborate through directed messages and report back once.

**The team runs on three executor families.** The assistant and the
datasheets specialist run on Pi. The design specialist runs on
`@ambionframework/claude`. The experiments specialist runs on
`@ambionframework/codex`. `composeExecutions` routes each seat to its family.

| Family | Model                              | Key                 | Seats                 |
| ------ | ---------------------------------- | ------------------- | --------------------- |
| Pi     | `anthropic/claude-sonnet-5`        | `ANTHROPIC_API_KEY` | Assistant, datasheets |
| Claude | `claude-sonnet-5`                  | `ANTHROPIC_API_KEY` | Design                |
| Codex  | `gpt-5.6-luna`, reasoning `medium` | `CODEX_API_KEY`     | Experiments           |

A seat with no key reports the missing variable and does not run. The other
seats run. The scripted tests give the Claude and Codex seats a scripted
execution, so they need no key. The live tests skip a scenario when a family
that it uses has no key. See the
[Workbench README](../examples/workbench/README.md) for the commands.

### One tool set, one filesystem, no native tool

**Every agent holds the same tools and reaches the same filesystem, and no
native tool of any harness is on.** One list of bundles serves every seat:
the workspace, the lab, and the instrument tools, in that order. All three
families share one workspace instance, so a file that one agent writes is
the file that another agent reads.

| Family | How it enforces the guarantee                                        |
| ------ | -------------------------------------------------------------------- |
| Pi     | Has no native tool. The seat holds only the tools that it receives.  |
| Claude | Passes no built-in tool. The definition sets no `allowedTools`.      |
| Codex  | Sets `nativeTools: 'none'` and no policy option that opens the host. |

`test/tool-set.test.ts` fails when a definition drifts from this. The live
test `test/live/tool-set.test.ts` asks each seat for its tool list, writes a
file with one seat and reads it with another, and asks each seat for
`/etc/hosts`.

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

The datasheets are simplified summaries for a runnable example. They are not
the manufacturer datasheets.

### The lab database and the instruments

**The lab records live in `lab.db`, apart from the journal.** The
`projects`, `test_plans`, `runs`, `results`, and `operations` tables hold
them. The SQL resource stamps provenance on every recorded row
(see [Resources](resources.md)).

**Two simulated instruments sit on the lab database.** `led-current` has a
limit of 20 mA. `bench-supply` has a limit of 5 V. The Design specialist and
the assistant call `operate`.

- A setpoint at or below the limit runs. The tool appends a `done` row with
  the reading. The reading equals the setpoint.
- A setpoint above the limit does not run. The tool appends a `requested`
  row and names the exchange owner as the approver.
- The agent asks the owner. When the owner answers, the agent calls
  `approve_operation`. The tool appends an `approved` or `denied` row with
  the `request_id`.

The table is append-only. The status of an operation is its latest row. The
instrument checks the numeric limit only. It does not verify who approved.
The terminal shows a `requested` operation to the exchange owner until a later row answers it.

### The rooms

**Three rooms share one kit.** Each goal shows a distinct collaboration
pattern. Each room offers a suggested prompt.

| Room    | Pattern                  | Starting work                                |
| ------- | ------------------------ | -------------------------------------------- |
| bringup | Datasheet check → design | Blink one LED and choose its series resistor |
| sensing | Design → test plan       | Wire the HC-SR04 and plan a distance test    |
| power   | Datasheet check → budget | Add up the kit current and confirm USB power |

### One process, one terminal

**One Node process runs the rooms and the terminal together.** The terminal
calls the host through a typed in-process API. The example defines no HTTP
interface.

- **Lifecycle.** The rooms run while the terminal runs. When the person
  quits, the host ends each visit, then closes the rooms. The journals stay
  on disk. The next start resumes them.
- **Terminal.** `src/tui.ts` is an OpenTUI application on a dark theme. It has
  a multi-line composer with a room chip, and slash commands to switch person
  or room, create a room, search workspace files in a side panel, and stop, resume, or abort. It shows
  the refs of each message and opens a file, a lab table, or a message from
  one (see the [Workbench README](../examples/workbench/README.md)).
  The person picks an identity on the first screen.
- **Brand.** The terminal reads its colors from the repository brand kit in
  `brand/tokens/ambion.tokens.json`.

## How the example maps onto the kernel

**Every application concept in Workbench is one kernel mechanism.** The
kernel owns the collaboration. The example owns the library files, the
domain instructions, and the terminal.

| Application concept       | Kernel mechanism                                                  |
| ------------------------- | ----------------------------------------------------------------- |
| A kit project             | One room per topic; rooms persist across questions                |
| A person                  | A visit with a definition and reading preferences                 |
| Four definitions          | The assistant and three specialists; the reserve holds spares     |
| The assistant             | The assistant definition, seated at `broadcast`, with the summary |
| Bring in a specialist     | Attention `named`, and a directed say                             |
| Specialists work together | Directed says between seats                                       |
| One answer for the person | The closing activation writes one summary                         |
| Datasheets and artifacts  | The directory workspace, read and written through its tools       |
| History                   | The journal for collaboration; the workspace for files            |

A reader who swaps the library and the instructions for their own domain
keeps the rooms, the visits, and the exchanges.

## What the example shows

**The example is the evidence for the claims a reader tests first.** The
table states what each test proves today. A row marked "By hand" has no
automated test yet.

| Scenario                                                        | Claim                                      | Evidence                                                                      |
| --------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------- |
| A resistor question is answered from `led-5mm.md` in `/library` | A specialist works from a shared file      | Scripted: an agent reads the file. Live: the summary cites `/library`         |
| The assistant routes a question to the Design specialist        | Selection, silence, and one summary        | Scripted: one summary after routing, and a silent close when no agent speaks  |
| A specialist writes a file to the workspace                     | An artifact survives a restart             | Scripted: the file is written, and read again after a restart                 |
| The Experiments specialist plans a distance test                | A question becomes a written plan          | Live: the summary describes a test. No test checks the plan file              |
| A person adds a constraint while an agent works                 | Steering an open exchange                  | By hand: the thread shows the message in order                                |
| The host stops, fails to stop, and resumes                      | Resume keeps the question and the files    | Scripted: clean stop, failed stop with retry, and resume from the journal     |
| Two people work the kit through separate rooms                  | Visits, presence, and catch-up by position | Scripted                                                                      |
| One specialist records a run and another reads it back          | A second resource, apart from the journal  | Scripted: `record` stamps provenance, `query` reads the row from `lab.db`     |
| The Design specialist drives an instrument above its limit      | An action that waits for a person          | Scripted: `operate` records a request, `approve_operation` records the answer |
| The terminal shows the cost of an exchange                      | Cost per exchange is real                  | Scripted: formatting from synthetic usage. Live: `usage.cost` is positive     |
| A message cites a file, a table, or a message                   | A ref opens as a file or a table opens     | Scripted: refs resolve, opens match the panel, a host path stays shut         |
| The terminal opens the steps of an activation                   | A drill-down into the trace                | Scripted: the host reads the trace, and the model groups passes and steps     |
| An exchange ends on a message to a person                       | `awaiting` reads as waiting on that person | Scripted: the discussion flag, and a note for the person named                |
| An instrument request waits for its owner                       | The terminal shows an approval             | Scripted: the host lists the request, and drops it once a later row answers   |

The kernel chaos tier covers a kill during work. This example does not.

## Layout

**One package, one process, one database, one directory.** The layout keeps
every concern in a file a reader can open in order.

```text
examples/workbench/
  README.md            how to run it, and what each part shows
  package.json
  src/
    brand.ts           the product name and the terminal palette
    definitions.ts     the assistant, three specialists, and the people
    scenarios.ts       the rooms, the workspace seed, the lab schema, and the instruments
    instrument.ts      the simulated instruments and their approval step
    rooms.ts           the host lifecycle and the room catalog
    workbench.ts       the host: open, read, watch, send, control, create, files
    names.ts           the room name and goal rules
    files.ts           the workspace list, one file preview, and one lab table preview
    refs.ts            the refs of a message: parse, resolve, and one chip line
    session.ts         the terminal's state and commands, without OpenTUI
    feed.ts            the room feed: one read at a time
    commands.ts        the slash commands and their suggestions
    timeline.ts        the record grouped into questions, threads, and summaries
    steps.ts           the steps of an activation, and the cost of a run
    approvals.ts       the instrument operations that wait for an answer
    text.ts            one line of text fitted to a width, with an ellipsis
    header-fit.ts      what the header rows show at one width
    transcript.ts      the conversation
    header.ts          the panel above the conversation: room, goal, people, pattern
    composer.ts        the composer, room chip, and palette rows
    palette.ts         the palette state: rows, the picked row, and dismissal
    browser.ts         the files panel state: search and the chosen file
    files-panel.ts     the files panel beside the conversation
    database.ts        the SQLite preview: tables and their first rows
    draw.ts            the painter: header, conversation, and composer chrome
    keys.ts            the input: mode, browse selection, and key routing
    tui.ts             the terminal: builds the parts and runs the loop
    families.ts        the family, model, and key of each seat
    unavailable.ts     the execution of a family that has no key
    main.ts            the entry point
  library/             the datasheets as text
  test/                scripted tests: host, session, feed, commands, timeline, text, header,
                       recovery
  test/live/           two scenarios on a real provider
```

The example reads the repository brand kit from the root `brand/`
directory. It adds no brand files of its own. The Node template of
`ambion new` derives from this layout: one room, two Pi definitions, and a
SQLite journal, with the CLI terminal in place of the workbench interface.

## Beyond the current scope

**The fuller lab vision waits for later work.** The original design named
five specialists over data resources and instruments, and a drill-down
interface. The Instruments agent and the Data Analysis agent need
application resources that [next.md](../planning/next.md) does not schedule
for 0.1.0. Workbench grows into them after the release.

| Deferred capability                            | Item in next.md |
| ---------------------------------------------- | --------------- |
| An Instruments agent and a Data Analysis agent | None            |
