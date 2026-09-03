# CLAUDE.md

Guidance for Claude Code in this repository.

## Project

Ambion is a minimalist framework for ambient-aware, always-on agents. Agents
wait in a session and activate only when a message is delivered to them. Five
primitives: `defineAgent`, `defineHuman`, `defineTool`, `defineWorkspace`,
`startSession`. The session's assistant writes the one message a person reads
when the session is idle.

pnpm workspace, Node >= 22.19, ESM only, TypeScript.

| Path                | What                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------- |
| `packages/ambion`   | The runtime. One file per concern; `session.ts` composes them                          |
| `packages/cli`      | The `ambion` binary                                                                    |
| `docs/agent.md`     | Design contract for the core. Read it before changing the runtime                      |
| `docs/exchange.md`  | Design contract for the exchange, the session's unit of work. Read it with `agent.md`  |
| `docs/presence.md`  | Design contract for presence and visits. Read it with `agent.md`                       |
| `docs/assistant.md` | Design contract for the assistant, the session's counterpart to the people in it       |
| `docs/workspace.md` | Design contract for the workspace an agent's tools reach into. Read it with `agent.md` |
| `docs/toolchain.md` | Build, CI, release. Read it before changing `.github/`, `scripts/`, root configs       |
| `examples/site`     | Runnable example                                                                       |
| `demos/`            | One dated report per merged change. Regenerate on the branch, then leave it            |
| `FOLLOW_WORK.md`    | Work a branch decided not to do, and why it is worth doing                             |

## Thesis

Every agent that keeps growing arrives at multi-agent collaboration; Ambion
starts there. Complex software comes from many agents, each expert in one
domain. The agent is the unit of context engineering, and it is the ownership
boundary: one team owns one agent whole, with its domain, its tools, its
instructions, its model and its evals. An agent is as good as its context.
Context engineering (progressive disclosure, tool and response shapes,
guardrails, completion checks) composes inside one agent, where every
technique serves the same domain. A single engine and a single context window
cannot hold that boundary: a change for one domain lands in every domain's
context, and a monolithic agent settles at a local maximum, where no team can
improve its domain without degrading another's. Even the monolith arrives
there (subagents); Ambion's agents are first-class, each with an owner. The
platform provides the shared capabilities. A session built for collaboration
holds the agents.

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
pnpm check     # build, typecheck, lint, test: the gate CI runs
pnpm format    # biome --write, then prettier --write
```

Run `pnpm format` and `pnpm check` before every push. CI runs the same gate.

## Code rules

- Pi (`@earendil-works/pi-agent-core`) owns the model loop, tools, transcript.
  just-bash owns the virtual filesystem and shell behind a workspace. Ambion
  owns only participants-as-values and the session. A third concern is a
  design failure: push it into a dependency or drop it. `render.ts` is
  everything a participant reads (prompts, roster, transcript, the ask at the
  end of an activation) and stays pure and stateless so it does not become
  one. What the session says to a developer stays with the mechanism that
  says it.
- No `any`, no non-null assertions, no unused imports or variables.
- `packages/ambion/src` must not write to stdout. Hosts pass a logger in.
- Cognitive complexity: max 10 in source, 15 in tests.
- Prettier formats (tabs, single quotes, width 100, semicolons); Biome lints.
- Tests are vitest. A scripted `streamFn` makes a session deterministic.

## Writing documentation

Write all documentation, code comments, and commit messages in **ASD-STE100
Simplified Technical English**. It is the controlled-language standard for
technical writing: one meaning per word, one instruction per sentence. The
rules below were chosen against passages of `README.md`; hold every edit to
them.

### Sentences

1. **Active voice.** "The session stamps provenance". Do not write
   "provenance is stamped".
2. **Short sentences on average.** Aim for 20 words in an instruction and 25
   in a description. The number is a target for the page, and a single
   sentence may run longer when a split would break its sense.
3. **Simple tenses.** Present for how things work, imperative for
   instructions.
4. **Keep articles and relative pronouns.** "The agent that waits". Do not
   write "agent waits".
5. **No noun clusters over three words.** Break them with prepositions.
6. **A colon may set up an elaboration.** "The runtime sets one bar: a reply
   must add something the transcript does not already hold."
7. **A parallel triad is welcome.** "One context window, one domain, one team
   that owns it." A longer list in a sentence names each item once; do not
   repeat an opener ("each message, each activation, each error").
8. **No dashes in prose.** A colon, a comma, parentheses, or a new sentence
   does the work. This holds in `CLAUDE.md` too.
9. **State what a thing does.** Do not add a scope tail such as "and nothing
   else" or "and nobody else". The reader infers the boundary from the
   positive statement.
10. **No contrastive framing as a rhetorical device.** Avoid "X, not Y",
    "X rather than Y", "X instead of Y". Say what a thing is or does. A plain
    negative fact is fine when the reader needs it ("A human has no tools").
11. **Do not restate a point in a second formulation.** One statement per
    point.

### Words

**One word, one meaning.** Pick a term and keep it. Prose uses plain nouns for
the concepts. Exported identifiers keep their names and appear in code font
(`quiet()`, `readSession`, `seated`); prose around them uses the plain noun.

| Write       | Do not write        | Meaning                                                            |
| ----------- | ------------------- | ------------------------------------------------------------------ |
| session     | room                | The named place agents and people share                            |
| participant | seat                | An agent or a person in a session                                  |
| transcript  | record              | Every message a session holds, in order                            |
| idle        | quiet               | No participant is activated                                        |
| activate    | wake, trigger, call | The session runs one participant on a message                      |
| activation  | turn, round         | One run of one participant                                         |
| exchange    |                     | A person's question and every activation until the session is idle |
| attention   |                     | How wide a participant listens                                     |
| reach       |                     | How wide a message is heard                                        |
| visit       |                     | A person's time in a running session                               |
| presence    |                     | Arriving and leaving, as events                                    |

`turn` belongs to Pi, where it means one request to a provider, and `round`
belongs to nobody.

**No figures of speech.** No slang, no metaphor, no ellipsis. State the
mechanism. "An activation that ends without calling `say` writes nothing to
the transcript." Do not write "leaves no mark", "reads a swarm", "stands
down", "steps in".

**Banned words:** "load-bearing", "seam".

### Voice

Write to get the job done. Do not educate, persuade, or lecture along the way.
The reader wants the mechanism, once, and then the next mechanism.

**The reader is "you".** The reader has built an agent and has not yet met the
scaling problems this project tackles. Ground a claim in what they have lived
("You have felt the first step: a skill added for one task made another task
worse"), then extrapolate to the scale they have not. Keep the field's
vocabulary; do not flatten it to plain English.

**Nobody speaks.** No "I", "my", "we", "our". The mechanism is the subject of
the sentence. Do not write "Ambion is my take on it"; start at the mechanism.

**A short closing sentence is rare.** A paragraph may end on a one-clause
consequence ("An idle session costs nothing.") only when the reader needs that
consequence and the mechanism above does not state it. Most paragraphs end on
the last mechanism.

### Page shape

Optimize every page for a human scanning it.

- **A bold lead is a full sentence that states the claim.** "**Speaking is a
  tool, and silence is the default.**" A reader of only the bold leads gets
  the page's claims. Do not use a noun label as a bold lead.
- **Headings are noun phrases, without numbers.** "The mechanisms", "Three
  rules". Cite a section of a design contract by its title.
- **One topic per paragraph,** max 6 sentences and under six lines of prose.
  Split at the natural break.
- **An enumeration is a bulleted or numbered list.** Each bullet is one or
  more complete sentences with a subject and a verb.
- **Tabular facts are a table.** A table cell may be a fragment: a noun phrase
  or a clipped clause with a full stop.
- **A diagram is welcome when it shows the mechanism.** GitHub renders
  Mermaid.
- **A comment in a code example states what the line does, once,** in the
  mechanism's terms. Write `// resolves when the assistant has written` and
  no narrative about the people in the example.

State facts, not claims. If a command or feature does not exist yet, say so
plainly. Wrap Markdown prose at about 78 columns; Prettier preserves it.

`README.md` and `docs/` follow these rules. Where they do not yet, the rules
win, and the rewrite is a change of its own.

## Git

- Develop on a feature branch; push with `git push -u origin <branch>`.
- Do not open a pull request unless asked.
