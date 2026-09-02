# CLAUDE.md

Guidance for Claude Code in this repository.

## Project

Ambion — a minimalist framework for ambient-aware, always-on agents. Agents wait
in a session and activate only when a message is delivered to them. Five
primitives: `defineAgent`, `defineHuman`, `defineTool`, `defineWorkspace`,
`startSession`. A person's assistant writes the one message they read when
the room goes quiet.

pnpm workspace, Node >= 22.19, ESM only, TypeScript.

| Path                | What                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------ |
| `packages/ambion`   | The runtime. One file per concern; `session.ts` is the room that composes them       |
| `packages/cli`      | The `ambion` binary                                                                  |
| `docs/agent.md`     | Design contract for the core — read before changing the runtime                      |
| `docs/exchange.md`  | Design contract for the exchange, the room's unit of work — read with `agent.md`     |
| `docs/presence.md`  | Design contract for presence and visits — read with `agent.md`                       |
| `docs/assistant.md` | Design contract for the assistant, a person's counterpart in a room                  |
| `docs/workspace.md` | Design contract for the workspace an agent's tools reach into — read with `agent.md` |
| `docs/toolchain.md` | Build, CI, release — read before changing `.github/`, `scripts/`, root configs       |
| `examples/site`     | Runnable example                                                                     |
| `demos/`            | One dated report per merged change — regenerate on the branch, then leave it         |
| `FOLLOW_WORK.md`    | Work a branch decided not to do, and why it is worth doing                           |

## Thesis

Every agent that keeps growing arrives at multi-agent collaboration; Ambion
starts there. Complex software comes from many agents, each expert in one
domain. The agent is the unit of context engineering, and it is the ownership
boundary: one team owns one agent whole — its domain, its tools, its
instructions, its model, its evals. An agent is as good as its context, and context engineering —
progressive disclosure, tool and response shapes, guardrails, completion
checks — composes inside one agent, where every technique serves the same
domain. A single engine and a single context window cannot hold that boundary:
a change for one domain lands in every domain's context, and a monolithic
agent settles at a local maximum, where no team can improve its domain without
degrading another's. Even the monolith arrives there (subagents); Ambion's
agents are first-class, each with an owner. The platform provides the shared
capabilities. A room built for collaboration holds the agents.

Agents are ambient: they wait, and events activate them. A person speaking is
one event source; timers, tasks and other systems are event sources of the
same kind, and every one enters as a message. Keep both framings in
`README.md` and `docs/`.

`README.md` and `docs/` document what is implemented. Do not write about
unbuilt concepts (channels, deployment targets) there; deferred work goes in
`FOLLOW_WORK.md`.

## Commands

```sh
pnpm install
pnpm check     # build, typecheck, lint, test — the gate CI runs
pnpm format    # biome --write, then prettier --write
```

Run `pnpm format` and `pnpm check` before every push. CI runs the same gate.

## Code rules

- Pi (`@earendil-works/pi-agent-core`) owns the model loop, tools, transcript.
  just-bash owns the virtual filesystem and shell behind a workspace. Ambion
  owns only participants-as-values and the session. A third concern is a
  design failure: push it into a dependency or drop it. `render.ts` is
  everything a participant reads — prompts, roster, record, the ask at the end
  of a turn — and stays pure and stateless so it does not become one. What the
  room says to a developer stays with the mechanism that says it.
- No `any`, no non-null assertions, no unused imports or variables.
- `packages/ambion/src` must not write to stdout. Hosts pass a logger in.
- Cognitive complexity: max 10 in source, 15 in tests.
- Prettier formats (tabs, single quotes, width 100, semicolons); Biome lints.
- Tests are vitest. A scripted `streamFn` makes a session deterministic.

## Writing documentation

Write all documentation, code comments, and commit messages in **ASD-STE100
Simplified Technical English**. It is the controlled-language standard for
technical writing: one meaning per word, one instruction per sentence.

Rules that carry the most weight here:

1. **Active voice.** "The session stamps provenance", not "provenance is
   stamped".
2. **Short sentences.** Max 20 words for an instruction, 25 for a description.
3. **One topic per paragraph**, max 6 sentences.
4. **One word, one meaning.** Pick a term and keep it. An activation is always
   an activation, never a trigger, a call, a wake — or a turn. The room has two
   spans and two words: an **activation** is the room waking one seat, an
   **exchange** is a person's question and every activation until the room goes
   quiet. `turn` belongs to Pi, where it means one request to a provider, and
   `round` belongs to nobody.
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
