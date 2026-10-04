# Next: the scope for 0.7.0

> **No compatibility promise before 1.0.0.** 0.6.0 shipped on 2026-10-04
> from commit 18e533c, with twelve packages on npmjs. Until 1.0.0, any
> release may change any export, entry point, journal body, stored format,
> or package API.
>
> - **A change carries no compatibility path.** Add no re-export, no
>   deprecated alias, no reader for an older format, no upgrade step, and
>   no compatibility test.
> - **The changelog names each change** to an export, a journal body, or a
>   stored format.
> - **The guards pin the current surface.** The export snapshot,
>   golden journals, and body validation catch unintended changes.
>   A deliberate change updates the affected guards in the same commit.

**0.7.0 introduces the canvas, the container of the rooms of a
deployment, and lets an agent open a breakout room on it.** The canvas is
the counterpart of the workspace: the workspace is the substrate where
agents work, and the canvas is the front end where agents and people
meet. A breakout room holds delegated work in a journal of its own. A
person can visit it, and each closed exchange reports back to the opener
once, across a restart. [The canvas](../docs/canvas.md) owns the design.
This file owns the work and its evidence. [The backlog](backlog.md) holds
everything else.

## Status

**No item has started.** The owner set breakout rooms as the theme on
2026-10-03, and the canvas as their container on 2026-10-04. The canvas
decisions (CD1) come before the package.

## The scope

**The release follows one breakout room from the open to the report.**

```text
host -> openCanvas -> canvas.resume() -> each running room resumes
                                              |
opener -> breakout({ name, goal, agents }) -> row -> room opens -> start post
                                                                      |
            workers speak in the breakout journal  <- person visits --+
                                                                      |
     exchange closes -> canvas reads room.read() -> keyed report to the opener
```

- **`@ambionframework/canvas`** is the thirteenth package. It holds
  `openCanvas`, the store port with a SQLite and a memory store, the
  `breakout` and `tell` tools, the report, the reminder, and
  `canvas.subscribe`.
- **The canvas owns the list of rooms.** The host opens one canvas and
  calls `canvas.resume()`. The store replaces the room catalog of each
  host.
- **The workbench is the first host.** Its `workbench_rooms` table gives
  way to the canvas store, and its room list draws the tree of the
  canvas.
- **The kernel does not change.** Each part that the canvas uses exists
  today: `startRoom`, `resumeRoom`, `readRoom`, the keyed `room.post`,
  `room.read()`, `exchange_closed`, and the reminder of a bundle.
- **Widgets come later on the same canvas.** The design keeps their
  shape, and no widget ships in 0.7.0.
- **Two fixes come first.** The live tiers expect the current tool list
  (LT1). The mirror stops writing reading preferences (MR1).
- **Supporting items** are in phase 5. Each one can drop at the release
  cut.

## Decisions taken

- **Breakout rooms are the theme.** The owner named them on 2026-10-03.
- **The canvas is the container of rooms.** The owner set it on
  2026-10-04. One canvas holds the rooms of a deployment. Widgets belong
  to a room of it, in a later step.
- **No `task()` or subagent tool.** A native subagent writes no entry, so
  a crash loses its work. The executors keep their native subagents off.
- **The canvas is the one reporter.** A worker has no report tool, so the
  opener wakes once for each exchange. The report carries the last say of
  the exchange and cites its range.
- **The report reads closed exchanges with `room.read()`.** The
  `exchange_closed` event carries the range only. The canvas also reports
  over every closed exchange at each start, because a resume seeds the
  heard closes from the state.
- **A breakout room lives while its opener sits in a running parent.**
  When the opener leaves, the canvas stops the room and posts its pending
  reports with no `to`.
- **The reminder guards a retry.** It lists the rooms of the opener, so a
  retried activation sees the room that it opened.

## Out of scope

- **Widgets.** The design in [The canvas](../docs/canvas.md) keeps their
  shape for a later release.
- **Reads across rooms through `recall`, and an author across rooms.**
  The opener reads the report, and the range through the mirror.
- **A depth above one, and a canvas on Cloudflare.**
- **Bounds that the kernel enforces (D1).** The canvas bounds each open.
- **The adoptions of the harness comparison of 2026-10-04.** The owner
  decided to add none of them.
- **Every other backlog item.**

## The order of work

**The phases run in order.** Each phase has one observable result.
Phases 1 and 2 can run together. Phases 3 and 4 need no provider and no
key, except the one live run of phase 4.

### Phase 1. The fixes

- [ ] **1.** The live tiers expect the current tool list. (LT1)
- [ ] **2.** The mirror writes no reading preferences, and a failed
      mirror attach is visible. (MR1)

**Evidence:** the Claude and Codex live tests name the tools that a seat
holds today. A mirror test reads a message with preferences and finds
none in the file.

### Phase 2. The canvas decisions

- [ ] **1.** The owner settles the open decisions of the canvas. (CD1)

**Evidence:** `docs/canvas.md` states each decision. Its open decisions
hold only the widget questions.

### Phase 3. The canvas package

- [ ] **1.** The canvas and its store on the scripted executor. Needs
      phase 2. (CV1)
- [ ] **2.** Breakout rooms on the canvas. Needs 1. (CV2)
- [ ] **3.** The workbench on the canvas. Needs 2. (CV3)

**Evidence:** a scripted host opens a canvas, resumes its rooms, and an
opener receives one report for each closed exchange of a breakout room.
A refused open names the bound that it broke. A person visits a breakout
room from the workbench room list.

### Phase 4. The canvas evidence

- [ ] **1.** The crash test and one live run. Needs phase 3. (CV4)
- [ ] **2.** The pages and the changelog. (CV5)

**Evidence:** the crash test stops the host at each write of the
durability table, and no report goes missing or lands twice. One live run
on a subscription login delegates, visits, reports, and tells.
`docs/canvas.md` drops its design banner for rooms.

### Phase 5. The supporting items

**Each item is independent and can drop at the release cut.** They come
in the order of their priority.

- [ ] **1.** Range recall in the own room. (RC1)
- [ ] **2.** A closed exchange with no person renders as one line, if a
      measurement shows the need. Needs phase 4 step 1. (CR1)
- [ ] **3.** The speaking text of the room core, with a live check. (SP1)
- [ ] **4.** One name rule. (S1)
- [ ] **5.** `returnable` moves into the verified rules. (P1)

**Evidence:** each item names its own evidence below.

## The items

**LT1. The live tiers expect the current tool list.** A room offers
`seat` only when its reserve holds an agent, and every seat holds
`compose` and `describe`. Three live tests still expect the old list.

1. `packages/codex/test/live/exclusive.test.ts` expects `seat`. Commit
   7e90002 on the branch `claude/mac-0-6-0-live-fixes` fixes it.
2. `packages/claude/test/live/exclusivity.test.ts:12` and
   `hermetic.test.ts:37` expect `seat`, and do not expect `compose` and
   `describe`.
3. `packages/ambion/test/live/restart.test.ts:69` fails with no message
   when the child prints no `ready` line. Give the assertion the output
   of the child, as the assertion above it does.

**Evidence:** the Codex live tier passes on the ChatGPT login. The Claude
tests compile and name the current list. A live run of the Claude tier
needs a key, so it runs when a person asks.

**MR1. The mirror writes no reading preferences.**
`packages/workspace/src/mirror.ts:169` writes each message as the room
holds it. An `arrived` message carries the reading preferences of a
person, and every agent that reads the mirror reads them. The room view
strips them (`packages/ambion/src/room/view.ts:224`). The mirror strips
them the same way. The workbench also ignores a failed mirror attach
(`examples/workbench/src/rooms.ts:243-247`). The mirror is the read path
of the opener, so the workbench logs the failure.

**Evidence:** a mirror test over a real room finds no `preferences` in
the file. A workbench test with a failed attach finds the log line.

**CD1. The canvas decisions.** Each decision changes the tool shape,
the composition, or the store. [The canvas](../docs/canvas.md#open-decisions)
gives the recommended choice for each one.

| #   | Decision                                  | Recommended                                                                                                                                 |
| --- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Who may open a breakout room              | An agent that the host gives the opener bundle. The canvas bounds the count for each opener (3), the depth (1), and the definitions to seat |
| 2   | An author across rooms                    | None in the first step. A report carries the label `breakout <name>:`                                                                       |
| 3   | The name of a breakout room               | `<parent>-<name>`, checked against one room name rule with one length bound (S1)                                                            |
| 4   | The composition of a breakout room        | Workers alone at `broadcast`, no assistant, an empty reserve, `seating: false`, and only definitions that the parent does not seat          |
| 5   | A worker that ends with text and no `say` | The text stays lost, as on every executor today. The report names the exchange with no message                                              |
| 6   | What a person can change                  | A person visits and speaks. Opening a room stays with the host and the opener bundle in the first step                                      |

**CV1. The canvas and its store.** `@ambionframework/canvas` exports
`openCanvas({ name, runtime, agents, store })`, the `CanvasStore` port,
`sqliteCanvas`, and `memoryCanvas`. The store keeps one row for each
room: the name, the goal, the parent, the opener, the depth, and the
state. `canvas.open` writes the row and starts the room.
`canvas.resume()` resumes each running room. `canvas.rooms()` and
`canvas.subscribe` give the host the tree. A conformance suite runs over
both stores.

**Evidence:** tests over real rooms, a real journal, and a real SQLite
file. A host restart finds each running room resumed. The package passes
the export snapshot and the packaging checks.

**CV2. Breakout rooms on the canvas.** `canvas.tools()` gives the opener
bundle.

- **`breakout({ name, goal, agents, to? })`** is idempotent by name. It
  checks the bounds, writes the row, opens the room, and posts the start
  with the key `breakout-start:<name>`.
- **`tell({ room, text, to?, refs? })`** posts into a room that the caller
  opened. A `tell` key lands once for one tool call.
- **The report** reads the closed exchanges of each breakout room with
  `room.read()`. For each one, it posts one line to the opener with the
  last say, cut to a byte cap, and the key `breakout:<name>:<from>`. It
  runs on each `exchange_closed` event and over every closed exchange at
  each start.
- **The reminder** lists each open breakout room of the seat from the
  store, with its state, its open exchange, and the seq of its last
  message.
- **The life of a room** follows its opener: when the opener leaves a
  running parent, the canvas stops the room and posts its pending reports
  with no `to`.

**Evidence:** tests over real rooms on the scripted executor: one report
for each closed exchange, a refused open for each bound, a retried
opener that finds its room in the reminder, and an opener that leaves.

**CV3. The workbench on the canvas.** The workbench opens one canvas over
its SQLite file and drops `workbench_rooms`
(`examples/workbench/src/rooms.ts:154`). It gives the opener bundle to
the definitions that the host names. The room list of the terminal draws
the tree of the canvas, so a person can visit a breakout room.

**Evidence:** a workbench test opens a breakout room, restarts the host,
and finds the room resumed and listed under its parent.

**CV4. The crash test and one live run.** The claim is that a restart
loses no report. A scripted test stops the host after each write of the
durability table in `docs/canvas.md`, starts it again, and counts the
reports. One live run on the ChatGPT login of the owner's Mac (Codex or
Pi): an opener delegates, a person visits, the report arrives, and the
opener tells the workers a follow-up.

**Evidence:** the crash test passes on memory and SQLite storage. This
file records the live run: the model, the exchanges, and the outcome.

**CV5. The pages and the changelog.** `docs/canvas.md` becomes the
contract of the package for rooms, and keeps widgets as a later step.
`docs/README.md` and `README.md` name the canvas. The changelog names the
new package, the workbench change, the mirror change, and each changed
export.

**Evidence:** the docs checks pass, and no page describes a surface that
the release does not export.

**RC1. Range recall in the own room.** `recall` grows two selections:

```text
recall({ refs })              // as today, 1 to 16 refs
recall({ from, through? })    // a seq range; { from: 1 } reads the whole room
recall({ last })              // the N most recent messages
  + optional { kind?, by? }   // filters
```

A result has a byte cap and names the next `from` on its last line. The
authority does not change: a live lease, and a summary reads only through
its exchange. `room.view` takes the selection, so the Durable Object wire
changes. A long worker reads its own room past its window on every host,
Cloudflare included, with no mirror.

**Evidence:** a test reads a range, the last N messages, and a filter
over a real journal. The export snapshot, the golden journals, and the
Cloudflare tests change in the same commit.

**CR1. A closed exchange with no person renders as one line.** This is
the first step of D2. CV4 measures the window growth of a breakout room
where no person speaks. If the growth matters, a closed exchange with no
spoken message renders as one line, and `recall` still reads it. If it
does not, the item drops.

**Evidence:** the measurement from CV4. With the rule, a render test
shows one line for such an exchange.

**SP1. The speaking text of the room core.** The room core states the
rule of silence about five ways, in about 720 tokens. It is the largest
block on a bare seat. Cut it to one statement of each fact. The guidance
review of #535 tuned this text against live runs, so one live run on the
ChatGPT login runs before the cut and one after.

**Evidence:** the token count of a bare seat before and after, and the
two live runs.

**S1. One name rule.** One rule for a name is written six times. The core
has `NAME_PATTERN` and `SEAT` with no length bound. The workspace has the
literal in `resource.ts` and `NAMESPACE`. The workstation has the serve
pattern. The workbench has `ROOM_NAME` with a bound of 48. Breakout rooms
generate names, so a name can pass the core and fail the workbench. The
change keeps one rule with one bound in the core.

**Evidence:** each package imports the one rule, and a test refuses a
name over the bound.

**P1. `returnable` moves into the verified rules.** The rule decides when
the room returns a scheduled say, and `reconcile.ts` and `returning` call
it. It lives in `packages/ambion/src/room/scheduled.ts`, outside
`room/rules.verified.ts`, so it has no contract and no binding case.

**Evidence:** `pnpm rule:check` proves the rule, and a binding case runs
it.
