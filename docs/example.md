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

| Agent           | Scope                                                      |
| --------------- | ---------------------------------------------------------- |
| **Datasheets**  | Reads `/library` and states exact limits with their source |
| **Design**      | Chooses parts and values, and shows the circuit math       |
| **Experiments** | Turns a question into a short, repeatable test plan        |

Each room seats the specialists it needs. The reserve holds the rest. The
specialists collaborate through directed messages and report back once.

### The shared workspace

**Every room shares one directory workspace.** The workspace holds the
datasheets and the team's artifacts, over the directory binding of the
workspace resource.

- `/library`: datasheet summaries for the kit, copied from
  `examples/workbench/library`.
- `/shared`: `kit.md` and `notes.md`, the team's artifacts.

The datasheets are simplified summaries for a runnable example. They are not
the manufacturer datasheets.

### The rooms

**Three rooms share one kit.** Each goal shows a distinct collaboration
pattern. Each room offers a suggested prompt.

| Room    | Pattern                  | Starting work                                |
| ------- | ------------------------ | -------------------------------------------- |
| bringup | Datasheet check → design | Blink one LED and choose its series resistor |
| sensing | Design → test plan       | Wire the HC-SR04 and plan a distance test    |
| power   | Datasheet check → budget | Add up the kit current and confirm USB power |

### Two endpoints, one host

**One Node process hosts the rooms. A web page and a terminal read the same
rooms through one loopback HTTP API.**

- **Web.** `ui/index.html` is one page with inline CSS and JavaScript. It
  has no build step. It shows the rooms, the conversation, the participants,
  and the library.
- **Terminal.** `src/tui.ts` is an OpenTUI client. It shows the same rooms
  and conversation in a terminal.

Both endpoints share the repository brand kit in the root `brand/`
directory. The web page loads `/brand/tokens/ambion.css` and the brand icons
and logo. The terminal reads the colors from `brand/tokens/ambion.tokens.json`.
One kit holds the identity.

## How the example maps onto the kernel

**Every application concept in Workbench is one kernel mechanism.** The
kernel owns the collaboration. The example owns the library files, the
domain instructions, and the two endpoints.

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

| Scenario                                                        | Claim                                      | Evidence                                                                     |
| --------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------- |
| A resistor question is answered from `led-5mm.md` in `/library` | A specialist works from a shared file      | Scripted: an agent reads the file. Live: the summary cites `/library`        |
| The assistant routes a question to the Design specialist        | Selection, silence, and one summary        | Scripted: one summary after routing, and a silent close when no agent speaks |
| A specialist writes a file to the workspace                     | An artifact survives a restart             | Scripted: the file is written, and read again after a restart                |
| The Experiments specialist plans a distance test                | A question becomes a written plan          | Live: the summary describes a test. No test checks the plan file             |
| A person adds a constraint while an agent works                 | Steering an open exchange                  | By hand: the thread shows the message in order                               |
| The host stops, fails to stop, and resumes                      | Resume keeps the question and the files    | Scripted: clean stop, failed stop with retry, and resume from the journal    |
| Two people work the kit through separate rooms                  | Visits, presence, and catch-up by position | Scripted                                                                     |

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
    scenarios.ts       the rooms, and the workspace seed
    rooms.ts           the host lifecycle and the room catalog
    files.ts           the workspace list and one file preview
    server.ts          the persistent host: HTTP for both endpoints
    client.ts          the HTTP client the terminal uses
    feed.ts            the terminal's room feed: one read at a time
    tui.ts             the terminal endpoint
    main.ts            start or resume
  library/             the datasheets as text
  ui/                  the web page: rooms, conversation, and library
  test/                scripted tests: host, client, feed, and recovery
  test/live/           two scenarios on a real provider
```

The example serves the repository brand kit from the root `brand/`
directory. It adds no brand files of its own. A Node template for `ambion new` is planned to derive from this layout
(item C3 in [next.md](../planning/next.md)). It does not exist yet.

## Beyond the current scope

**The fuller lab vision waits for later phases.** The original design named
five specialists over data resources and instruments, with two executor
families and a drill-down interface. These parts need kernel work that
[next.md](../planning/next.md) schedules. Workbench grows into them as the
phases land.

| Deferred capability                                        | Item in next.md |
| ---------------------------------------------------------- | --------------- |
| A SQL resource for projects, test plans, runs, and results | E4, phase 5     |
| A simulated instrument resource, with an approval step     | E6, F6          |
| An Instruments agent and a Data Analysis agent             | E1, F10         |
| The Claude Agent SDK executor beside the Pi executor       | F10, phase 4    |
| Artifact references on messages and summaries              | E5              |
| An exchange that reads as `awaiting` a person              | E7              |
| Cost per exchange, and a drill-down into activation steps  | F7, F8          |
