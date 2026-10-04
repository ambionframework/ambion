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

**0.7.0 gives agents breakout rooms: background work that a person can
visit.** An agent opens a room for delegated work. The workers speak in a
journal of their own. A person can visit the room at any time. Each
closed exchange reports back to the opener once, across a restart.
[Breakout rooms](../docs/breakout.md) owns the design. This file owns the
work and its evidence. [The backlog](backlog.md) holds everything else.

## Status

**No item has started.** The owner set the theme on 2026-10-03. The scope
proposal of 2026-10-04 passed an adversarial review with no blocker. The
breakout decisions (BD1) come before the package.

## The scope

**The release follows one breakout room from the open to the report.**

```text
opener -> breakout({ name, goal, agents }) -> catalog row -> startRoom -> start post
                                                                            |
              workers speak in the breakout journal  <- person visits ------+
                                                                            |
       exchange closes -> bridge reads room.read() -> keyed post to the opener
```

- **`@ambionframework/breakout`** is the thirteenth package. It holds the
  `breakout` and `tell` tools, the bridge, the reminder line, and the
  `BreakoutCatalog` port.
- **The workbench is the first host.** It stores the catalog in its
  SQLite file and lists the breakout rooms that a person can visit.
- **The kernel does not change for breakout rooms.** Each part that the
  design uses exists today: the keyed `room.post`, `exchange_closed`,
  `room.read()`, the seating, and the reminder hook.
- **Two fixes come first.** The live tiers expect the current tool list
  (LT1). The mirror stops writing reading preferences (MR1).
- **Supporting items** are in phase 5. Each one can drop at the release
  cut.

## Decisions taken

- **Breakout rooms are the theme.** The owner named them on 2026-10-03.
- **No `task()` or subagent tool.** A native subagent writes no entry, so
  a crash loses its work. The executors keep their native subagents off.
- **The bridge is the one report.** A worker `report` tool and the bridge
  would both post to the opener, so the opener would wake twice for each
  exchange. Step one has no `report` tool. A worker ends its exchange with
  a `say`, and the bridge cites the range.
- **The bridge reads closed exchanges with `room.read()`.** The
  `exchange_closed` event carries the range only, with no outcome and no
  usage. The bridge also runs over every closed exchange at each start,
  because a resume seeds the heard closes from the state.
- **A post to the workers opens the first exchange.** This is the current
  kernel behavior, and the start post states the task.

## Out of scope

- **The canvas (D5).** It plans a widget for a breakout room, so it comes
  after breakout rooms exist.
- **Reads across rooms through `recall`, and an author across rooms.**
  The opener reads a breakout room through the mirror.
- **A depth above one, and breakout rooms on Cloudflare.**
- **Bounds that the kernel enforces (D1).** The host bounds each open.
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

### Phase 2. The breakout decisions

- [ ] **1.** The owner settles the seven breakout decisions. (BD1)

**Evidence:** `docs/breakout.md` states each decision, and its list of
open decisions is empty.

### Phase 3. The breakout package

- [ ] **1.** The package on the scripted executor. Needs phase 2. (BR1)
- [ ] **2.** The workbench as the first host. Needs 1. (BR2)

**Evidence:** a scripted room opens a breakout room, and the opener
receives one report for each closed exchange. A refused open names the
bound that it broke. A person opens a breakout room from the workbench
room list.

### Phase 4. The breakout evidence

- [ ] **1.** The crash test and one live run. Needs phase 3. (BR3)
- [ ] **2.** The pages and the changelog. (BR4)

**Evidence:** the crash test stops the host at each write of the
durability table, and no report goes missing or lands twice. One live run
on a subscription login delegates, visits, reports, and tells.
`docs/breakout.md` drops its design banner.

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

**BD1. The breakout decisions.** Each decision changes the tool shape,
the composition, or the package. The table gives the recommended choice.

| #   | Decision                                     | Recommended                                                                                                                                  |
| --- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Who may open a breakout room                 | An agent that the host gives the opener bundle. The host bounds the count for each opener (3), the depth (1), and the definitions to seat    |
| 2   | An author across rooms                       | None in step one. A bridge post carries the label `breakout <name>:`                                                                         |
| 3   | The name of a breakout room                  | `<parent>-<name>`, checked against the workbench bound of 48 until S1 lands                                                                  |
| 4   | The composition of a breakout room           | No assistant, each worker at `broadcast`, an empty reserve, `seating: false`, and no summary for a visitor in step one                       |
| 5   | A chain of scheduled says in a breakout room | A returned say opens an exchange, and the bridge reports it. The count bound does not bound the chain. Step one accepts this, and D1 owns it |
| 6   | The place of the host part                   | The package, with a catalog port. The workbench supplies the store                                                                           |
| 7   | A worker that ends with text and no `say`    | The text stays lost, as on every executor today. The bridge reports the exchange with no message, and the reminder shows it                  |

**BR1. The breakout package.** `@ambionframework/breakout` exports two
bundles and the bridge.

- **The opener bundle** holds `breakout({ name, goal, agents, to? })` and
  `tell({ room, text, to?, refs? })`. `breakout` is idempotent by name.
  It checks the bounds, writes the catalog row, starts the room, and
  posts the start with the key `breakout-start:<name>`.
- **The bridge** reads the closed exchanges of each breakout room with
  `room.read()`. For each one, it posts one line to the opener with the
  key `breakout:<name>:<from>`. It runs on each `exchange_closed` event
  and over every closed exchange at each start.
- **The reminder line** lists each open breakout room of the seat, with
  its state, its open exchange, and the seq of its last line.
- **`BreakoutCatalog`** is a port with one row for each room: the name,
  the parent room, the opener, and the depth.

A `tell` key lands once for one tool call. A retried activation makes a
new call, so it can post again. The page states this.

**Evidence:** tests over real rooms and a real journal, on the scripted
executor. The package passes the export snapshot and the packaging
checks.

**BR2. The workbench as the first host.** The workbench implements
`BreakoutCatalog` in its SQLite file, gives the opener bundle to the
definitions that the host names, and resumes each breakout room at a
start. The workbench reads its rooms from `workbench_rooms`
(`examples/workbench/src/rooms.ts:323`). The room list of the terminal
shows breakout rooms under their parent, so a person can visit one.

**Evidence:** a workbench test opens a breakout room, restarts the host,
and finds the room resumed and listed.

**BR3. The crash test and one live run.** The claim is that a restart
loses no report. A scripted test stops the host after each write of the
durability table in `docs/breakout.md`, starts it again, and counts the
reports. One live run on the ChatGPT login of the owner's Mac (Codex or
Pi): an opener delegates, a person visits, the report arrives, and the
opener tells the workers a follow-up.

**Evidence:** the crash test passes on memory and SQLite storage. This
file records the live run: the model, the exchanges, and the outcome.

**BR4. The pages and the changelog.** `docs/breakout.md` becomes the
contract of the package and drops its design banner. `docs/README.md`
indexes the package. The changelog names the new package, the mirror
change, and each changed export.

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
the first step of D2. BR3 measures the window growth of a breakout room
where no person speaks. If the growth matters, a closed exchange with no
spoken message renders as one line, and `recall` still reads it. If it
does not, the item drops.

**Evidence:** the measurement from BR3. With the rule, a render test
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
