# CLAUDE.md

Guidance for Claude Code in this repository.

## Project

Ambion — a minimalist framework for ambient-aware, always-on agents. Agents wait
in a session and activate only when a message is delivered to them. Four
primitives: `defineAgent`, `defineHuman`, `defineTool`, `openSession`.

pnpm workspace, Node >= 22.19, ESM only, TypeScript.

| Path                     | What                                                                           |
| ------------------------ | ------------------------------------------------------------------------------ |
| `packages/ambion`        | The runtime. `define.ts`, `session.ts`, `types.ts`, `render.ts`                |
| `packages/cli`           | The `ambion` binary                                                            |
| `docs/agent.md`          | Design contract for the core — read before changing the runtime                |
| `docs/presence.md`       | Design contract for presence and visits — read with `agent.md`                 |
| `docs/representative.md` | Design for the agent a person brings into a room — not built                   |
| `docs/toolchain.md`      | Build, CI, release — read before changing `.github/`, `scripts/`, root configs |
| `examples/site`          | Runnable example                                                               |
| `demos/`                 | One dated report per merged change — regenerate on the branch, then leave it   |

## Thesis

Complex software does not come from one large agent that receives more context
as it asks for it. It comes from many agents, each expert in one domain. The
platform provides the shared capabilities. A workspace built for collaboration
holds the agents. Keep this framing in `README.md` and `docs/`.

The session is that workspace today. Workspaces, channels, and the shared
filesystem are designed and not built. Write about them as design, not as code.

## Commands

```sh
pnpm install
pnpm check     # build, typecheck, lint, test — the gate CI runs
pnpm format    # biome --write, then prettier --write
```

Run `pnpm format` and `pnpm check` before every push. CI runs the same gate.

## Code rules

- Pi (`@earendil-works/pi-agent-core`) owns the model loop, tools, transcript.
  Ambion owns only participants-as-values and the session. A third concern is a
  design failure: push it into a dependency or drop it. `render.ts` is the
  session's own prose — what a seat reads — and stays pure and stateless so it
  does not become one.
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
   an activation, never a trigger, a call, or a wake.
5. **Simple tenses.** Present for how things work, imperative for instructions.
6. **Keep articles and relative pronouns.** "The agent that waits", not "agent
   waits".
7. **No noun clusters over three words.** Break them with prepositions.
8. **No slang, no metaphor, no ellipsis.** State the mechanism.

Also: state facts, not claims. If a command or feature does not exist yet, say
so plainly. Wrap Markdown prose at about 78 columns; Prettier preserves it.

Existing prose in `README.md` and `docs/` predates this rule and is deliberately
voiced. Do not rewrite it wholesale — apply STE to new and edited text.

## Git

- Develop on a feature branch; push with `git push -u origin <branch>`.
- Do not open a pull request unless asked.
