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

### 1. The room is a process global — closed

`host/runtime.ts` holds the clock, the session opener, the model call,
the catalog, the rooms that run and the workspace names that are taken.
`startSession`, `readSession` and `defineWorkspace` take a `Runtime` and
default to `defaultRuntime`, the one process-wide value. The default model
call alone reads `process.env`; a runtime with its own `stream` reads
nothing. `test/runtime.test.ts` proves two runtimes never see each other.

### 2. Nothing bounds the record, and the room rescans it per message

**What.** `foldRoom` folds the whole log again after every entry: the
people, the roster and the open exchange are each a pass over every
message. Every activation renders the whole record into the prompt through
`renderRecord`.

**Why.** Cost is O(n) per message and O(n²) over a run. Context grows
without limit. `docs/agent.md` §8 says Ambion owns no context window, and
`docs/assistant.md` §16 forbids a compactor, so today nothing owns it.

**Where.** `packages/ambion/src/room/fold.ts`, `foldRoom`;
`packages/ambion/src/room/presence.ts`, `foldPeople`;
`packages/ambion/src/render.ts`, `renderRecord`.

**Fix.** Short term: the fold keeps an index it advances per entry. Long
term: a window policy on `RoomView.record`, and a decision in the
contract about which module owns it.

### 3. `session.ts` holds four jobs — closed, with a remainder

**What was done.** The commit path lives in `log/log.ts`. The three tools,
`say`, `summarise` and `seat`, live in `seat/hands.ts`, and the seat side
of the wire runs an activation in `seat/seat.ts`. Every fact the room held
in memory is a fold in `room/fold.ts`, the decision is
`room/reconcile.ts`, and what an activation reads is `room/view.ts`. The
reserve is a fold, so it needs no module.

The room now has one reaction per log entry. The log calls `hear` for
every entry it takes after the replay, whether this run appended it or a
read found it, so `committed` and `heard` are one function and the
emissions that sat inside `end`, `close` and `claim` are gone. Those three
are writes and nothing else, and no caller threads a seat name into a
write to name the event it causes.

**What is left.** `session.ts` holds compose, route, hear, the seat's
three calls (`view`, `commit`, `lease`) and the reconcile glue, and it is
over the 600 lines `next.md` asked for. The seat's three calls are the
next piece to move: an `answers.ts` over a narrow interface on the room
(the log, the fold, the clock, `emit`).

**Where.** `packages/ambion/src/session.ts`.

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

**Where.** `packages/ambion/src/host/runtime.ts`, `registry()`.

**Fix.** Make `registry()` a dynamic import, or move default provider
resolution to the host. `streamFn` is already the extension surface.

### 5. `defineAgent` imports the shell runtime — closed

`BUILTIN_TOOL_NAMES` lives in `types.ts`, and the vocabulary imports
nothing that does anything: Biome refuses it
([`docs/toolchain.md`](../docs/toolchain.md) §1).

### 6. Two copies of typebox

**What.** Pi pins `typebox@1.3.7` exactly. The runtime and the example
declare `^1.3.18`. `defineTool` types parameters against one copy and Pi
validates with the other.

**Why.** It works today because schemas are plain objects. The split is a
latent break on the next typebox release that changes a type.

**Where.** `packages/ambion/package.json`, `examples/site/package.json`.

**Fix.** Match Pi's pin, or declare typebox as a peer dependency.

### 7. Test affordances leak into the runtime

**What.** `stubModel` returns `{ api: 'scripted' } as unknown as
Model<Api>` when a host passes a custom `streamFn`.

**Where.** `packages/ambion/src/host/runtime.ts`, `stubModel`.

**Fix.** Build a real `Model` value with Pi's own shape.

### 43. A draft in its backoff lets the room report quiet

**What.** `liveSeats` in `room/reconcile.ts` holds a seat live for a
pending wake whatever its backoff, and holds the assistant live for an
owed draft only once the backoff has passed. So a draft that failed
leaves the room reporting `quiet` for the length of the backoff, and
`quiet()` resolves, although the assistant still owes that person a
message and drafts again 30 seconds later.

**Why.** `SessionEvent.quiet` says what it means: "no seat is taking an
activation, and the assistant owes nobody a message". The second half is
untrue in that window, and `quiet()` is what a host waits on when it
wants the one message a person reads
([`docs/agent.md`](../docs/agent.md) §5).

**Where.** `packages/ambion/src/room/reconcile.ts`, `liveSeats`.

**Fix.** Hold the assistant live for every owed draft, the way a pending
wake holds its seat. It is one word in `liveSeats`, and it needs one
decision first: a live assistant is a seat `routing` will not wake, so a
question that opens an exchange during that window would not wake the
assistant to compose. That is already true of a draft that is due now,
so the change makes the window longer rather than new.

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

**Where.** `dispatch` in
[`session.ts`](../packages/ambion/src/session.ts), `handsFor` in
[`hands.ts`](../packages/ambion/src/seat/hands.ts), `wakes` in
[`seat.ts`](../packages/ambion/src/seat/seat.ts), the assistant's paragraphs in
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
[`assistant.ts`](../packages/ambion/src/room/assistant.ts).

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
[`packages/ambion/src/seat/seat.ts`](../packages/ambion/src/seat/seat.ts), `Attention` in
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

### 18. A test for the owed-summary merge — closed

Who is owed is a fold (`foldOwed` in `room/fold.ts`): a later close by the
same person joins the draft, and one message reaches back to the earliest
question still owed. `restart.test.ts` pins it, on both storages, across a
crash.

### 19. Exchanges are run state — closed

An exchange is a fold over the log: the open one is the first question
after the last close row, and every close is a row beside the messages.
See [`docs/exchange.md`](../docs/exchange.md) §5.

### 20. A second non-seat writer

The room owes summaries through one fold (`foldOwed` in `room/fold.ts`)
and one decision (`dueWakes` in `room/reconcile.ts`). If a room-level
compactor ever arrives ([`docs/assistant.md`](../docs/assistant.md) §16
forbids it by name today), it wants the same fold and the same decision.
Two writers is the point at which they should become their own module
rather than two functions beside the assistant's.

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

**Where.** `connectOver` in [`just-bash.ts`](../packages/ambion/src/tools/just-bash.ts).

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
[`just-bash.ts`](../packages/ambion/src/tools/just-bash.ts) is the shape to copy.

### 24. Whether Agent or AgentHarness is Ambion's foundation

**What.** Ambion's runtime imports Pi's lower-level `Agent` class
(`seat/activation.ts`, `seat/seat.ts`), not `AgentHarness`
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

**Where.** `packages/ambion/src/seat/activation.ts` and `seat/seat.ts` hold today's
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

### 26. The catalog is keyed by bare name, per runtime

**What.** The seat side resolves a definition by name through the
runtime's catalog (`seat.ts`). Every room a runtime holds writes its
definitions into that one map, so two rooms in one runtime that define the
same name differently share one entry, and the last room to start wins.
The log side no longer has this gap: the composition row and every seating
carry the identity, so a read reports what the run held.

**Why deferred.** The room already refuses a duplicate name inside one
roster. Two rooms in one runtime with one name and two definitions is a
host that wants two runtimes. The catalog exists so that a transport can
hand a seat in another process the definition it needs by name, and so
that `resumeSession` can resolve a roster it reads off the log.

**Options.** The runtime refuses a second, different definition under a
name it holds. Or the in-process transport hands the actor the room's own
definitions, and the catalog serves the out-of-process case alone. Either
way, a definition digest on the composition row and the claim lets a seat
tell that it runs the definition the room seated.

### 27. Lease rows grow with every activation — closed, with a remainder

Every `runtime.checkpoint.rows` rows the room writes an
`ambion/checkpoint`: the composition, the closes and the leases a later
fold still reads, behind a floor below which every wake was answered. The
log drops the rows the checkpoint replaced, so what a fold costs is the
rows since the last checkpoint, whatever the room's age.

**The remainder.** Three costs stand. The messages still grow without
bound, and every fold reads them all: item 2 holds that. A replay still
reads every entry the storage holds, because a checkpoint trims the cache
and never the storage; only the steady-state fold is bounded. And the log
keeps every lease id it has seen a row for, so that a row a read finds in
doubt is not read as the first row of its lease; that set grows with the
log.

### 28. A person present at a crash stays present until the host returns

**What.** A crash writes no `left`, so the fold says the person is present
until the host calls `leave()` on the resumed room. A host that never
returns leaves them present for ever: their divider never moves, and a
returning visit under a new identity is refused.

**Where.** `foldPeople` in `room/presence.ts`;
[`docs/presence.md`](../docs/presence.md) §6.

**Fix.** A host-side policy: the resumed room's host calls `leave()` for
everyone it does not hold a connection for. The runtime keeps no clock over
a visit, and should not start one.

### 29. Three attempts, then the summary or the wake is never tried again — closed, with a remainder

The fold reports every wake and every draft at the cap, with the attempts
that reached it, and the cap is the room's decision. `decide` returns the
attempt the room does not make, ended `abandoned`, and `session.ts`
writes it. The row answers the wake or the close it stood for, so no
reader sees the room still owing it. The host hears an `abandoned` event.

**The remainder.** No host verb resets the attempts for one close. A
person who wants the summary after the room gave up asks again, and the
next question opens an exchange of its own.

### 30. A lease the dead run held holds the exchange open until it expires

**What.** A resumed room cannot tell a lease a dead process held from one a
seat in another process still runs, so it waits for the expiry, sixty
seconds by default. The seats answer in the meantime; the close, and the
summary after it, wait for the expiry. `restart.test.ts` moves the clock
past it; a host on the system clock waits it out.

**Where.** `resumeSession` in `session.ts`; `expiries` in `room/reconcile.ts`.

**Fix.** A host that knows the whole run died passes that knowledge in:
`resumeSession(name, { revoke: true })` ends every running lease as
`revoked` at the first reconcile. A host that does not know keeps the
expiry.

### 31. A wake a seat at work heard through a steer alone is lost with a crash — closed

The log says who was at work when a message landed: a lease that holds a
row before it and ends, if it ends, after it (`pendingWakes` in
`room/lease.ts`). A message such a lease heard is pending again when the
lease came to nothing, so the seat is woken for it after the backoff.
`hosts.test.ts` pins it: a crash at every write of a scenario where a
seat's say wakes a peer, and the peer answers on the next run. The seat
side still hears a steer in memory; the log carries no `heard`.

### 32. Opening a name that does not exist creates it

**What.** `sessionsOver(repo).open(id)` creates a Pi session on every miss.
`resumeSession('typo')` and `readSession('typo')` create an empty session
before the first fails on the missing composition and the second returns
an empty record. On a JSONL repository the stray session is a directory on
disk, and `repo.list()` shows it from then on.

**Where.** `sessionsOver` in `host/runtime.ts`; `recover` in `session.ts`.

**Fix.** A second call on the opener, `find(id)`, that returns nothing on a
miss, or an option on `open`. `resumeSession` and `readSession` take the
one that creates nothing; `startSession` keeps the one that creates.

### 33. The random walk has no shrinker

**What.** `property.test.ts` runs a seeded walk of twenty steps and prints
the seed and the steps on failure. It does not shrink a failing walk to its
shortest form, and it does not generate from a model of the room.

**Fix.** A criterion for adopting `fast-check`: the first failure the walk
finds that takes more than an hour to reduce by hand.

### 34. A wake whose lease expired is never sent again — closed

A lease that expired or failed without a word answers nothing
(`pendingWakes` in `room/lease.ts`): the wake is pending again under the
next attempt's id, after the backoff, with the cap the summaries use. The
chaos sweep holds every answer to exactly once again, and
`restart.test.ts` pins the seat woken again on the next run. Item 29
stands for the cap: at three attempts the wake is dropped, and nothing
says so.

### 35. Two live hosts over one log corrupt it — closed

The run row is the fence (`RoomLog` in `log/log.ts`): every run writes
it first, every entry carries its writer, an entry of an earlier run past
a later run's row is void, and a run reads before every write, so it
learns it lost the name and drops itself with `superseded`.
`split.test.ts` and `hosts.test.ts` pin it, and `consistency.test.ts`
cuts a run with an append in flight.

**The remainder is closed on a storage that can refuse.** A session may
offer `appendAfter`: the log hands it the position its read left, and the
entry lands next to it or the storage says the record moved and writes
nothing. The SQLite storage offers it, in one statement that takes the
seq it asserts. A run fenced while its write waited is refused before it
acknowledges, so it loses nothing: `split.test.ts` runs the same split on
both storages and holds each to what it promises.

**What still stands.** A storage that cannot promise the refusal does not
offer it, and the fence voids what it takes: the run acknowledges the one
write it held. Pi's JSONL storage reads its own memory, so the fence does
not reach it at all: JSONL is a storage for one host. A read before every
write costs a scan of the entries since the last read, on every storage.

### 36. Every host in the tests shares one clock

**What.** A resumed host whose clock runs ahead of the last run's expires
the leases it inherited early; one that runs behind holds them past their
time. No test moves two clocks apart, and no test tears a JSONL tail or
loses an `fsync`.

**Where.** `test/consistency.test.ts`, `test/split.test.ts`;
[`docs/durability.md`](../docs/durability.md) §5.

**Fix.** A clock per host in the history harness, with a drift the
nemesis picks, and a storage fault that truncates the last line of the
file before a resume.

### 37. A lease fences messages, and it does not fence tool effects

**What.** A stale activation cannot commit a say, a summary or a seat.
The model runs custom tools and workspace tools before that commit. A
process partitioned from the room keeps running after its lease expired,
and the next attempt starts while the first still changes files or calls
an external API. Both attempts can complete the same effect.
[`planning/findings-distributed.md`](findings-distributed.md) F2.

**Where.** `seat/activation.ts`; `tools/workspace.ts`.

**Fix.** Pass the activation id, the attempt and the run id into every
tool context. A mutating tool takes an idempotency key. A workspace
service rejects an old run. Where a resource offers neither, the docs
state at-least-once effects.

### 38. The wire carries requests, and no configuration

**What.** `Transport.connect` receives a `RunningRoom` and a `Runtime`
that hold functions, catalogs and openers. A seat in another process
cannot be built from the wire alone, and an agent definition holds tool
functions that cannot cross JSON.
[`planning/findings-distributed.md`](findings-distributed.md) F3.

**Where.** `host/runtime.ts`; `seat/seat.ts`.

**Fix.** A seat service resolves a versioned agent definition by name,
with its tools, credentials, model and workspace client deployed beside
it. The wire carries identifiers and capability tokens.

### 39. A seat actor holds its state in memory

**What.** `SeatActor` holds the current activation, one queued wake,
the steer queue, the Pi agent and the renewal loop in memory, and the
room caches one port per seat. Two processes that answer for one seat
can both start work. [`planning/findings-distributed.md`](findings-distributed.md)
F4 and F5: the audit log of a seat has no activation id on its rows and
no exclusive writer either.

**Where.** `seat/seat.ts`; the audit session in `seat/activation.ts`.

**Fix.** One durable actor per room and seat, keyed by the run. One
audit stream per activation id, or an activation id and a stable index
on every audit row.

### 40. A workspace is unique in one runtime

**What.** The `taken` set and a handle's `destroyed` flag are process
memory. Two hosts can define the same name, and one can destroy a
directory another activation uses. The directory backend shares files
and fences nothing. [`planning/findings-distributed.md`](findings-distributed.md)
F6.

**Where.** `tools/workspace.ts`; `host/runtime.ts`.

**Fix.** A workspace service keyed by name, with a lifecycle generation
that connect and every mutation present.

### 41. Events and completion belong to one run

**What.** Listeners, waiters and the wake timestamps are memory. A
restart loses subscribers, and a client can miss `message`,
`exchange_closed`, `error` or `quiet` while it reconnects. `settled()`
and `quiet()` resolve early on a run that is gone.
[`planning/findings-distributed.md`](findings-distributed.md) F7.

**Where.** `session.ts`.

**Fix.** Status reads off the record with a durable cursor, so a client
that reconnects reads what it missed.

### 42. The crash sweep counts one activation end too many

**What.** `pnpm chaos` fails now and then on the crash sweep. The
invariant that every `activation_end` has a start, or a lease the run
inherited, sees one end more than it counts starts. It reproduced on
`jsonl`, "before the entry lands", at write 5 of 42, in about one run in
three, and only with all five sweep files in one vitest run. The CI gate
never saw it: `pnpm check` runs the sweeps at their small seed count.
Either the room emits a second end for one lease, or the resume counts
what it inherited too low.

**Where.** `test/support/invariants.ts` line 64; `test/support/chaos.ts`
`inherited`; `session.ts` `end`.

**Fix.** Print every lease row and every activation event of the failing
run, and say which lease has the extra end. Then fix the room or the
count.
