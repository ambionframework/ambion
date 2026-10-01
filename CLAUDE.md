# Agent guide

Ambion is a collaboration kernel for agents and humans. A room is a shared
journal with rules for taking part. The kernel keeps the record and the
rules, and a restart loses nothing. [`README.md`](README.md) holds the
positioning and the current surface; no other page states it twice.

pnpm workspace, ESM only, TypeScript. Library packages need Node 22.19 or
newer. `examples/workbench` needs Node 26.4 or newer, the OpenTUI floor.
`AGENTS.md` is a symbolic link to `CLAUDE.md`. Edit `CLAUDE.md`.

## Packages

- `packages/ambion`: the runtime. One file per concern, in layers that Biome
  holds. `room.ts` composes them.
- `packages/journal`: the append-only journal. One queue, fenced by run, with
  conditional commits.
- `packages/assistant`: the default assistant definition. Membership guidance
  and closing summaries over the core.
- `packages/simulator`: evals. `simulate()` drives a room as a person and
  returns the run that checks read.
- `packages/pi`, `packages/claude`, `packages/codex`: the executors. Each
  exports `<name>()` and `<name>Execution()`. The kernel imports no model
  library. The `claude` tests run on a fake executable. The `codex` tests run
  the real binary on a scripted model, and its live tier runs a real model.
- `packages/cloudflare`: a room as Durable Objects, one for each room and one
  for each seat. Tests run in workerd.
- `packages/workspace`: the workspace resource and its tools, the helpers of
  a bash backend, an optional SQL backend interface, and git helpers in
  `/git`.
- `packages/just-bash`: `memoryBackend`, `directoryBackend`, and
  `justGitBackend` in `/git`.
- `packages/workstation`: a bash backend over SSH to one server, one Unix
  account for each agent, and `workstationGitBackend`.
- `examples/workbench`: rooms and an OpenTUI terminal in one process.
- `planning/`: `next.md` is the 0.5.0 scope and plan, `0.6.0.md` is the next
  release, `simplification.md` is the concepts that the repository holds twice,
  `backlog.md` is everything else.

## Read before you change

| Change                                  | Read first                                             |
| --------------------------------------- | ------------------------------------------------------ |
| The runtime                             | `docs/agent.md`, then `exchange`, `presence`, `roster` |
| The record under failure                | `docs/durability.md`, `docs/deployment.md`             |
| A `rules.verified.ts`                   | `docs/formal.md`                                       |
| The assistant or the `assistant` option | `docs/assistant.md`, `docs/summary.md`                 |
| The simulator                           | `docs/simulator.md`                                    |
| The workspace or its tools              | `docs/workspace.md`, then `skills`, `processes`, `git` |
| The workstation                         | `docs/workstation.md`, `docs/workstation-git.md`       |
| Sensors or actuators                    | `docs/sensors.md`, `docs/actuators.md`                 |
| A room open to untrusted agents         | `docs/trust.md`                                        |
| `.github/`, `scripts/`, a root config   | `docs/toolchain.md`                                    |
| The example                             | `docs/example.md`                                      |

[`docs/README.md`](docs/README.md) indexes every page.

## Commands

```sh
pnpm install
pnpm format             # Biome fixes, then Prettier writes
pnpm check              # the gate; run it, after pnpm format, before every push
pnpm check lint types   # only the named steps
pnpm --filter @ambionframework/<pkg> exec vitest run [file]   # one package or file
node --test scripts/<name>.test.mjs                            # one report check
pnpm rule:check <file>  # regenerate and prove one rules file; needs Dafny
pnpm check:lemmascript  # prove every rules and proofs file; needs Dafny
pnpm chaos              # the failure sweeps on both storages, 200 seeds
pnpm test:live          # a real model; costs money, see below
```

**`pnpm check` prints one line for each step that passes.** A failed step
prints its findings with paths from the repository root, then a `fix:` line.
The last line names the steps to run again. Every step runs, so one run
reports every failure. A failed build skips `types` and `test`.

**A failed step prints at most 60 lines.** The full output of each step is
in `.cache/check/<step>.log`.

| Step      | Checks                                                | Fix                               |
| --------- | ----------------------------------------------------- | --------------------------------- |
| `format`  | Prettier                                              | `pnpm format`                     |
| `lint`    | Biome, warnings as errors                             | `pnpm format:lint` for safe fixes |
| `knip`    | Unused files, exports, and dependencies               | Delete them, or record in knip    |
| `rules`   | Each `.dfy` equals its generation from the contracts  | `pnpm rule:check <file>`          |
| `reports` | `scripts/*.test.mjs`: docs, links, budgets, packaging | Read the assertion                |
| `build`   | tsdown, through turbo                                 | Read the error                    |
| `types`   | `tsc` in each package                                 | Read the error                    |
| `test`    | Vitest, the scripted tier of each package             | Run the one file again            |

Turbo and Vitest print only failures. Vitest picks its agent reporter when
it detects an agent.

### Live runs cost money

**Treat every live run as spend.** `pnpm test:live` and the live tier of
`pnpm chaos` bill a real provider account.

- **Run the smallest thing that answers the question.** Run one file:
  `pnpm --filter @ambionframework/ambion exec vitest run --config
vitest.live.config.ts test/live/<file>.test.ts`. Run the full live suite
  only when a person asks for release evidence.
- **Prove the code first without a provider.** Run the scripted tier and
  `pnpm check` before any live run.
- **Never repeat a live run to chase a flake.** Read the failure first. A
  credit or authentication message is a provider error.
- **Never commit a key.** Pass a key through the environment for one command.
  Write it to no file, workflow, or record.
- **CI runs the live tier on `main` and weekly.** Add no live run to a pull
  request workflow.

`AMBION_EXECUTOR=<pi|claude|codex>` selects the harness of the live seats.
`pi` reads `<PROVIDER>_API_KEY` for the provider of `AMBION_MODEL`
(`ANTHROPIC_API_KEY` by default). `claude` reads `ANTHROPIC_API_KEY`, and
`codex` reads `CODEX_API_KEY`.

## Product rules

- **No compatibility promise before 1.0.0.** Any release may change an
  export, a journal body, or a stored format. Add no re-export, deprecated
  alias, reader for an older format, or compatibility test. Update the export
  snapshot and the golden journals in the same commit, and name the change in
  the changelog. [`planning/next.md`](planning/next.md) holds the rule.
- **The sensor wire API carries a version number.** A breaking change raises
  `api`, and a client refuses a server at another `api`. A supplied server
  does not upgrade with the host. Reducer state belongs to the server. The
  workspace keeps observed evidence through existing snapshot refs. Measurement timestamps are the source of truth; host
  time governs host interactions.
- **A sensor definition starts as a Git template.** The agent forks,
  customizes, validates, commits, and pushes before it runs a saved version.
  Replacement and rollback use the Git and process tools.
- **Ambient means a room stays available between interactions.** A scheduled
  say brings an agent back on the room's clock. A host wakes a room with
  `room.post`.
- **`docs/` describe the implemented API.** Label a pending change
  explicitly. `planning/next.md` owns open work and its evidence.

## Code rules

- **Each concern has one owner.** Pi's AgentHarness
  (`@earendil-works/pi-agent-core`) owns the model loop, the session, and
  compaction. `packages/workspace` owns the workspace port, resource, tools,
  and backend helpers. `packages/just-bash` owns the just-bash filesystem and
  shell. The core composes ordinary tools. `packages/journal` owns the queue, the fence, and the entry
  envelope. A harness keeps its own session, best effort, for one exchange.
  Ambion owns only participants as values and the room. A third concern is a
  design failure: push it into a dependency or drop it.
- **Rendering and summary guidance stay pure and stateless.**
  `execution/render.ts` formats collaboration context for Pi. Summary
  guidance belongs to the seat executor; the room owns summary assignment and
  provenance. A message to a developer stays with the mechanism that sends it.
- **Imports point down the layers** (`docs/toolchain.md` §1). Biome refuses
  the rest. Put a new file in the layer that reaches what it needs, never
  above `room.ts`.
- No `any`, no non-null assertions, no unused imports or variables.
- `packages/ambion/src` writes nothing to stdout. A host passes a logger in.
- **A pure rule of the journal or the room lives in the layer's
  `*.verified.ts`**, with `//@ requires` and `//@ ensures` contracts, and the
  caller runs its body. Run `pnpm rule:check <file>` after every edit.
  `pnpm check` fails on a stale generation and on an exported rule with no
  binding case. A hand-written proof goes in the `.proofs.dfy` beside the
  rules.
  [`docs/formal.md`](docs/formal.md) holds the mechanism;
  [`planning/backlog.md`](planning/backlog.md) holds the open proofs.
- Cognitive complexity: max 10 in source, 15 in tests.
- Prettier formats (tabs, single quotes, width 100, semicolons). Biome lints.

## Tests

- **Run the real thing.** A test starts a real room over a real journal, a
  real filesystem, or a real SQLite file. The scripted model stream is the
  one standard stand-in for the provider.
- **Mock only what a test cannot run.** Use `vi.mock` and `vi.spyOn` for a
  dependency that needs a network or a key, and for a binding case. To record
  calls, pass a plain function that pushes to an array.
- **One path, one test.** Add an assertion to the test that already runs the
  path. Delete a test that asserts nothing new.
- **A table for cases that differ only in data.** Use `it.each` or
  `describe.each` with one body.
- **Shared setup lives in `test/support`.** In the core, `scriptedAgent(name)`
  defines a seat on the scripted model, and `stopAtEnd(room)` stops a room at
  the end of a test. Use them in place of a local `defineAgent` and a
  `try`/`finally`.
- **The scripted executor makes a room deterministic.** It comes from
  `@ambionframework/ambion/testing`; `settled(room)` waits for the room. A
  scripted Pi stream comes from `@ambionframework/pi/testing`.
- **Coverage holds when tests shrink.** Before and after a change that merges
  or deletes tests, run `pnpm exec vitest run --coverage.enabled
--coverage.reporter=json` in the package. Compare the two
  `coverage/coverage-final.json` files.

## Writing

Write documentation, code comments, and commit messages in **ASD-STE100
Simplified Technical English**: one meaning per word, one instruction per
sentence. `README.md` and `docs/` follow these rules.

1. **Active voice.** "The room stamps provenance".
2. **Short sentences.** Max 20 words for an instruction, 25 for a
   description.
3. **One topic per paragraph**, max 6 sentences and under six lines.
4. **One word, one meaning.** An **activation** is the room waking one seat.
   An **exchange** is a person's question and every activation until the
   room goes quiet. What the journal holds is an **entry**. `turn` belongs to
   Pi (one request to a provider). `row` belongs to SQL. `round` belongs to
   nobody. An activation is never a `trigger`, a `call`, or a `wake`.
5. **Simple tenses.** Present for how things work, imperative for
   instructions.
6. **Keep articles and relative pronouns.** "The agent that waits".
7. **No noun clusters over three words.** Break them with prepositions.
8. **No slang, no metaphor, no ellipsis.** State the mechanism.
9. **State facts.** Say plainly that a command or feature does not exist yet.

**Shape a page for a reader who scans.** A bold lead names each point, and
the bold leads alone carry the page's claims. An enumeration is a list.
Tabular facts are a table. A Mermaid diagram is welcome when it shows the
mechanism. Wrap Markdown prose at about 78 columns.

**Voice.** Give the mechanism once, then the next mechanism. Do not educate,
persuade, or lecture. The reader has built an agent and has not met the
scaling problems of this project: ground a claim in what they have lived,
then extend it. Keep the field's vocabulary.

- Banned words: "load-bearing", "seam".
- No contrastive framing as a device: "X, not Y", "X rather than Y", "X
  instead of Y", "X — never Y". A plain negative fact is fine ("A human has
  no tools").
- One statement per point. Do not restate it.

## Git

Develop on a feature branch. Push with `git push -u origin <branch>`. Open a
pull request only when a person asks.
