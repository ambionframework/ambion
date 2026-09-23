# CLAUDE.md

Guidance for Claude Code in this repository.

## Project

Ambion is a collaboration kernel for agents and humans. A room is a shared
journal with rules for taking part. People ask questions and read results.
Agents speak when they have something to add and stay silent when they do
not. The kernel keeps the record and the rules. A restart loses nothing.

pnpm workspace, ESM only, TypeScript. Every library package needs Node
22.19 or newer. `examples/workbench` needs Node 26.4 or newer, the OpenTUI
floor.

| Path                   | What                                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/ambion`      | The runtime. One file per concern, in layers Biome holds; `room.ts` composes them                                                            |
| `packages/assistant`   | The default assistant definition: membership guidance and closing summaries over the core                                                    |
| `packages/cloudflare`  | A room as Durable Objects: one object per room, one per seat. Publishable; tested in workerd                                                 |
| `packages/journal`     | An append-only journal: one queue, fenced by run, with conditional commits                                                                   |
| `packages/pi`          | The Pi executor: `pi()`, `piExecution()`, and the seat transcript audit; the kernel imports no model library                                 |
| `packages/claude`      | The Claude Agent SDK executor: `claude()` and `claudeExecution()`, tested on a fake executable                                               |
| `packages/codex`       | The Codex SDK executor: `codex()` and `codexExecution()`, over a stdio room tools server; live-tested, no fake                               |
| `packages/pi-journal`  | Full Pi transcript sessions over the generic journal storage contract                                                                        |
| `packages/workspace`   | A workspace resource and its tools, over an in-memory or directory filesystem, and the interface of an optional SQL backend                  |
| `packages/workstation` | A workspace bash backend over SSH: one remote server, one Unix account for each agent. Tested on an in-process server and on OpenSSH in CI   |
| `docs/trust.md`        | Design contract for what one owner guarantees another, and what the kernel does not defend — read before exposing a room to untrusted agents |
| `docs/agent.md`        | Design contract for the core — read before changing the runtime                                                                              |
| `docs/assistant.md`    | Design contract for the default assistant package and the `assistant` room option — read with `agent.md`                                     |
| `docs/exchange.md`     | Design contract for the exchange, the room's unit of work — read with `agent.md`                                                             |
| `docs/presence.md`     | Design contract for presence and visits — read with `agent.md`                                                                               |
| `docs/summary.md`      | Design contract for optional summaries of closed exchanges                                                                                   |
| `docs/workspace.md`    | Design contract for the workspace an agent's tools reach into — read with `agent.md`                                                         |
| `docs/workstation.md`  | Design contract for the workspace backend over SSH to one remote server, one Unix account for each agent — read with `workspace.md`          |
| `docs/example.md`      | The one runnable example, an agentic lab workspace, and what it must show                                                                    |
| `docs/roster.md`       | Design contract for a roster that changes while the room runs — read with `agent.md`                                                         |
| `docs/durability.md`   | What the record promises under failure, and how the tiers prove it — read with `agent.md`                                                    |
| `docs/deployment.md`   | Host placement, storage, reconnect, and the recovery evidence — read with `durability.md`                                                    |
| `docs/formal.md`       | The verified rules, their proofs, and the gate — read before changing a `rules.verified.ts`                                                  |
| `docs/toolchain.md`    | Build, CI, release — read before changing `.github/`, `scripts/`, root configs                                                               |
| `examples/workbench`   | Runnable example: rooms and an OpenTUI terminal in one process                                                                               |
| `planning/`            | `next.md`: the scope and plan for 0.2.0; `backlog.md`: everything after, with the proofs still open                                          |

## Positioning

**`README.md` holds the positioning.** It states what Ambion is, the key
technical facts, and what is new, and it describes the current surface. Every
other page links to it and states nothing twice. `planning/next.md` names
which parts of that surface are still open.

There is no compatibility promise before 1.0.0. Any release may change an
export, a journal body, or a stored format. Add no re-export, deprecated
alias, reader for an older format, or compatibility test. Update the export
snapshot and the golden journals in the same commit, and name the change in
the changelog. The note at the top of [`planning/next.md`](planning/next.md)
holds the rule.

Ambient means a room remains available between interactions. Native timers,
external event subscriptions, and scheduler ingress remain future work.

[`planning/next.md`](planning/next.md) defines the 0.2.0 scope and owns the
work and its evidence. [`planning/backlog.md`](planning/backlog.md) holds
everything after 0.2.0. `docs/` document current capabilities and label
pending release changes explicitly. Keep the examples in `docs/` on the
implemented API until the corresponding change lands.

## Commands

```sh
pnpm install
pnpm check     # format, build, typecheck, lint, test — the gate CI runs
pnpm format    # biome --write, then prettier --write
pnpm test:live # the room on a real model; needs <PROVIDER>_API_KEY and costs money
AMBION_HARNESS=<pi|claude|codex> pnpm test:live # one harness; claude needs ANTHROPIC_API_KEY, codex needs CODEX_API_KEY
pnpm chaos     # the sweeps on both storages, the handover at every write, the kill at every third write, 200 seeds of the walk and the history
pnpm check:lemmascript # prove every *.verified.ts and *.proofs.dfy with Dafny; CI runs it, a contributor needs Dafny on PATH
pnpm rule:check <file> # regenerate and prove one rules file after an edit
```

Run `pnpm format` and `pnpm check` before every push. CI runs the same gate.

### Live runs cost money

**Treat every live run as spend.** `pnpm test:live` and `pnpm chaos` on the
live tier call a real provider and bill a real account. Be conservative and
thoughtful.

- **Run the smallest thing that answers the question.** Prefer one test file or
  one case (`pnpm --filter @ambionframework/ambion exec vitest run --config
vitest.live.config.ts test/live/<file>.test.ts`) over the whole suite. Run the
  full live suite only when a person asks for release evidence.
- **Prove the code first without a provider.** Run the scripted tier and
  `pnpm check` before any live run. A live run confirms the real-model path, not
  basic correctness.
- **Never repeat a live run to chase a flake.** Read the failure first. A
  provider error (a credit or authentication message) is not a code defect.
- **Never commit a key.** Pass a provider key through the environment for one
  command. Do not write it to a file, a workflow, or the record.
- **CI runs the live tier on `main` and on a weekly schedule, not on a pull
  request.** Do not add a live run to a pull request workflow.

## Code rules

- Pi (`@earendil-works/pi-agent-core`) owns the model loop, tools, transcript.
  `packages/workspace` owns the workspace port, resource, tools, and the
  just-bash filesystem and shell behind them. The core composes ordinary tools.
  `packages/journal` owns the journal: the queue, the fence and the envelope
  every entry shares. `packages/pi-journal` owns Pi session persistence over
  that storage contract. Ambion owns only participants-as-values and
  the room. A third concern is a
  design failure: push it into a dependency or drop it. `execution/render.ts` formats
  structured collaboration context for Pi. Summary guidance belongs with the
  seat executor; the room owns summary assignment and provenance.
  Both stay pure and stateless. What the room says to a developer stays with
  the mechanism that says it.
- The core is laid out in layers (`docs/toolchain.md` §1), and an import
  points down only. Biome refuses the rest; a new file goes in the layer
  that may reach what it needs, and never above `room.ts`.
- No `any`, no non-null assertions, no unused imports or variables.
- `packages/ambion/src` must not write to stdout. Hosts pass a logger in.
- A pure rule the journal or the room decides by lives in the layer's
  `*.verified.ts` file, with `//@ requires` and `//@ ensures` contracts,
  and the caller runs its body. After every edit run `pnpm rule:check
<file>`; `pnpm check` fails on a stale generation and on an exported
  rule with no binding case. A hand-written proof goes in the
  `.proofs.dfy` beside the rules. [`docs/formal.md`](docs/formal.md)
  holds the mechanism and the envelope a rule must stay inside;
  [`planning/backlog.md`](planning/backlog.md) holds the proofs still
  open.
- Cognitive complexity: max 10 in source, 15 in tests.
- Prettier formats (tabs, single quotes, width 100, semicolons); Biome lints.
- Tests are vitest. A scripted execution from `@ambionframework/ambion/testing`
  makes a room deterministic; `settled(room)` waits for it. The kernel entry
  imports no model library. A scripted Pi stream comes from
  `@ambionframework/pi/testing`.

## Writing documentation

Write all documentation, code comments, and commit messages in **ASD-STE100
Simplified Technical English**. It is the controlled-language standard for
technical writing: one meaning per word, one instruction per sentence.

Rules that carry the most weight here:

1. **Active voice.** "The room stamps provenance", not "provenance is
   stamped".
2. **Short sentences.** Max 20 words for an instruction, 25 for a description.
3. **One topic per paragraph**, max 6 sentences.
4. **One word, one meaning.** Pick a term and keep it. An activation is always
   an activation, never a trigger, a call, a wake — or a turn. The room has two
   spans and two words: an **activation** is the room waking one seat, an
   **exchange** is a person's question and every activation until the room goes
   quiet. `turn` belongs to Pi, where it means one request to a provider, and
   `round` belongs to nobody. What the journal holds is an **entry**. `row`
   belongs to SQL, so use it only about a database table.
5. **Simple tenses.** Present for how things work, imperative for instructions.
6. **Keep articles and relative pronouns.** "The agent that waits", not "agent
   waits".
7. **No noun clusters over three words.** Break them with prepositions.
8. **No slang, no metaphor, no ellipsis.** State the mechanism.

Also: state facts, not claims. If a command or feature does not exist yet, say
so plainly. Wrap Markdown prose at about 78 columns; Prettier preserves it.

Optimize every page for a human scanning it:

- A bold lead names each point. A reader of only the bold leads gets the
  page's claims.
- An enumeration is a bulleted or numbered list. Tabular facts are a table.
- A paragraph stays under six lines of prose. Split at the natural break.
- A diagram is welcome when it shows the mechanism. GitHub renders Mermaid.

### Voice

Write to get the job done. Do not educate, persuade, or lecture along the way.
The reader wants the mechanism, once, and then the next mechanism.

The reader has built an agent and has not yet met the scaling problems this
project tackles. Ground a claim in what they have lived, then extrapolate to
the scale they have not. Keep the field's vocabulary; do not flatten it to
plain English.

- Banned words: "load-bearing", "seam".
- No contrastive framing as a rhetorical device: avoid "X, not Y",
  "X rather than Y", "X instead of Y", "X — never Y". Say what a thing is or
  does. A plain negative fact is fine when the reader needs it ("A human has
  no tools").
- Do not restate a point in a second formulation. One statement per point.

`README.md` and `docs/` follow these rules. Hold every edit to the same
standard.

## Git

- Develop on a feature branch; push with `git push -u origin <branch>`.
- Do not open a pull request unless asked.
