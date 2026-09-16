# CLAUDE.md

Guidance for Claude Code in this repository.

## Project

Ambion is a collaboration kernel for independently owned agents and the
people they serve. Agents own their instructions, models, tools, and domain
expertise. Rooms provide a shared journal and participation rules. An optional
assistant selects reserve specialists and consolidates their work for a person.
Applications own domain data and tool resources.

pnpm workspace, ESM only, TypeScript. Repository installation needs Node
26.4 or newer for OpenTUI. The core runtime supports Node >= 22.19.

| Path                  | What                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `packages/ambion`     | The runtime. One file per concern, in layers Biome holds; `room.ts` composes them           |
| `packages/cli`        | Project creation and local rooms through Wrangler and OpenTUI; publication remains separate |
| `packages/cloudflare` | A room as Durable Objects: one object per room, one per seat. Private; tested in workerd    |
| `packages/journal`    | An append-only journal: one queue, fenced by run, with conditional commits                  |
| `packages/workspace`  | A workspace resource and its tools, over an in-memory or directory filesystem               |
| `docs/agent.md`       | Design contract for the core — read before changing the runtime                             |
| `docs/exchange.md`    | Design contract for the exchange, the room's unit of work — read with `agent.md`            |
| `docs/presence.md`    | Design contract for presence and visits — read with `agent.md`                              |
| `docs/assistant.md`   | Design contract for the assistant, the room's counterpart to the people in it               |
| `docs/workspace.md`   | Design contract for the workspace an agent's tools reach into — read with `agent.md`        |
| `docs/roster.md`      | Design contract for a roster that changes while the room runs — read with `agent.md`        |
| `docs/durability.md`  | What the record promises under failure, and how the tiers prove it — read with `agent.md`   |
| `docs/toolchain.md`   | Build, CI, release — read before changing `.github/`, `scripts/`, root configs              |
| `examples/site`       | Runnable example                                                                            |
| `demos/`              | One dated report per merged change — regenerate on the branch, then leave it                |
| `planning/`           | `release-0.1.0.md`: release scope; `next.md`: remaining and deferred work                   |

## Thesis

**The agent is the unit of modularity.** Each domain can have its own owner,
model, tools, instructions, and evaluations. The collaboration contract makes
independent contributions usable together.

**The journal is the source of active collaboration and its history.** Pure
rules interpret recorded contributions, membership, presence, execution claims,
and exchange boundaries. Hosts recover pending work through replay.

**The assistant is optional and constrained.** Selection and synthesis are its
roles. A closed exchange's summary replaces its covered source messages in
later agent activations. Human participants can review the original discussion
through exchange reads. The journal retains the complete history.

Ambient means a room remains available between interactions. Native timers,
external event subscriptions, and scheduler ingress remain future work.

[`planning/release-0.1.0.md`](planning/release-0.1.0.md) defines the release
positioning, scope, and limits. [`planning/next.md`](planning/next.md) owns
implementation work and completion evidence. `README.md` and `docs/` document
current capabilities and label pending release changes explicitly. Keep examples
on the implemented API until the corresponding change lands.

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
  every entry shares. Ambion owns only participants-as-values and
  the room. A third concern is a
  design failure: push it into a dependency or drop it. `render.ts` formats
  participant context. `assistant.ts` owns assistant policy and guidance.
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
