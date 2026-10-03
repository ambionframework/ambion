# Next: the scope for 0.6.0

> **No compatibility promise before 1.0.0.** 0.5.0 shipped on 2026-10-02
> from commit bd813ce, with eleven packages on npmjs. Until 1.0.0, any
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

**0.6.0 gives a seat the `compose` tool, fixes three defects that 0.5.0
left open, and removes one concept that the repository holds twice.**
[Compose](../docs/compose.md) owns the compose contract. This file owns
the work and its evidence. [The backlog](backlog.md) holds everything
else.

## Status

**Every item is complete. The release remains.** CS1, CC1, CX1, and W5
merged, and so did CP1 to CP7. The live run of CP6 found that
the guidance steers `gpt-5.6-luna` and `claude-opus-5-5` to `compose` for
a chain, and does not steer `claude-sonnet-5`. The compose design passed two design
reviews and two readiness reviews on ambionframework/ambion#395. A `tsc`
run checked the typed `defineTool`. A prototype on `quickjs-emscripten`
0.32 ran two binding calls at once. Node 22.22.2 and Node 26.4.0 checked
the `--allow-net` test of `processEvaluator`.

## The scope

**The release follows one compose call from the definition to the
model.**

```text
executor options -> describeExecutor appends compose -> catalog and guidance
                                                            |
            model -> compose({ uses, code }) -> approve -> evaluator
                                                            |
                         nested calls -> declared outputs -> ledger -> value
```

- **`compose({ uses, code })`** joins the tools of the definition. The
  model reads only the returned value, or the error and the ledger.
- **Declared outputs** give the code typed `details`. `defineTool` checks
  them at compile time, and `compose` checks them at every call.
- **`@ambionframework/compose/runtime`** holds `quickjsEvaluator` and
  `processEvaluator`. Both pass `evaluatorConformance`.
- **Pi, Claude, and Codex** host `compose` as one more definition tool.
- **Three fixes** close defects that 0.5.0 left open: a late steer on
  Claude (CS1), the Camera Chat findings (CC1), and Codex on a ChatGPT
  sign-in (CX1).
- **One simplification** gives the sensor path one validation (W5).

## Decisions taken

- The tool is `compose`. One run is a compose call. The page never uses
  `composition`, which names the roster entry of the journal.
- `uses` is required. `compose` checks it, then asks `approve`, then
  evaluates the code.
- A declared tool gives its `details`. An undeclared tool gives its text.
- The room tools do not bind. A compose call computes a value, and the
  agent decides what to say.
- The code has no clock, no random source, no timer, and no I/O except
  through its bindings.
- A failed or cancelled compose call throws, and its message holds the
  ledger. A call that outlives the code keeps the result.
- The limits and the guidance live on the `compose` option.
- The live token comparison is evidence of the release (CP6). It gates no
  phase before phase 5.
- `ToolContext` has no public `record` and no public `ctx.call`. One
  function runs a tool call (`tool-call.ts`), and only the core hands the
  step sink to `compose`.

## Out of scope

- **An evaluator for workerd.** A seat on `@ambionframework/cloudflare`
  has no `compose` option in 0.6.0.
- **Replay of a compose call from its trace.** The trace caps can cut a
  nested output.
- **Room tools in a compose call.** `say`, `schedule`, `seat`, `unseat`,
  `dismiss`, and `recall` stay direct calls.
- **Concurrent operations in one workspace.** Parallel calls of file tools
  still run one operation at a time. D9 holds concurrent operations.
- **A compose call inside a compose call.**
- **Every backlog item.**

## The order of work

**The compose phases run in order.** Each compose phase has one
observable result. Complete each phase and its evidence before starting
the next phase. Within a phase, items can proceed together when their
dependencies allow. Phases 2 to 4 need no provider and no key. Phase 1
runs beside the compose phases and blocks only the release.

### Phase 1. The fixes and the simplification

- [x] **1.** A late steer on Claude keeps its answer. (CS1)
- [x] **2.** The Camera Chat fixes. (CC1)
- [x] **3.** Codex on a ChatGPT sign-in. (CX1)
- [x] **4.** The sensor path validates once. (W5)

**Evidence:** the `claude` tests steer during the final answer, and the
answer to the line commits. Each Camera Chat fix has its test or its
README text. The full Codex live tier passes on the ChatGPT login of the
owner's Mac. The sensor path checks each schema and digest once.

### Phase 2. The vocabulary and the trace

- [x] **1.** The tool vocabulary and the typed `defineTool`. (CP1)
- [x] **2.** The step sink, parented steps, and the scripted executor.
      Needs 1. (CP2)

**Evidence:** a definition refuses a user tool named `compose`. A type
test refuses a declared tool that returns a string, a wrong literal, or a
missing field. A parented step raises tool events and gives its id to no
direct call. The scripted executor gives a tool call a signal, the
deadline, and a step sink.

### Phase 3. Compose on the scripted executor

- [x] **1.** The `compose` tool with an evaluator for tests alone. Needs
      phase 2. (CP3)
- [x] **2.** The declared outputs of the workspace tools. Needs phase 2.
      (CP4)
- [x] **3.** Skill macros. Needs CP3. (CP-M)

**Evidence:** acceptance items 1, 2, 4, and 5 of
[Compose](../docs/compose.md#acceptance) pass on the scripted executor.
A compose call binds `sql` and `snapshot` over a real workspace and a real
SQLite file. A skill macro runs by name over the same workspace and file.

### Phase 4. The evaluators

- [x] **1.** `evaluatorConformance`, `quickjsEvaluator`, and
      `processEvaluator`. Needs phase 3. (CP5)

**Evidence:** both evaluators pass `evaluatorConformance` on Node 26.
`quickjsEvaluator` passes on Node 22.19. `processEvaluator` refuses Node
22 at construction.

### Phase 5. Live evidence and release

- [x] **1.** The live cases and the token comparison. Needs phase 4.
      (CP6)
- [x] **2.** The pages, the changelog, and the status of the design.
      Done before 1, because 1 waits for a person to approve the spend.
      (CP7)

**Evidence:** the live evidence file records acceptance items 1, 6, and
7, and the token comparison, on Pi, Claude, and Codex.

## The items

**CS1. A late steer on Claude keeps its answer.** A line that lands while
a Claude seat streams its final answer runs as a separate turn after the
first `result`, which reports `queued_turn_count: 0`. The executor parks
that result behind `ECHO_GRACE` (5 seconds). The echo arrives with the
request of the next turn and calls `read`, but it does not restart the
timer. The pass settles on the first result, and `close` stops the turn
that answers the line. The fix: an echo that arrives while a result waits
on the grace timer cancels the timer, and the pass settles on the result
of the next turn. The code is in `answered`, `settleWith`, and `echoed` of
`packages/claude/src/executor.ts`.

**Evidence:** the fake executable
(`packages/claude/test/fake/claude-executable.mjs`) gains a mode that
echoes a held message with the next request after the `result`. A test in
`packages/claude/test/steer-echo.test.ts` steers during the final text,
with a second turn longer than `ECHO_GRACE`, and the say of that turn
commits after the line. The live steer test gains one final-answer case
that runs only when a person asks for release evidence.

**CC1. The Camera Chat fixes.** An adversarial review of
`examples/camera-chat` (merged in #393) left six small findings open.

1. `README.md` says that the seat never bills an API account. That is
   false when `codex login --api-key` wrote `auth.json`. State that the
   login in `auth.json` decides billing.
2. `disconnect` in `packages/workspace/src/sensor-connections.ts` marks a
   link whose process ended as `disconnected`. Make it a no-op on an
   unavailable link.
3. The instruction in `src/host.ts` to ensure `fps=5` and commit any edits
   invites an edit and a push on every connect, and the template already
   sets `fps=5`. Delete the instruction.
4. A `refreshed` event clears the preview in `src/preview.ts` for one
   poll, so the preview flickers on a reconnect. Keep the frame on
   `refreshed` for the same sensor.
5. `src/preview.ts` downloads a frame again when the digest is unchanged.
   Skip the download.
6. `templates/camera/camera.ts` fixes the input at 30 frames per second.
   Add `--framerate`. State the CPU cost, the frame size, and the 24 hour
   timeout of `bash` in the READMEs.

**Evidence:** findings 2, 4, and 5 have a test where the code has tests.
The README states the billing rule, the costs, and the timeout.

**CX1. Codex on a ChatGPT sign-in.** The 0.5.0 release run on the owner's
Mac passed the Codex visibility and mixed-room live files on the ChatGPT
login. The rest of the Codex live tier ran only on a key. The binary tier
runs no ChatGPT sign-in, and no test covers the token refresh
(`account/chatgptAuthTokens/refresh`). Run the full Codex live tier once
on the ChatGPT login of the owner's Mac. The run uses the subscription and
bills no API account. Fix what fails, and state in `docs/codex.md` what
the run covers.

**Evidence:** the full Codex live tier passes on the ChatGPT login, and
`docs/codex.md` names the run and what stays untested.

**W5. The sensor path validates once.** The sensor client
(`sensor-client.ts`) and the retention (`sensor-retention.ts`) both check
the schema and the digest of a response. The client owns the check. The
retention trusts a verified result.

**Evidence:** the path holds one schema check and one digest check. The
client tests for a bad digest and a malformed body still fail at the
client. The retention tests still refuse a missing file and a failed
write.

**CP1. The vocabulary.** Add `compose` to `AmbionTool`, `defineTool`,
`captureTool`, and `assertTool`, and capture its `output` schema. Give
`defineTool` its two overloads, and `ToolResult` its type parameter. Add
`ToolContext.composeCall`, and `parent` to the `tool_call` and
`tool_result` steps. `ToolContext` has no `record`. Add the `compose` option to the
executor options, and reserve the name in `appendTools`. Add
`packages/ambion/src/compose.ts` to the vocabulary layer of
`biome.jsonc`.

**Evidence:** `define` tests refuse a bad `compose` value and a user tool
named `compose`, and a capture keeps the `output` schema. A type test
holds the `@ts-expect-error` cases of
[Typing a declared output](../docs/compose.md#typing-a-declared-output).
`fromPiTool` and every existing `defineTool` caller compile unchanged.

**CP2. The trace.** The core records the steps of a nested call, and no
tool holds the step sink. `callId` and the record of unclaimed calls skip
a step with a `parent`. The scripted executor gives each tool call a
signal and the deadline of the view.

**Evidence:** a test records a nested `bash` step during a direct `bash`
call of the same batch, and the direct call keeps its own id. A nested
step closes an open text block. `settled(room)` waits for a scripted
tool call that reads its deadline.

**CP3. The `compose` tool.** `compose.ts` builds the catalog, the
guidance, the approval, the ledger, the limits, the nested context, the
output check, and the rendering of the result and the error. `tool-call.ts`
holds the one function that runs a tool call: it prepares and checks the
arguments, calls `invoke`, and records the two steps of a nested call.
`agentTools`, the scripted executor, and the nested calls of `compose` use
it, so a direct call on Claude, Codex, and the scripted executor gets the
full schema check. The hosting export `invokeTool` hands the step sink of
the activation to the `compose` tool. A test evaluator in `test/support`
runs the code as an `AsyncFunction`, and only tests import it.

**Evidence:** acceptance items 1, 2, 4, and 5 pass on the scripted Pi
stream and on the fake Claude executable. A room test reads the status
and the ledger from the rendered content. A unit test of `invoke` reads
the `ComposeResult`. `COMPOSE_GUIDANCE` joins the export snapshot. A
hand-built tool whose `invoke` checks nothing refuses bad arguments on a
direct call, and no tool sees a function on its context beside
`onUpdate`.

**CP4. The declared outputs.** `sql` gives `count`, the columns, the
preview rows, and the export or import facts. A blob is lowercase hex, and
a `bigint` is decimal text. `snapshot`, `bash`, `ps`, `wait`, and `fork`
declare their outputs. Each details type becomes `Static` of its schema.

**Evidence:** workspace tests read the declared output of each tool
through `compose`, and the runtime check passes. A type test pins that
`ShellOutputTruncation` stays assignable to its schema. The `sql` tests
assert `count` in place of `details.rows`.

**CP-M. Skill macros.** A skill stores a compose program that the model
runs by name. `loadSkills` parses
`macros/*.js`, and the bundle carries each macro. `describeExecutor`
checks them. `compose` lists the macros, approves them, and runs them as
`{ macro, args }`. `sql` gains bind `params`. The same commit updates
[Compose](../docs/compose.md), [Skills](../docs/skills.md),
`COMPOSE_GUIDANCE`, and the export snapshot.

**Evidence:** a skill macro runs on the scripted executor over a real
workspace and a real SQLite file. A load or a definition refuses a bad
header, a bad `uses`, a bad `args` schema, and a duplicate name. An edit
of `~/.skills` does not change the body that runs. A seat without
`compose` takes the same skill set and lists no macro.

**CP5. The evaluators.** `@ambionframework/ambion/conformance` exports
`evaluatorConformance`. `@ambionframework/compose/runtime` holds
`quickjsEvaluator`, on the synchronous QuickJS build, and
`processEvaluator`, with a bundled child entry that speaks JSON lines over
stdio. `scripts/import-rules.test.mjs` gains the cases of the new package.

**Evidence:** the suite covers the globals table, a memory limit, a cut,
concurrent binding calls, errors with `details`, and JSON at each
crossing. `quickjsEvaluator` disposes every handle, so a runtime frees
clean. `processEvaluator` kills its child at the signal, and a relative
import in the child fails.

**CP6. Live evidence.** Run acceptance items 1, 6, and 7 once on each
family, and the token comparison of one task with and without `compose`,
the catalog included. One more case: a seat with a skill that names a
macro runs it by name, and the comparison counts the output tokens of free
code against the macro. A run costs money, so it runs when a person asks
for release evidence.

**Evidence:** [the compose evidence](#the-compose-evidence) records each
run: the model, the tools that the seat chose, the input tokens, and the
outcome. A family with no key is marked skipped.

**Result:** [the first run](#the-first-run) holds one run on each of Pi,
Claude, and Codex. Item 1 and item 6 passed on each kind. Item
7 passed its read case and failed its chain case on each kind: no seat
called `compose` for a chain. The token comparison therefore measures the
catalog only, and the run with `compose` cost more input tokens. The macro
case passed on Claude and Codex. On Pi the seat ran the macro and also
wrote code.

**Second run of the chain case:** after that run, `COMPOSE_GUIDANCE`
makes compose the default for a plan of two or more tool calls, and gives
an example. The chain case then ran once on each kind:

| Kind   | Model           | Effort | Tools                                | Input tokens | Outcome |
| ------ | --------------- | ------ | ------------------------------------ | ------------ | ------- |
| Codex  | gpt-5.6-luna    | medium | sql, compose, say                    | 28180        | passed  |
| Codex  | gpt-5.6-luna    | high   | compose, bash, sql (3), compose, say | 58954        | passed  |
| Pi     | claude-sonnet-5 | -      | sql, snapshot, say                   | 44613        | failed  |
| Claude | claude-sonnet-5 | -      | sql (2), snapshot, say               | 50553        | failed  |
| Pi     | claude-opus-5-5 | -      | sql, compose, say                    | 45322        | passed  |

The guidance steers `gpt-5.6-luna` and `claude-opus-5-5`. It does not
steer `claude-sonnet-5`. One more run gave the main rule in the
description of `compose` too, and `claude-sonnet-5` still called the
tools directly, so the description keeps its text.

**Third run: the chain case and the fan-out case.** A run with
`AMBION_THINKING` unset ran the chain case, the token comparison, and the
fan-out case once on each kind.
[The third run](#the-third-run) holds each run. In the
fan-out case, the seat reads the log of each drift run, finds the peak, and
snapshots four logs.

| Kind   | Chain                | Fan-out with compose                            | Fan-out without compose     |
| ------ | -------------------- | ----------------------------------------------- | --------------------------- |
| Pi     | passed, compose      | passed, compose of 32 bash calls, 180508 / 2495 | passed, bash, 105117 / 1965 |
| Claude | failed, direct calls | passed, compose of one bash call, 99276 / 1928  | passed, bash, 61823 / 1324  |
| Codex  | passed, compose      | failed, compose then bash, 238616 / 1037        | failed, bash, 305275 / 2209 |

Each fan-out cell gives the outcome, the approach, and the input and
output tokens. On Pi and Claude, the seat with `compose` cost more input
tokens than the seat without it. The seat with `compose` also made many
direct calls of `bash` and `sql` before it composed. Both Codex seats
counted 10 runs: they omitted the drift label and counted each log with a
peak over 900. The lab holds 4 drift runs with a peak over 900. The chain
case on Claude chose direct calls again. On Pi it passed, so the choice of
`claude-sonnet-5` changes from run to run.

**CP7. Release documentation.** Update the pages that the compose change
touches, the changelog, and the package count. Each page states its own
facts, so [Compose](../docs/compose.md) holds no list of changes. Change
the status of Compose from a proposed design to the current contract, with
the live token comparison of CP6 as its one pending item.

**Evidence:** the docs checks pass, and no page describes a surface that
the release does not export.

## The compose evidence

**Each table holds the runs of
`packages/workspace/test/live/compose.test.ts`.**
`scripts/compose-evidence.mjs` writes the tables from the JSON lines of a
run. The tools column lists the direct calls of the seat, and the nested
calls follow. `×3` counts three calls in a row of one tool. Input tokens
count the prompt, the cache read, and the cache write. The table of the
second run is in CP6.

### The first run

#### pi

| Model                     | Case                             | Tools                                                                                | Input tokens | Output tokens | Wall time | Outcome                                                                                |
| ------------------------- | -------------------------------- | ------------------------------------------------------------------------------------ | ------------ | ------------- | --------- | -------------------------------------------------------------------------------------- |
| anthropic/claude-sonnet-5 | chain                            | sql, snapshot, say                                                                   | 43729        | 851           | -         | failed: expected [ 'sql', 'snapshot', 'say' ] to include 'compose'                     |
| anthropic/claude-sonnet-5 | read before deciding             | sql, say                                                                             | 31723        | 193           | -         | passed (chose direct calls)                                                            |
| anthropic/claude-sonnet-5 | parallel processes               | compose ×2, say (nested: bash ×3, wait ×3, read ×3)                                  | 40148        | 830           | 3.1 s     | passed                                                                                 |
| anthropic/claude-sonnet-5 | token comparison with compose    | sql ×2, snapshot, say                                                                | 55016        | 934           | -         | passed                                                                                 |
| anthropic/claude-sonnet-5 | token comparison without compose | sql ×3, snapshot, say                                                                | 45861        | 1028          | -         | passed                                                                                 |
| anthropic/claude-sonnet-5 | macro                            | compose ×2, read, compose ×2, bash ×3, read, compose ×2, say (nested: sql, snapshot) | 154377       | 1642          | 0.0 s     | failed: expected false to be true // Object.is equality (free code: 934 output tokens) |

#### claude

| Model                     | Case                             | Tools                                                         | Input tokens | Output tokens | Wall time | Outcome                                                             |
| ------------------------- | -------------------------------- | ------------------------------------------------------------- | ------------ | ------------- | --------- | ------------------------------------------------------------------- |
| anthropic/claude-sonnet-5 | chain                            | sql ×3, snapshot, say                                         | 59317        | 749           | -         | failed: expected [ 'sql', 'sql', 'sql', …(2) ] to include 'compose' |
| anthropic/claude-sonnet-5 | read before deciding             | sql, say                                                      | 28409        | 195           | -         | passed (chose direct calls)                                         |
| anthropic/claude-sonnet-5 | parallel processes               | compose ×2, wait ×2, say (nested: bash ×3, wait ×61, bash ×3) | 70070        | 1480          | 3.3 s     | passed                                                              |
| anthropic/claude-sonnet-5 | token comparison with compose    | sql ×4, snapshot, say                                         | 60065        | 828           | -         | passed                                                              |
| anthropic/claude-sonnet-5 | token comparison without compose | sql, snapshot, say                                            | 33964        | 627           | -         | passed                                                              |
| anthropic/claude-sonnet-5 | macro                            | compose ×2, say (nested: sql, snapshot)                       | 40245        | 592           | 0.0 s     | passed (free code: 828 output tokens)                               |

#### codex

| Model        | Case                             | Tools                                               | Input tokens | Output tokens | Wall time | Outcome                                                              |
| ------------ | -------------------------------- | --------------------------------------------------- | ------------ | ------------- | --------- | -------------------------------------------------------------------- |
| gpt-5.6-luna | chain                            | bash, sql ×2, snapshot, say                         | 41872        | 488           | -         | failed: expected [ 'bash', 'sql', 'sql', …(2) ] to include 'compose' |
| gpt-5.6-luna | read before deciding             | sql, say                                            | 20000        | 102           | -         | passed (chose direct calls)                                          |
| gpt-5.6-luna | parallel processes               | compose ×2, say (nested: bash ×3, wait ×3, read ×3) | 25601        | 554           | 3.1 s     | passed                                                               |
| gpt-5.6-luna | token comparison with compose    | sql ×2, snapshot, say                               | 34575        | 439           | -         | passed                                                               |
| gpt-5.6-luna | token comparison without compose | sql ×2, snapshot, say                               | 23767        | 442           | -         | passed                                                               |
| gpt-5.6-luna | macro                            | compose ×2, say (nested: sql, snapshot)             | 28202        | 367           | 0.0 s     | passed (free code: 439 output tokens)                                |

### The third run

The model column holds the reasoning level in parentheses.

#### pi

| Model                           | Case                             | Tools                                                                                               | Input tokens | Output tokens | Wall time | Outcome          |
| ------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------- | ------------ | ------------- | --------- | ---------------- |
| anthropic/claude-sonnet-5 (off) | chain                            | compose ×2, say (nested: sql ×2, snapshot)                                                          | 45119        | 762           | 0.0 s     | passed           |
| anthropic/claude-sonnet-5 (off) | token comparison with compose    | sql, snapshot, say                                                                                  | 44290        | 568           | -         | passed           |
| anthropic/claude-sonnet-5 (off) | token comparison without compose | sql ×2, snapshot, say                                                                               | 38354        | 937           | -         | passed           |
| anthropic/claude-sonnet-5 (off) | fan-out with compose             | bash ×3, sql ×2, compose, bash, compose, bash, snapshot, say (nested: sql, bash ×16, sql, bash ×16) | 180508       | 2495          | 0.3 s     | passed (compose) |
| anthropic/claude-sonnet-5 (off) | fan-out without compose          | bash ×4, sql ×3, bash, snapshot, say                                                                | 105117       | 1965          | -         | passed (bash)    |

#### claude

| Model                               | Case                             | Tools                                                     | Input tokens | Output tokens | Wall time | Outcome                                                            |
| ----------------------------------- | -------------------------------- | --------------------------------------------------------- | ------------ | ------------- | --------- | ------------------------------------------------------------------ |
| anthropic/claude-sonnet-5 (default) | chain                            | sql, snapshot, say                                        | 40103        | 624           | -         | failed: expected [ 'sql', 'snapshot', 'say' ] to include 'compose' |
| anthropic/claude-sonnet-5 (default) | token comparison with compose    | sql ×3, snapshot, say                                     | 60573        | 746           | -         | passed                                                             |
| anthropic/claude-sonnet-5 (default) | token comparison without compose | sql ×4, snapshot, say                                     | 52116        | 825           | -         | passed                                                             |
| anthropic/claude-sonnet-5 (default) | fan-out with compose             | bash, sql ×3, compose, read, snapshot, say (nested: bash) | 99276        | 1928          | 0.1 s     | passed (compose)                                                   |
| anthropic/claude-sonnet-5 (default) | fan-out without compose          | bash, sql ×2, bash, sql, bash, snapshot, say              | 61823        | 1324          | -         | passed (bash)                                                      |

#### codex

| Model                 | Case                             | Tools                                                        | Input tokens | Output tokens | Wall time | Outcome                                                                                     |
| --------------------- | -------------------------------- | ------------------------------------------------------------ | ------------ | ------------- | --------- | ------------------------------------------------------------------------------------------- |
| gpt-5.6-luna (medium) | chain                            | sql, compose, say (nested: sql, snapshot)                    | 28159        | 411           | 0.0 s     | passed                                                                                      |
| gpt-5.6-luna (medium) | token comparison with compose    | compose ×2, say (nested: sql ×2, snapshot)                   | 28497        | 481           | 0.0 s     | passed                                                                                      |
| gpt-5.6-luna (medium) | token comparison without compose | sql ×2, snapshot, say                                        | 23771        | 450           | -         | passed                                                                                      |
| gpt-5.6-luna (medium) | fan-out with compose             | compose, bash ×5, sql ×2, bash, snapshot, say (nested: bash) | 238616       | 1037          | 0.1 s     | failed: expected 'Found 10 drift runs with peak_temp ov…' to match /\b4\b\|four/i (compose) |
| gpt-5.6-luna (medium) | fan-out without compose          | bash ×10, snapshot, say ×2                                   | 305275       | 2209          | -         | failed: expected 'Found 10 drift runs with peak_temp ov…' to match /\b4\b\|four/i (bash)    |
