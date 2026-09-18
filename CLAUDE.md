# CLAUDE.md

Guidance for Claude Code in this repository.

## Project

Ambion is a collaboration kernel for agents and humans. A room is a shared
journal with rules for taking part. People ask questions and read results.
Agents speak when they have something to add and stay silent when they do
not. The kernel keeps the record and the rules. A restart loses nothing.

pnpm workspace, ESM only, TypeScript. Repository installation needs Node
26.4 or newer for OpenTUI. The core runtime supports Node >= 22.19.

| Path                  | What                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `packages/ambion`     | The runtime. One file per concern, in layers Biome holds; `room.ts` composes them                |
| `packages/cli`        | Project creation and local rooms through Wrangler and OpenTUI; ships with the Cloudflare adapter |
| `packages/cloudflare` | A room as Durable Objects: one object per room, one per seat. Publishable; tested in workerd     |
| `packages/journal`    | An append-only journal: one queue, fenced by run, with conditional commits                       |
| `packages/pi-journal` | Full Pi transcript sessions over the generic journal storage contract                            |
| `packages/workspace`  | A workspace resource and its tools, over an in-memory or directory filesystem                    |
| `docs/agent.md`       | Design contract for the core — read before changing the runtime                                  |
| `docs/exchange.md`    | Design contract for the exchange, the room's unit of work — read with `agent.md`                 |
| `docs/presence.md`    | Design contract for presence and visits — read with `agent.md`                                   |
| `docs/summary.md`     | Design contract for optional summaries of closed exchanges                                       |
| `docs/workspace.md`   | Design contract for the workspace an agent's tools reach into — read with `agent.md`             |
| `docs/example.md`     | The one runnable example, an agentic lab workspace, and what it must show                        |
| `docs/roster.md`      | Design contract for a roster that changes while the room runs — read with `agent.md`             |
| `docs/durability.md`  | What the record promises under failure, and how the tiers prove it — read with `agent.md`        |
| `docs/toolchain.md`   | Build, CI, release — read before changing `.github/`, `scripts/`, root configs                   |
| `examples/site`       | Runnable example                                                                                 |
| `demos/`              | One dated report per merged change — regenerate on the branch, then leave it                     |
| `planning/`           | `next.md`: the must-have scope and plan for 0.1.0; `backlog.md`: everything after                |

## Positioning

**`README.md` holds the positioning.** It states what Ambion is, the key
technical facts, and what is new, and it describes the 0.1.0 surface. Every
other page links to it and states nothing twice. `planning/next.md` names
which parts of that surface are still open.

Ambient means a room remains available between interactions. Native timers,
external event subscriptions, and scheduler ingress remain future work.

[`planning/next.md`](planning/next.md) defines the 0.1.0 scope and owns the
work and its evidence. [`planning/backlog.md`](planning/backlog.md) holds
everything after 0.1.0. `docs/` document current capabilities and label
pending release changes explicitly. Keep the examples in `docs/` on the
implemented API until the corresponding change lands.

## Commands

```sh
pnpm install
pnpm check     # format, build, typecheck, lint, test — the gate CI runs
pnpm format    # biome --write, then prettier --write
pnpm test:live # the room on a real model; needs <PROVIDER>_API_KEY and costs money
pnpm chaos     # the sweeps on both storages, the handover at every write, the kill at every third write, 200 seeds of the walk and the history
pnpm check:lemmascript # prove the contracts in rules.verified.ts with Dafny; CI runs it, a contributor needs Dafny on PATH
```

Run `pnpm format` and `pnpm check` before every push. CI runs the same gate.

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
- A pure rule the journal or the fold decides by lives in the layer's
  `rules.verified.ts`, with `//@ requires` and `//@ ensures` contracts.
  Regenerate its `.dfy` and `.dfy.gen` with `npx lsc gen --backend=dafny`
  after every edit.
- Cognitive complexity: max 10 in source, 15 in tests.
- Prettier formats (tabs, single quotes, width 100, semicolons); Biome lints.
- Tests are vitest. A scripted `streamFn` makes a room deterministic.

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
