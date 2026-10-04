# Compose evidence

**This page holds the live runs of `compose` for 0.6.0.** The runs check
acceptance items 1, 6, and 7 of [Compose](compose.md#acceptance) on Pi,
Claude, and Codex, and compare the tokens of one task with and without
`compose`. A run costs money, so it runs when a person asks for release
evidence.

## The result

**The first run checked each kind once.** [The first run](#the-first-run)
holds one run on each of Pi, Claude, and Codex. Item 1 and item 6 passed
on each kind. Item 7 passed its read case and failed its chain case on each kind: no seat
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

**Fourth run: the subscription login.** On 2026-10-03, on `e6d34c6f`, the
live test ran once on each kind with no API key. Codex used the ChatGPT
login of the host, `gpt-5.6-luna` at medium effort. Pi used
`AMBION_MODEL=openai-codex/gpt-5.6-luna` with thinking off, on the stored
`openai-codex` sign-in. The flags were `--retry=0` and
`--testTimeout=300000`. Claude has no login path, so the run skipped it.
[The fourth run](#the-fourth-run) holds each run.

Codex passed 6 of 6 cases. Pi passed 5 of 6. The Pi chain case failed:
the seat called `compose` for one `sql` query and took the snapshots with
direct calls. The model made that choice. The case checks the nested
calls before the answer, so the run did not check the answer.

- **Seats with `compose` said from inside `compose` in 3 of 6 cases on
  each kind.** On Codex, those cases are read before deciding, parallel
  processes, and fan-out. On Pi, they are parallel processes, the token
  comparison, and fan-out. The other cases used a direct `say`.
- **The fan-out prompt names the table `runs`.** All four seats found the
  4 hot runs. In the third run, the prompts did not name the table, and
  both Codex seats counted 10 runs.
- **Fan-out input tokens:** Codex used 105477 with `compose` and 40794
  without. Pi used 89510 with `compose` and 206748 without. One run does
  not support a general conclusion.
- **The token counts do not compare with the earlier tables.** The prompts
  name the table now.

Two earlier runs used the same login, with the login support of #525
before it merged. On `a439aef4` (before #522), Codex passed 4 of 6 cases
and Pi passed 5 of 6. On `1f5e6df1` (after #522), Codex passed 5 of 6 and
Pi passed 4 of 6.

## The runs

**Each table holds the runs of
`packages/workspace/test/live/compose.test.ts`.**
`scripts/compose-evidence.mjs` writes the tables from the JSON lines of a
run. The tools column lists the direct calls of the seat, and the nested
calls follow. `×3` counts three calls in a row of one tool. Input tokens
count the prompt, the cache read, and the cache write. The table of the
second run is under [The result](#the-result).

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

### The fourth run

The model column holds the reasoning level in parentheses.

#### pi

| Model                           | Case                             | Tools                                                        | Input tokens | Output tokens | Wall time | Outcome                                          |
| ------------------------------- | -------------------------------- | ------------------------------------------------------------ | ------------ | ------------- | --------- | ------------------------------------------------ |
| openai-codex/gpt-5.6-luna (off) | chain                            | sql, bash, compose, read ×2, snapshot ×2, say (nested: sql)  | 50506        | 491           | 0.0 s     | failed: expected [ 'sql' ] to include 'snapshot' |
| openai-codex/gpt-5.6-luna (off) | read before deciding             | sql, say                                                     | 24159        | 89            | -         | passed (chose direct calls)                      |
| openai-codex/gpt-5.6-luna (off) | parallel processes               | compose (nested: bash ×3, wait ×3, say)                      | 14474        | 167           | 3.1 s     | passed                                           |
| openai-codex/gpt-5.6-luna (off) | token comparison with compose    | compose ×3 (nested: sql ×3, snapshot, say)                   | 32819        | 208           | 0.0 s     | passed                                           |
| openai-codex/gpt-5.6-luna (off) | token comparison without compose | sql ×4, read ×4, snapshot ×4, say                            | 33145        | 792           | -         | passed                                           |
| openai-codex/gpt-5.6-luna (off) | macro                            | compose, say (nested: sql, snapshot)                         | 25341        | 283           | 0.0 s     | passed                                           |
| openai-codex/gpt-5.6-luna (off) | fan-out with compose             | sql, bash, compose ×2 (nested: sql, read ×16, snapshot, say) | 89510        | 369           | 0.1 s     | passed (compose)                                 |
| openai-codex/gpt-5.6-luna (off) | fan-out without compose          | sql ×3, bash ×5, snapshot, say                               | 206748       | 785           | -         | passed (bash)                                    |

#### claude

Skipped. The run had no key for this executor kind.

#### codex

| Model                 | Case                             | Tools                                                   | Input tokens | Output tokens | Wall time | Outcome                |
| --------------------- | -------------------------------- | ------------------------------------------------------- | ------------ | ------------- | --------- | ---------------------- |
| gpt-5.6-luna (medium) | chain                            | compose, say (nested: sql, snapshot)                    | 25491        | 370           | 0.1 s     | passed                 |
| gpt-5.6-luna (medium) | read before deciding             | compose (nested: sql, say)                              | 16565        | 194           | 0.0 s     | passed (chose compose) |
| gpt-5.6-luna (medium) | parallel processes               | compose (nested: bash ×3, wait ×3, say)                 | 15006        | 339           | 3.2 s     | passed                 |
| gpt-5.6-luna (medium) | token comparison with compose    | compose, say (nested: sql, snapshot)                    | 25560        | 383           | 0.1 s     | passed                 |
| gpt-5.6-luna (medium) | token comparison without compose | sql, snapshot, say                                      | 19264        | 398           | -         | passed                 |
| gpt-5.6-luna (medium) | macro                            | compose, say (nested: sql, snapshot)                    | 26079        | 371           | 0.0 s     | passed                 |
| gpt-5.6-luna (medium) | fan-out with compose             | compose ×4 (nested: sql, read ×16, bash, snapshot, say) | 105477       | 575           | 0.0 s     | passed (compose)       |
| gpt-5.6-luna (medium) | fan-out without compose          | sql ×2, bash ×2, snapshot, say                          | 40794        | 602           | -         | passed (bash)          |
