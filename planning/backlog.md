# Backlog

Architectural debt found in the review of 2026-09-03, on the head that
seats agents from a reserve. Every item names what it is, what it costs,
where it lives, and the smallest change that removes it. Items sit in
order of cost. [`next.md`](next.md) holds the five to do first.
[`../FOLLOW_WORK.md`](../FOLLOW_WORK.md) holds design work a branch chose
to defer; this file holds debt in what is built.

## Runtime module boundaries

### 1. The room is a process global

**What.** `session.ts` holds a module-level `running` map, a shared
`defaultRepo`, a lazily built model registry, and a `registryStream` that
reads `process.env` for API keys. `workspace.ts` holds a global `taken` set.

**Why.** Two hosts in one process cannot each run a room with the same
name. Tests keep unique-name counters to stay apart. A room resumed after
a restart shares one in-memory repo with every other room in the process.
For hermetic execution and session resumption, the host must own these.

**Where.** `packages/ambion/src/session.ts` lines 75 to 95,
`packages/ambion/src/workspace.ts` line 50.

**Fix.** A `Runtime` value that holds the registry, the repo and the
environment source. `startSession`, `readSession` and `defineWorkspace`
take it as an option. The current globals become the default instance.

### 2. Nothing bounds the record, and the room rescans it per message

**What.** `Attendance.known()` rebuilds a map from the whole record on
every call. The room calls it on each dispatch, on each `seats()`, and per
person in `peopleViews()`, which adds two more linear scans per person.
Every activation renders the whole record into the prompt through
`renderRecord`.

**Why.** Cost is O(n) per message and O(n²) over a run. Context grows
without limit. `docs/agent.md` §8 says Ambion owns no context window, and
`docs/assistant.md` §16 forbids a compactor, so today nothing owns it.

**Where.** `packages/ambion/src/presence.ts`, `known()` and
`lastChangeAt()`; `packages/ambion/src/session.ts`, nine call sites;
`packages/ambion/src/render.ts`, `renderRecord`.

**Fix.** Short term: `Attendance` keeps an incremental index that updates
on append. Long term: a window policy on `RoomView.record`, and a decision
in the contract about which module owns it.

### 3. `session.ts` holds six jobs in 1063 lines

**What.** `SessionImpl` has 61 methods. Its header lists compose, commit,
route, hands, and quiescence. The reserve, `seat` and `unseat` joined it in
the last change. The `say` tool sits inline at line 858, while the
assistant's `summarise` and `seat` tools live in `assistant.ts` behind
small room interfaces. The commit path (`claim`, `publish`,
`commitPresence`, `deliverFrom`) and the assistant scheduling
(`closeExchange` through `draftNext`) are two more concerns.

**Why.** Every feature lands in one file. `dispatch` sits at the
complexity cap by design, and the file around it has no cap.

**Where.** `packages/ambion/src/session.ts`.

**Fix.** Move `say` to `seat.ts` beside `toPiTool`, with a `SayRoom`
interface that mirrors `SummaryRoom`. Move the commit path into
`record.ts`. Move the reserve into its own module. The room keeps compose
and route.

### 4. Importing the package loads every provider SDK

**What.** `session.ts` imports `@earendil-works/pi-ai/providers/all` at
module top. The built dist pulls in the AWS Bedrock client, Google GenAI,
protobufjs and the Anthropic SDK before a host defines anything.

**Why.** Measured on the built dist:

| Metric                             | Value                     |
| ---------------------------------- | ------------------------- |
| `import '@ambionframework/ambion'` | about 600 ms              |
| RSS added by the import            | 65 MB                     |
| Provider SDK weight on disk        | 45 MB of 378 MB installed |

The four ignored build-script warnings on every `pnpm install` come from
this tree, and `docs/toolchain.md` §3 says nothing in the tree needs one.

**Where.** `packages/ambion/src/session.ts` line 28 and `registry()`.

**Fix.** Make `registry()` a dynamic import, or move default provider
resolution to the host. `streamFn` is already the extension surface.

### 5. `defineAgent` imports the shell runtime

**What.** `define.ts` imports `BUILTIN_TOOL_NAMES` from `workspace.ts`,
which imports `memoryBackend` from `just-bash.ts`. A value module depends
on just-bash for a set of four strings.

**Where.** `packages/ambion/src/define.ts` line 27.

**Fix.** Move the constant to `types.ts`.

### 6. Two copies of typebox

**What.** Pi pins `typebox@1.3.7` exactly. The runtime and the example
declare `^1.3.18`. `defineTool` types parameters against one copy and Pi
validates with the other.

**Why.** It works today because schemas are plain objects. The split is a
latent break on the next typebox release that changes a type.

**Where.** `packages/ambion/package.json`, `examples/site/package.json`.

**Fix.** Match Pi's pin, or declare typebox as a peer dependency.

### 7. Test affordances leak into the runtime

**What.** `resolveModel` returns `{ api: 'scripted' } as unknown as
Model<Api>` when a host passes a custom `streamFn`.

**Where.** `packages/ambion/src/session.ts`, `resolveModel`.

**Fix.** Build a real `Model` value with Pi's own shape.

## Toolchain and project structure

### 8. The local gate and CI disagree

**What.** `pnpm check` omits `check:format`. The CI `check` job runs it.
`CLAUDE.md` and `CONTRIBUTING.md` both promise "the gate CI runs".

**Why.** A contributor with a green local check can fail CI on formatting.

**Where.** `package.json`, the `check` script.

**Fix.** Add `pnpm run check:format` to `check`.

### 9. The script contract names a task nobody implements

**What.** `turbo.jsonc` declares `dev`, and `docs/toolchain.md` §6 lists it
among the scripts every package implements. No package has one.
`check:types` and `test` also depend on the package's own `build`, so the
runtime bundles itself before it typechecks or tests sources that never
read the bundle.

**Where.** `turbo.jsonc`, `docs/toolchain.md` §6.

**Fix.** Remove `dev` from both until a package has one. Change
`check:types` and `test` to depend on `^build` alone.

### 10. The CLI is a published placeholder

**What.** No commands. A Node floor guard that nothing exercises. Help text
and `packages/cli/README.md` promise `dev`, `deploy` and `init`.
`packages/ambion/package.json` carries `cloudflare` and `durable-objects`
keywords for targets that do not exist.

**Why.** `CLAUDE.md` forbids documenting unbuilt features.

**Where.** `packages/cli/src/main.ts`, `packages/cli/README.md`,
`packages/ambion/package.json`.

**Fix.** Mark the CLI private until it has a command, and remove the
promises and the keywords.

### 11. Knip config omits the example workspace

**What.** `knip.json` lists `.` and `packages/*`. Plugin detection still
covers `examples/site`, verified clean with `--workspace examples/site`.

**Where.** `knip.json`.

**Fix.** Add an `examples/*` entry so the coverage is declared.

## Docs, tests, and generated artifacts

### 12. The package README documents the previous API

**What.** `packages/ambion/README.md` shows `defineHuman({ assistant })`
and `startSession` without `assistant`. Neither typechecks against the
current `StartSessionOptions`. This is the README the registry shows.

**Where.** `packages/ambion/README.md` lines 12 to 50.

**Fix.** Rewrite the snippet against the current API. Add a test that
compiles the README snippet, so the next drift fails the gate.

### 13. Test scaffolding is copied five ways

**What.** `scripted()` appears in `session.test.ts`, `assistant.test.ts`,
`workspace.test.ts` and `roster.test.ts`, with three different abort
behaviours. `byAgent`, `speak`, `quiet`, `deferred`, `collect`, `enter`,
the stub assistant and the name counters are copied beside it.
`presence.test.ts` carries its own `quiet`. About 300 lines in total.

Every copy identifies the agent by matching the system prompt for
`You are '…'`. A wording change in `render.ts` routes every script to
`unknown` and the tests fail for a reason nobody reads in the diff. The
tests already name models `scripted/<agent>`.

**Where.** `packages/ambion/test/*.test.ts`.

**Fix.** One `test/support/` module. Route the script on `model.id`.
