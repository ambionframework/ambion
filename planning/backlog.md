# Backlog

Two kinds of work, in one file. The first part holds architectural debt in
what is built, found in the review of 2026-09-03 on the head that seats
agents from a reserve. Every item names what it is, what it costs, where it
lives, and the smallest change that removes it, and the items sit in order
of cost. The second part holds design work a branch decided not to do, and
why it is worth doing. The design contracts in [`../docs/`](../docs) hold
the open questions about a design; this file holds the work.
[`next.md`](next.md) holds the five to do first.

## Part one: debt in what is built

## Runtime module boundaries

### 1. The room is a process global

**Resolved 2026-09-05.** `runtime.ts` holds a `Runtime` value: the repo, the
environment source and the model registry as public fields, with the
`running` map and the `taken` set behind the brand. `createRuntime` builds
one, and `startSession`, `readSession` and `defineWorkspace` take it as
`runtime`. The former globals are fields of one default instance, built on
first use. `model.ts` reads the registry and the environment through the
runtime it is given. Two runtimes in one process run rooms with the same
name and never see each other, and `test/runtime.test.ts` proves it.

**What stays.** The default instance still imports Pi's provider catalog at
module top; item 4 lands in `runtime.ts`. The one-run-per-name guard now
protects one runtime's repo: a host that gives two runtimes one durable
repo owns that overlap. The `roomName` counter in the tests stays until a
test wants a runtime of its own.

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

**Resolved 2026-09-04.** `say` lives in `seat.ts` behind `SayRoom`, the way
`summarise` and `seat` live in `assistant.ts` behind their room interfaces.
The lock and the timestamp live in `record.ts`. The roster and the reserve
live in `composition.ts`. Model resolution lives in `model.ts`, where items 4
and 7 now land. The public session shapes live in `types.ts`, and the visit
handle and the people views in `presence.ts`.

**What stays.** `session.ts` measures 781 lines and holds compose, commit and
route, the hands, and quiescence. The quiescence block, `settle` through
`markQuiet`, reads the exchanges, the assistant, the waiters and `activate`
at once; an interface for it is the room. Item 21 names the scheduler it
becomes when a second writer needs one.

### 4. Importing the package loads every provider SDK

**What.** `runtime.ts` imports `@earendil-works/pi-ai/providers/all` at
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

**Where.** `packages/ambion/src/runtime.ts`, the default `registry`.

**Fix.** Make the default `registry` a dynamic import. A host that passes
its own `registry` or `streamFn` never loads the catalog.

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

**Where.** `packages/ambion/src/model.ts`, `resolveModel`.

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

## Part two: design work deferred

### 13. Steering an exchange from what a person holds

**What.** A person's preferences shape one message, and they shape it after
the work is done. The same preferences could aim the room while it works.
Sam never reads contract terms, so three seats spending an activation on
them is money his preferences already knew to save. The rule is deterministic: it
reads what a person holds and what a message is, so the room can run it as
a check, and it costs no activation.

**Why.** The preferences are in one place already: the `preferences` field on
`defineHuman` ([`docs/assistant.md`](../docs/assistant.md) §2), which today
reaches the assistant alone, at the close. A person who has said what they act
on has said something the room could use while it is still deciding what to
say. It is also the cheapest of the three rungs in §12: a check costs
nothing, and rung 3 pays for an activation.

**What it needs deciding.**

- **Who reads the field.** Today one seat does, at one moment. A check the
  room runs when it builds a context is a second reader, and it keeps every
  invariant below intact because it is not a seat and never runs. The
  argument against is that a preference written for a summary may read
  badly as a filter on what a product says.
- **Which invariant it touches.** Three hold today: the assistant is seated
  `none`, `handsFor` gives it empty hands outside an open or a close, and
  `wakes` refuses to wake anybody for what the assistant writes, with the one
  exception of a seat it seats. A steer that reaches a
  running seat as a `[new]` line touches the third, because the room would
  carry the assistant's words to a seat that did not ask for them.
- **What it may steer.** Rule 2 says what arrives mid-activation is steered
  in and changes nothing else. A preference that suppresses a line is a
  different act from one that adds one, and only the second is a steer.
- **What a seat is told.** A seat that is aimed and does not know it will
  argue with the room. The paragraph that explains a fold
  (`SUMMARY_PARAGRAPH`) is the precedent.

**Where.** `dispatch` and `handsFor` in
[`session.ts`](../packages/ambion/src/session.ts), `wakes` in
[`seat.ts`](../packages/ambion/src/seat.ts), the assistant's paragraphs in
[`render.ts`](../packages/ambion/src/render.ts).

### 14. Thinning the roster: the assistant unseats, and a seat leaves

**What.** [`docs/roster.md`](../docs/roster.md) §5 gives the host `unseat` and
gives the assistant `seat` alone. Two ways to take a seat back off the roster
while the room runs, and both return the agent to the reserve:

- An `unseat` in the assistant's hands, at the open of an exchange beside
  `seat`, to take a colleague out of an exchange the colleague is not helping.
- A `leave` in the seat's own hands: a seated specialist that judges its part
  done ends its activation with a tool call that takes it back to the reserve,
  the way `say` is a tool and silence is a decision.

**Why.** A room that only grows over a day pays for every seat it added at
every message that follows. The live run in
[`demos/2026-09-03-who-the-question-needs.html`](../demos/2026-09-03-who-the-question-needs.html)
seated all three specialists by the second question and ended with six seats
answering every message; the lock refused 45 says against 14 in the run
before, and nothing thinned the roster. The assistant reads the question and
the reserve at the open; it could read the roster the same way. A seat knows
better than anybody when its own part is done.

**What it needs deciding.**

- **What an unseat does to an activation in flight.** The host's `unseat`
  aborts it. An assistant that aborts a colleague mid-say is the destructive
  act `roster.md` §5 keeps out of its hands, so an assistant's unseat would
  wait for the seat to go idle, which is a second mechanism.
- **Whether a seat unseated mid-exchange counts at the close.** The
  threshold reads the record, so it does; whether that is right when the
  assistant removed the speaker is an argument to have.
- **Whether the assistant may unseat what the host seated at start.** The
  starting composition is the host's; an assistant that can undo it is a
  proxy for the host. The same question holds for a seat that leaves: an
  agent seated at start has no reserve to return to.
- **What a seat's `leave` is on the record.** An `unseated` with the seat
  itself in `by` fits the shape; whether a seat that leaves mid-exchange
  still counts at the close follows the threshold, which reads the record.

**Where.** `seat` and `unseat` in
[`session.ts`](../packages/ambion/src/session.ts), the composing activation in
[`assistant.ts`](../packages/ambion/src/assistant.ts).

### 15. Reseating: attention that a running room can change

**What.** A seat's attention is chosen when the agent is seated and never
moves. `session.reseat(name, attention)` would let a host widen or narrow one
while the room runs.

**Why.** Attention is now the whole of what a seating decides
([`docs/agent.md`](../docs/agent.md) rule 6): one widening scale, and one
comparison against a message's reach decides who wakes. Everything that reads
it already reads it per activation, so a seat that changes point costs nothing
to route.

It is also what [`docs/assistant.md`](../docs/assistant.md) §12's rung 3 wants. The assistant is
a seat at `none`; letting it take part in an exchange is a wider attention and
a `say` in its hands. With reseating that is a host's decision — _this room
lets the assistant speak_ — rather than a code change in the runtime.

**What it needs deciding.**

- **A seat mid-activation.** Narrowing a seat that is active must not cancel
  its activation, and widening one must not wake it retroactively for messages it has
  already missed. The likely rule: reseating takes effect at the next
  activation, and the record says nothing about it.
- **Whether it is on the record.** Presence is a message because the room's
  own answers change when somebody is reading. A seat changing attention
  changes who wakes, which every later context already shows in the roster.
  Probably an event and not a message, but that is an argument to have.
- **Who may do it.** A host, certainly. An agent, never — a room where an
  agent can widen its own attention is a room that can make itself expensive.
- **What the assistant holds when something else wakes it.** Nothing, today:
  `handsFor` gives the assistant `seat` for the activation an open wakes it for,
  `summarise` for the activation a close
  woke it
  for, and empty hands otherwise, so a wider attention alone buys a seat that
  reads the room and ends its activation. Rung 3 is a `say` added there on purpose,
  with the paragraph that says when waking the assistant is worth the money.

**Where.** `wakes` in
[`packages/ambion/src/seat.ts`](../packages/ambion/src/seat.ts), `Attention` in
[`types.ts`](../packages/ambion/src/types.ts), `seated` in
[`define.ts`](../packages/ambion/src/define.ts).

### 16. Waking the assistant costs money, and nothing says when it is worth it

Once the assistant is reachable (above), a product can wake it. The runtime's
prompt tells a seat that "attention costs money" for a directed say, and says
nothing about when the assistant is the right participant to ask. Rung 3
without that paragraph is a room that pays for an assistant it did not need.

### 17. The assistant in every seat's roster

The assistant is a seat, so it is in the roster every seat reads. When each
person brought one, three of them were measured at about 480 characters of a
seat context averaging 3,800 in the example — 13%, spent describing seats
that cannot be addressed. One seat per room cuts that to one line, and the
example's `identity` for it is one sentence. Worth re-measuring once the
assistant speaks.

### 18. A test for the owed-summary merge

`Assistant.owe` merges a person's owed range with `Math.min`, so somebody owed a
summary from a failed activation who asks again gets one message covering
both
exchanges. Nothing pins that behaviour; the tests cover the failure and the
retry separately. See [`docs/assistant.md`](../docs/assistant.md) §5.

### 19. Exchanges are run state

`Exchanges` holds the open exchange in memory, so a restart begins with none —
right for a room mid-question, and a limit for anything that wants to work
over past exchanges. A closed exchange is an owner and a range, so it is
derivable from the record; nothing derives it today. See
[`docs/exchange.md`](../docs/exchange.md) §5.

### 20. A second non-seat writer

The room owes summaries through a small scheduler: `owe`, `dueAtQuiescence`,
`dueAfterDraft` and `activationEnded`, held by `Assistant`. If a room-level compactor ever arrives
([`docs/assistant.md`](../docs/assistant.md) §16 forbids it by name today), it wants the
same scheduler. Two writers is the point at which it should become its own
thing rather than three fields on the session.

### 21. A credentials boundary for tool calls leaving the workspace

**What.** [`docs/workspace.md`](../docs/workspace.md) §1 draws the workspace's
boundary at the sandbox: what a tool can do inside it, through the runtime's
own construction of each `Workspace` value. A tool call that reaches
outside — an external API, a secret, another service — needs a second
boundary, sketched as a credentials provider paired with a sidecar proxy:
something that injects a credential or issues a short-lived token per call,
so a workspace's own trust (it provisions an agent's identity and checks
nothing beyond its name, §7) never has to extend to what a tool reaches
beyond it.

**Why.** Today a tool's `execute` function reaches whatever a host wires it
to (`docs/agent.md` §3), with no distinction between a call that stays
local and one that leaves. A workspace's filesystem boundary
([`docs/workspace.md`](../docs/workspace.md) §1, §8) has no answer for a tool
that calls out to a real API, and a real deployment needs one before it
hands an agent anything with network access.

**What it needs deciding.**

- Whether this is a workspace concern (a third kind of persistent entity,
  under [`docs/workspace.md`](../docs/workspace.md) §1's model) or a separate
  primitive entirely.
- What a sidecar proxy actually mediates: a network path every outbound
  call is forced through, or a narrower set of tools the workspace marks
  as external.
- Whether a token is minted per call, per activation, or per agent, and
  what a "short-lived" window actually is.
- How this interacts with `ToolContext`
  ([`docs/workspace.md`](../docs/workspace.md) §4) and `defineTool`'s own
  `execute` shape (`docs/agent.md` §3), neither of which takes any notion
  of a credential today.

**Where.** [`docs/workspace.md`](../docs/workspace.md) §1 names the boundary
and scopes it out to this entry; `ToolContext` in
[`docs/workspace.md`](../docs/workspace.md) §4 is the most natural place for
a credential to reach a tool call now, alongside `defineTool`'s `execute`
in [`docs/agent.md`](../docs/agent.md) §3.

### 22. `/dev/null` on the just-bash backends is a file

**What.** just-bash treats `/dev/null` as a plain file. A command that
redirects into it appends to it, and on `directoryBackend` the redirect
creates `dev/null` under the root, on disk
([`docs/workspace.md`](../docs/workspace.md) §8). The first live run of the
example left one there: a product wrote `cat … 2>/dev/null`, and the drive
gained a file.

**Why.** An agent that discards output expects it gone. A file that grows
with every redirect is a slow leak in memory and a surprise on disk, and
the `bash` tool's own description promises a Unix shell.

**What it needs deciding.**

- Whether the adapter intercepts `/dev/null` (a `MountableFs` over the
  workspace's filesystem with a discarding mount at `/dev`), or whether the
  fix belongs upstream in just-bash.
- Whether `connect` should seed `/dev` into a `ReadWriteFs` the way just-bash
  seeds it into an `InMemoryFs`, so the two backends at least agree.

**Where.** `connectOver` in [`just-bash.ts`](../packages/ambion/src/just-bash.ts).

### 23. A backend on a real machine

**What.** A `WorkspaceBackend` whose `connect` creates a real OS user when
one is absent and returns an `env` whose `exec` runs as that user through a
real user switch. [`docs/workspace.md`](../docs/workspace.md) §10 sketches it
and commits to nothing.

**Why.** The just-bash backend's boundary is nominal
([`docs/workspace.md`](../docs/workspace.md) §8): one instance, one identity,
and nothing stops one agent's `bash` call from reading another's home. A
real user turns that into isolation the operating system enforces, the
guarantee a multi-user Linux box gives. The shape is already fixed: two
functions, `connect` and `destroy`, and `connect` takes the tool call's
abort signal because `useradd` and a process spawn are real waits.

**What it needs deciding.**

- How an OS user is named from an agent's `name`, and what happens when two
  workspaces on one host provision the same name
  ([`docs/workspace.md`](../docs/workspace.md) §7 accepts the collision and
  checks nothing).
- What `destroy` removes: the users, their homes, or both.
- Whether Pi's `NodeExecutionEnv` is the `env`, with a `sudo -u` prefix on
  every command, or whether the backend spawns as the user itself.

**Where.** `WorkspaceBackend` in
[`types.ts`](../packages/ambion/src/types.ts); `directoryBackend` in
[`just-bash.ts`](../packages/ambion/src/just-bash.ts) is the shape to copy.

### 24. Whether Agent or AgentHarness is Ambion's foundation

**What.** Ambion's runtime imports Pi's lower-level `Agent` class
(`activation.ts`, `seat.ts`), not `AgentHarness`
(`@earendil-works/pi-agent-core`'s `harness/agent-harness.ts`) — a
heavier engine Pi ships beside it, with its own session tree, lanes,
compaction, and tree navigation. Nobody chose `Agent` over `AgentHarness`
on purpose; it is what the runtime already used before this question was
ever asked.

**Why.** [`docs/workspace.md`](../docs/workspace.md) §6 reuses part of what
the harness package exports — `Workspace` holds a plain `ExecutionEnv`
as its own `env` property — while keeping `Workspace` itself and
`ToolContext` (§4) outside anything `AgentHarness` provides. That split
holds today because `Agent` and `AgentHarness` overlap only at the edges.
`AgentHarness` also ships its own tool-context mechanism,
`AgentHarnessToolContextSource`, resolved once per turn and handed to an
`AgentHarnessTool`'s `execute`; `ToolContext` covers the same ground at a
narrower scope, resolved once per tool call against `defineTool`'s own
shape. A workspace is the first concept this project has built that sits
this close to ground `AgentHarness` already covers. A concept that sits
closer still is a real possibility once reminders and tasks
(`docs/workspace.md` §11) or anything with its own turn-scoped state
joins it.

**What it needs deciding.**

- Whether `Agent` stays the right foundation once a second and a third
  workspace-adjacent concept land, or whether `AgentHarness` already
  solves problems this project would otherwise rebuild piece by piece.
- What adopting `AgentHarness` would cost: its own session model
  (`SessionTree`, lanes), compaction, and tree navigation, none of which
  [`agent.md`](../docs/agent.md) or `session.ts` has a use for today.
- Whether `ToolContext`'s own resolution (`docs/workspace.md` §4) should
  become Ambion's own provider for `AgentHarnessOptions.toolContext`, if
  `Agent` is ever replaced by `AgentHarness`.

**Where.** `packages/ambion/src/activation.ts` and `seat.ts` hold today's
`Agent` imports; [`docs/workspace.md`](../docs/workspace.md) §4 and §6 are
where `ExecutionEnv` was adopted without adopting `AgentHarness`; Pi's
own `harness/agent-harness.ts` and `harness/types.ts`
(`@earendil-works/pi-agent-core`) define what `AgentHarness` actually is.

### 25. Roles as collaboration patterns

**What.** A seat today has one choice, attention: what wakes it. A role
would add what it does once awake: leader, reviewer, coordinator,
specialist. The patterns people already rely on in a meeting, written
down once and applied to a room.

**Why.** Attention decides who hears a message. It says nothing about
who answers first, who checks an answer, or who closes a question. Today
each agent's instructions hold that judgment alone. A role names the
pattern in one place, and a room composes patterns the way it composes
agents. At the limit, Ambion is the framework that defines the
collaboration patterns people and agents work in.

**What it needs deciding.**

- Whether a role is a seating choice, the way attention is, or a field on
  the agent. Attention belongs to the seating so that one agent can sit
  differently in two rooms, and a role is probably the same kind of thing.
- What a role changes: the seat's instructions, its attention, or the
  order the room wakes seats in. Only the first keeps the routing rule as
  one comparison ([`docs/agent.md`](../docs/agent.md) rule 6).
- Who assigns roles. The assistant never runs the room
  ([`docs/assistant.md`](../docs/assistant.md) §2), so assigning roles is a
  different seat's work, or the host's.

**Where.** `seated` in [`define.ts`](../packages/ambion/src/define.ts), the
roster in [`render.ts`](../packages/ambion/src/render.ts).
