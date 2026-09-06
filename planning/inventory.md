# Inventory

The runtime, as a list: the concepts it names, the subsystems that hold
them, and every container of state with the span it lives for. The list
exists to reason about refactoring. Numbers in the last part refer to
[`backlog.md`](backlog.md) where the item is already there.

## Part one: concepts

Each concept has one name, one file that owns it, and one span.

| Concept         | What it is                                                                                      | Owner                    | Span                              |
| --------------- | ----------------------------------------------------------------------------------------------- | ------------------------ | --------------------------------- |
| Definition      | An agent, a person, a tool or a seating, as a branded immutable value                           | `define.ts`, `types.ts`  | The process. Shared across rooms  |
| Workspace       | A named identity and data boundary, with a backend behind the brand                             | `workspace.ts`           | `defineWorkspace` to `destroy`    |
| Room (session)  | One named record, the seats around it, the people in it                                         | `session.ts`             | `startSession` to `stopSession`   |
| Record          | Every committed message, in seq order, replayed from a Pi session                               | `record.ts`              | The name, across runs             |
| Message         | `said`, four presence kinds, `summary`. Each takes one seq                                      | `types.ts`               | Forever, on the record            |
| Seat            | One agent in one room, with its attention and its runtime flags                                 | `seat.ts`                | Seating to unseating              |
| Attention       | The widest kind of message that wakes a seat: `none`, `named`, `broadcast`, `presence`          | `types.ts`, `seat.ts`    | Chosen at seating, never moves    |
| Reserve         | Agents the assistant may seat, held with the attention they will take                           | `session.ts`             | The run                           |
| Activation      | The room wakes one seat, it reads, it acts, it stops. One or more Pi runs                        | `activation.ts`          | Seconds                           |
| Exchange        | A person's question and every activation until the room goes quiet                              | `exchange.ts`            | Open to quiescence. Run state     |
| Visit           | One person in the room, once                                                                    | `presence.ts`            | `visitSession` to `leave`         |
| Presence        | Who is here now, plus what the record says about arrivals and departures                        | `presence.ts`            | Live half: the run. Rest: record  |
| Assistant       | The seat at `none` that composes at an open and writes at a close                               | `assistant.ts`           | The run                           |
| Draft           | One summarising activation's range, refusals and calls                                          | `assistant.ts`           | One activation                    |
| Composing       | One composing activation's owner, limit and count                                               | `assistant.ts`           | One activation                    |
| Rule 5 lock     | A seq an author may commit against, checked and appended in one tick                            | `session.ts`, `record.ts`| One say or one summary            |
| Quiescence      | No seat that speaks for itself is active. Settles waiters and closes the exchange               | `session.ts`             | A moment                          |
| Quiet           | No seat at all is active, the assistant included                                                | `session.ts`             | A moment                          |
| Event stream    | `SessionEvent`: one `message` per commit, activation edges, conflicts, exchange edges, `quiet`  | `types.ts`               | Per event                         |
| Room view       | `RoomView` and `SeatSpeaking`: the picture the prose is rendered from                           | `render.ts`              | One pass of one activation        |
| Tool context    | What a `defineTool` `execute` receives: `workspace()` and the abort signal                      | `workspace.ts`           | One tool call                     |
| Environment     | Pi's `ExecutionEnv` over one `Bash` instance, at one agent's home                               | `bash-env.ts`            | One tool call                     |

Two spans belong to Pi and never surface: a turn (one provider request)
and a run (one `prompt()`).

## Part two: subsystems

One file per concern. The arrow says what a file imports from the runtime.

| File            | Lines | Holds                                                                | Imports from                                  |
| --------------- | ----: | -------------------------------------------------------------------- | --------------------------------------------- |
| `types.ts`      |   312 | The vocabulary, brands, type guards, `authorOf`                      | `exchange.ts` (types only)                    |
| `define.ts`     |   182 | The four definition constructors and the three seating shorthands    | `types.ts`, `workspace.ts`                    |
| `record.ts`     |   117 | `RecordStore`, `openOrCreate`, `persistTurns`                        | `types.ts`                                    |
| `seat.ts`       |   117 | `SeatRuntime`, `wakes`, `toPiTool`, `delivered`                      | `activation.ts`, `types.ts`, `workspace.ts`   |
| `activation.ts` |   170 | `Activation`, `ActivationRoom`                                       | `types.ts`                                    |
| `exchange.ts`   |    84 | `Exchanges`                                                          | `types.ts`                                    |
| `presence.ts`   |    86 | `Attendance`, `VisitRuntime`                                         | `types.ts`                                    |
| `assistant.ts`  |   450 | `Assistant`, `Draft`, `Composing`, `summariseTool`, `seatTool`       | `render.ts`, `seat.ts`, `types.ts`            |
| `render.ts`     |   496 | Every sentence a participant reads. Pure                             | `types.ts`                                    |
| `session.ts`    |  1063 | `SessionImpl`, `ReadOnlySession`, the five public functions, `say`   | Everything above                              |
| `workspace.ts`  |   194 | `defineWorkspace`, `destroyWorkspace`, `toolContext`, `builtinTools` | `just-bash.ts`, `types.ts`                    |
| `just-bash.ts`  |   196 | `memoryBackend`, `directoryBackend`, `lazyResource`                  | `bash-env.ts`, `types.ts`                     |
| `bash-env.ts`   |   306 | `BashEnv`, `Deadline`                                                | none                                          |
| `index.ts`      |    85 | The public surface                                                   | all                                           |

Two facts about the graph:

- **`define.ts` reaches the shell.** It imports `BUILTIN_TOOL_NAMES` from
  `workspace.ts`, which imports `just-bash.ts`. A value module loads the
  virtual filesystem (backlog 5).
- **`assistant.ts` reaches `seat.ts` for `isActive` and `delivered`.** The
  assistant holds a `SeatRuntime` and reads its `activation` field to
  decide whether it may take a draft.

## Part three: state containers

Every mutable thing, grouped by the span it lives for. Each row names
where it is created, where it changes, and where it ends.

### Process scope: module-level state

| Container            | File           | Created         | Changes                                       | Ends                                        |
| -------------------- | -------------- | --------------- | --------------------------------------------- | ------------------------------------------- |
| `running`            | `session.ts`   | Import          | `startSession` adds, `stop` removes           | Never                                       |
| `defaultRepo`        | `session.ts`   | Import          | Every room without a `repo` writes into it    | Never. Records and seat sessions accumulate |
| `builtinRegistry`    | `session.ts`   | First `registry()` | Never                                      | Never. All provider SDKs load at import     |
| `taken`              | `workspace.ts` | Import          | `defineWorkspace` adds, `destroyWorkspace` removes on success | Never                        |
| `WorkspaceState`     | `workspace.ts` | `defineWorkspace` | `destroyed` flips true, and back on a failed destroy | GC of the handle                    |
| `lazyResource`       | `just-bash.ts` | Backend built   | `ready` set on first `get`, cleared on a rejection; `mark` gates it | `destroy`             |

The handle a host holds from `defineWorkspace` looks like a value and is
not one. The backend and the `destroyed` flag sit behind the brand.

### Session scope: fields of `SessionImpl`

| Container         | Type                            | Created                           | Changes                                                              | Ends                                   |
| ----------------- | ------------------------------- | --------------------------------- | -------------------------------------------------------------------- | -------------------------------------- |
| `store`           | `RecordStore`                   | Constructor. Opens and replays    | `append` per commit. `tail` chains writes. `failure` holds one error | `drained` at `stop`                    |
| `agents`          | `Map<string, SeatRuntime>`      | `place` in the constructor        | `seat`, `admit` add. `unseat`, `stop` remove seats marked `added`    | Seats from `startSession` stay         |
| `reserve`         | `Map<string, Reserved>`         | `hold` in the constructor         | `seat`, `admit` take. `retire` returns seats marked `reserved`       | The run                                |
| `assistant`       | `Assistant`                     | Constructor                       | See the next table                                                   | The run                                |
| `here`            | `Attendance`                    | Constructor                       | `visit` enters, `endVisit` and `stop` leave                          | The run                                |
| `exchanges`       | `Exchanges`                     | Constructor                       | `note` opens, `close` closes                                         | The run. Never replayed                |
| `listeners`       | `Set<listener>`                 | Constructor                       | `subscribe` adds, its return removes                                 | Not cleared at `stop`                  |
| `settledWaiters`  | `(() => void)[]`                | Constructor                       | `settled` pushes while working, `settle` drains                      | Drained through `abort` at `stop`      |
| `quietWaiters`    | `(() => void)[]`                | Constructor                       | `quiet` pushes while busy, `markQuiet` drains                        | Drained at `stop`                      |
| `stopped`         | `boolean`                       | `false`                           | `stop` sets it first                                                 | Never resets                           |
| `stirred`         | `boolean`                       | `false`                           | `activate` sets it for a seat that speaks for itself, `settle` clears | Per quiescence                        |
| `name`, `goal`, `repo`, `streamFn`, `customStream` | config | Constructor                   | Never                                                                | The run                                |

### Session scope: what the fields hold

| Container              | Owner          | Created                          | Changes                                                        | Ends                                          |
| ---------------------- | -------------- | -------------------------------- | -------------------------------------------------------------- | --------------------------------------------- |
| `entries`, `lastSeq`   | `RecordStore`  | Replay in `open`                 | `append` pushes and increments, in one tick                    | The store                                     |
| `ready`                | `RecordStore`  | Constructor                      | Resolves once. Its rejection is marked handled                 | The store                                     |
| `inRoom`               | `Attendance`   | Constructor                      | `enter`, `leave`                                               | The run                                       |
| `preferences`          | `Assistant`    | Constructor                      | `serve` on every visit. Never removed                          | The run. Outlives the visit                   |
| `owed`                 | `Assistant`    | Constructor                      | `owe` adds or narrows, `pick` takes                            | The run                                       |
| `waiting`              | `Assistant`    | Constructor                      | `activationEnded` adds, `dueAtQuiescence` clears               | Per quiescence                                |
| `draft`                | `Assistant`    | `pick`                           | The summarise tool widens it, `activationEnded` clears it      | One activation                                |
| `composition`          | `Assistant`    | `compose`                        | The seat tool counts on it, `activationEnded` clears it        | One activation                                |
| `open`                 | `Exchanges`    | `note`                           | `close` clears                                                 | One exchange                                  |

### Seat scope: fields of `SeatRuntime`

| Field        | Created                       | Changes                                       | Ends                                  |
| ------------ | ----------------------------- | --------------------------------------------- | ------------------------------------- |
| `def`, `attention` | `place`                 | Never                                         | `retire`                              |
| `activation` | `activate`                    | `ended` clears                                | One activation                        |
| `piSeat`     | First `persist`               | Never. A promise held for the run             | The run                               |
| `added`      | `seat`, `admit`               | Never                                         | Read at `stop`                        |
| `reserved`   | `seat` from the reserve, `admit` | Never                                      | Read at `retire`                      |

### Activation scope: fields of `Activation`

| Field          | Created                | Changes                                                    | Ends            |
| -------------- | ---------------------- | ---------------------------------------------------------- | --------------- |
| `heardThrough` | `lastSeq` at wake      | Reset per pass. `heard` advances on a say, a refusal, a drained steer | `ended` |
| `pending`      | Empty                  | `steer` pushes, `note` shifts on `[new]` in the transcript | Reset per pass  |
| `agent`        | `open` per pass        | A fresh Pi `Agent` per pass, with empty messages           | Cleared in `run`|
| `cancelled`    | `false`                | `abort`                                                    | The activation  |
| `spoke`        | `false`                | The say, seat and summarise tools set it                   | Read in `ended` |
| `failed`       | `false`                | `broke`                                                    | Read in `ended` |

One pass builds one Pi `Agent`, one system prompt, one turn context and a
fresh tool list. `persistTurns` appends that pass's messages to the seat's
Pi session. A seat's says, and the assistant's writes, commit through
closures that bind the seat and the activation.

### Visit scope

| Container      | Created  | Changes                        | Ends                    |
| -------------- | -------- | ------------------------------ | ----------------------- |
| `VisitRuntime` | `enter`  | `gone` flips on leave and stop | The `Visit` handle drops|

### Tool-call scope

| Container     | Created                       | Changes                          | Ends                         |
| ------------- | ----------------------------- | -------------------------------- | ---------------------------- |
| `ToolContext` | `toPiTool` or `bind` per call | Never                            | The call                     |
| `Bash`, `BashEnv` | `connect` per call        | Never. Nothing is cached         | GC after the call            |
| `Deadline`    | `exec` per command            | Timer fires or caller aborts     | `clear` in `finally`         |

### Persisted scope: Pi sessions in the repo

| Session               | Entries                                              | Written by                        |
| --------------------- | ---------------------------------------------------- | --------------------------------- |
| `<room>`              | `ambion/message` custom entries, one per message     | `RecordStore.append`              |
| `<room>:<agent>`      | `ambion/activation` marker, then the pass's messages | `persistTurns`, parented to room  |

`openOrCreate` lists the whole repo on every open. `readSession` on a name
that is not running builds a new `RecordStore` and replays on every call.

## Part four: where the state cuts across the files

Facts the tables show, each one a place to reason about a refactoring.

1. **Three lifetimes share one class.** `SessionImpl` holds config for the
   run, the roster and the reserve, the commit path, the quiescence
   machinery and the assistant's scheduling. The two waiter arrays plus
   `stirred`, `idle`, `working`, `settle` and `markQuiet` are one concern.
   `commitPresence`, `commitUnrouted`, `deliverFrom`, `publish` and
   `claim` are another. `place`, `hold`, `unwrap`, `assertFreeName`,
   `retire` and `admit` are a third. Backlog 3 names the split.

2. **The room asks the assistant who it is 11 times.** `assistant.is(name)`
   appears in `working`, `hearsSteers`, `activate`, `ended`, `closingOf`,
   `speaking`, `handsFor`, `speaksForItself`, `unseat`, `dispatch` and
   `seats`. The assistant's activation-scoped state, `draft` and
   `composition`, lives on the run-scoped `Assistant`, so the room reads
   them through `closing()` and `composing()` to learn what an activation
   is for. An activation that carries its own purpose, one of speak,
   compose or close, lets `handsFor`, `speaking`, `activate` and `ended`
   read the activation and not the assistant.

3. **The `Assistant` class is three things.** A per-person preferences
   store, a scheduler of owed messages (`owed`, `waiting`, `pick`,
   `dueAtQuiescence`, `dueAfterDraft`, `activationEnded`), and a slot for
   the current activation's purpose. Backlog 20 already predicts the
   scheduler leaves when a second writer arrives.

4. **Two maps keyed on a person's name.** `Attendance.inRoom` holds the
   visit, `Assistant.preferences` holds how they read, and both are set
   from `visit`. Everything else about a person (`known`, `sinceOf`,
   `lastChangeAt`, `unseen`) is a scan of the record. `known()` runs on
   every dispatch and inside `draftOver`'s filter through `speaksForItself`,
   which makes one draft check quadratic in the record. Backlog 2 names
   the index; one `PersonRuntime` record that holds the visit, the
   preferences and the indexed facts is the shape.

5. **Origin is encoded in two optional flags.** `SeatRuntime.added` and
   `reserved` say where a seat came from, and `stop` and `retire` read
   them. An explicit origin, one of `start`, `host` or `reserve`, says the
   same in one field.

6. **Exchange closure is decided in three places.** `publish` closes an
   exchange that woke nobody, `ended` closes one when the seats stop, and
   `stop` closes nothing and resolves the waiters. Each of the first two
   ends with the same `if (this.idle()) this.markQuiet()`. `stirred`
   patches the difference between a settle that followed work and one that
   did not. One evaluator, run after every state change, holds the rule
   once.

7. **`say` is the one tool without a room interface.** `summariseTool` and
   `seatTool` take `SummaryRoom` and `ComposeRoom`. `sayTool` sits inside
   `SessionImpl` and reaches `assertHeard`, `assertAddressable`, `store`,
   `publish` and `emit` directly. Backlog 3 names `SayRoom`.

8. **The clock is ambient.** `new Date()` and `Date.now()` appear in five
   files, nine sites. Nothing injects a clock, so the `ago` lines in a
   rendered record are not deterministic under a scripted stream.

9. **Values with hidden state.** `WorkspaceHandle` carries a backend and
   a `destroyed` flag behind its brand, and `taken` guards its name in a
   module set. `running`, `defaultRepo` and `builtinRegistry` are the
   same pattern for rooms. Backlog 1 names the `Runtime` value that owns
   all of them.

10. **Replay is uncached and open is a list.** `readSession` builds a
    `RecordStore` per call for a stopped name. `openOrCreate` calls
    `repo.list()` on every open, once per room and once per seat.

11. **`RecordStore` is two concerns.** An async open with replay, and a
    synchronous append with a write chain and one remembered failure.
    `ready` is awaited from six sites in `session.ts` before any commit.

12. **Listeners outlive the room.** `stop` drains the waiters and frees
    the name, and leaves `listeners` in place. A host that holds the
    session after `stop` holds every subscriber with it.
