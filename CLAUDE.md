# Working in this repository

Ambion is a minimalist framework for ambient-aware, always-on agents. It is a
pnpm monorepo. Node 22.19 or later is necessary.

## Layout

| Path                | Contents                                                         |
| ------------------- | ---------------------------------------------------------------- |
| `packages/ambion`   | The runtime. Four primitives on the Pi SDK.                      |
| `packages/cli`      | The `ambion` command line interface.                             |
| `examples/`         | Runnable examples. Each is a workspace package.                  |
| `docs/`             | Design documents. See the reading order below.                   |
| `scripts/`          | Release and version scripts. `docs/toolchain.md` specifies them. |
| `.github/workflows` | CI and release. Read `docs/toolchain.md` before you change them. |

## The documents, in reading order

1. `docs/agent.md` — the shipped core: four primitives, one invariant, and the
   eight rules of the room. This describes what exists today.
2. `docs/concepts.md` — what the rest of Ambion is: eight nouns, one rule, nine
   laws. This describes intent, not the current surface.
3. `docs/roadmap.md` — the order in which the concepts arrive, and the brief for
   each item.
4. `docs/toolchain.md` — how the repository is built, checked, and released.

Each document has one job. `concepts.md` gives the _what_ and does not schedule.
`roadmap.md` gives the _when_ and does not design. Keep that division when you
edit them.

## Commands

```sh
pnpm install
pnpm check     # build, typecheck, lint, test — the same gate CI runs
pnpm format    # biome --write, then prettier --write
```

Run `pnpm check` before you push.

Use the pinned Prettier at `./node_modules/.bin/prettier`. Do not use `npx
prettier`: it can resolve a different version and report false failures.

## Writing style

Write technical prose toward **ASD-STE100 (Simplified Technical English)**. The
goal is text that one reader understands in one pass. Apply these rules:

1. **One idea per sentence.** Keep descriptive sentences to 25 words or fewer.
   Keep instructions to 20 words or fewer.
2. **Use the active voice.** Name the actor: "the runtime stamps the message",
   not "the message is stamped".
3. **Use simple tenses.** Prefer the present tense.
4. **One term for one thing.** Do not introduce a synonym for a term the
   documents already use. Do not use one word as both a noun and a verb.
5. **Keep articles and relative pronouns.** Write "the record that the seat
   reads", not "the record the seat reads".
6. **Avoid `-ing` forms** when a finite verb does the same work.
7. **No idioms, metaphors, or rhetorical flourishes.** State the fact.
8. **Limit noun clusters to three nouns.**
9. **Start each paragraph with its topic sentence.** Use six sentences or fewer.
10. **Use a list** when an item has more than two parts.

Technical names and technical verbs are permitted, and the design depends on
them. `agent`, `human`, `tool`, `session`, `room`, `seat`, `roster`, `record`,
`workspace`, `task`, `source`, `channel`, `aperture`, `entity`, `holder`,
`ladder`, `provocation`, and `carriage` are exact terms. Define each one on
first use and then use it consistently.

Prettier does not re-wrap prose in this repository (`proseWrap` is not set).
Markdown body text is wrapped by hand at about 72 columns. Match the surrounding
width when you edit.

## Conventions

- TypeScript, ES modules, tabs for indentation. Biome enforces the rules; `any`
  and non-null assertions are rejected.
- Knip fails the build on unused exports. Do not export what nothing imports.
- Examples import the built package, so run `pnpm build` before you typecheck an
  example.
- Storage is Pi's. Ambion re-exports `SessionRepo` and `SessionStorage` and adds
  no storage abstraction of its own.
