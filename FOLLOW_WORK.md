# Follow-up work

Work this branch decided not to do, and why it is worth doing. Each item says
what it is, what it costs, and where the reasoning already lives. The design
contracts in [`docs/`](docs) hold the open questions about a design; this file
holds the work.

## Steering an exchange from what a person holds

**What.** An assistant's preferences shape one message, and they shape it after
the work is done. The same preferences could aim the room while it works.
Sam never reads contract terms, so three seats spending an activation on
them is money his assistant already knew to save. The rule is deterministic: it
reads what a person holds and what a message is, so the room can run it as
a check, and it costs no activation.

**Why.** The preferences are in one place already
([`docs/assistant.md`](docs/assistant.md) §2), and today they reach the room only at
the close. A person who has said what they act on has said something the
room could use while it is still deciding what to say. It is also the
cheapest of the three rungs in §12: a check costs nothing, and rung 3 pays
for an activation.

**What it needs deciding.**

- **Whether the assistant is the right holder.** A deterministic rule is not a
  seat, and the assistant is a seat. The rule could be a field on the person that
  the room reads when it builds a context, which keeps every invariant below
  intact. The argument for the assistant is that a person's preferences belong in
  one place. The argument against is that a seat that never runs is a
  strange home for a check.
- **Which invariant it touches.** Three hold today: an assistant is seated
  `none`, `handsFor` gives it empty hands outside a close, and `wakes`
  refuses to wake anybody for what an assistant writes. A steer that reaches a
  running seat as a `[new]` line touches the third, because the room would
  carry an assistant's words to a seat that did not ask for them.
- **What it may steer.** Rule 2 says what arrives mid-activation is steered
  in and changes nothing else. A preference that suppresses a line is a
  different act from one that adds one, and only the second is a steer.
- **What a seat is told.** A seat that is aimed and does not know it will
  argue with the room. The paragraph that explains a fold
  (`SUMMARY_PARAGRAPH`) is the precedent.

**Where.** `dispatch` and `handsFor` in
[`session.ts`](packages/ambion/src/session.ts), `wakes` in
[`seat.ts`](packages/ambion/src/seat.ts), the assistant's paragraphs in
[`render.ts`](packages/ambion/src/render.ts).

## Reseating: attention that a running room can change

**What.** A seat's attention is chosen when the agent is seated and never
moves. `session.reseat(name, attention)` would let a host widen or narrow one
while the room runs.

**Why.** Attention is now the whole of what a seating decides
([`docs/agent.md`](docs/agent.md) rule 6): one widening scale, and one
comparison against a message's reach decides who wakes. Everything that reads
it already reads it per activation, so a seat that changes point costs nothing
to route.

It is also what [`docs/assistant.md`](docs/assistant.md) §12's rung 3 wants. An assistant is
a seat at `none`; letting it take part in an exchange is a wider attention and
a `say` in its hands. With reseating that is a host's decision — _this room
lets assistants speak_ — rather than a code change in the runtime.

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
- **What an assistant holds when something else wakes it.** Nothing, today:
  `handsFor` gives an assistant the `summarise` tool for the activation a close
  woke it
  for, and empty hands otherwise, so a wider attention alone buys a seat that
  reads the room and ends its activation. Rung 3 is a `say` added there on purpose,
  with the paragraph that says when waking somebody's assistant is worth the money.

**Where.** `wakes` in
[`packages/ambion/src/seat.ts`](packages/ambion/src/seat.ts), `Attention` in
[`types.ts`](packages/ambion/src/types.ts), `seated` in
[`define.ts`](packages/ambion/src/define.ts).

## Waking an assistant costs money, and nothing says when it is worth it

Once an assistant is reachable (above), a product can wake one. The runtime's
prompt tells a seat that "attention costs money" for a directed say, and says
nothing about when somebody's assistant is the right participant to ask. Rung 3
without that paragraph is a room that pays for assistants it did not need.

## An assistant in every seat's roster

An assistant is a seat, so it is in the roster every seat reads: measured at about
480 characters of a seat context averaging 3,800 in the example — 13%, spent
describing seats that today cannot be addressed. Most of it is the example
repeating a verbose `identity` three times, so the first fix is in
[`examples/site/src/room.ts`](examples/site/src/room.ts) rather than
in the runtime. Worth re-measuring once assistants speak.

## A test for the owed-summary merge

`Assistants.owe` merges a person's owed range with `Math.min`, so somebody owed a
summary from a failed activation who asks again gets one message covering
both
exchanges. Nothing pins that behaviour; the tests cover the failure and the
retry separately. See [`docs/assistant.md`](docs/assistant.md) §5.

## Exchanges are run state

`Exchanges` holds the open exchange in memory, so a restart begins with none —
right for a room mid-question, and a limit for anything that wants to work
over past exchanges. A closed exchange is an owner and a range, so it is
derivable from the record; nothing derives it today. See
[`docs/exchange.md`](docs/exchange.md) §5.

## A second non-seat writer

The room owes summaries through a small scheduler: `owe`, `activationsDue`
and `activationEnded`, held by `Assistants`. If a room-level compactor ever arrives
([`docs/assistant.md`](docs/assistant.md) §16 forbids it by name today), it wants the
same scheduler. Two writers is the point at which it should become its own
thing rather than three fields on the session.

## A credentials boundary for tool calls leaving the workspace

**What.** [`docs/workspace.md`](docs/workspace.md) §1 draws the workspace's
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
([`docs/workspace.md`](docs/workspace.md) §1, §8) has no answer for a tool
that calls out to a real API, and a real deployment needs one before it
hands an agent anything with network access.

**What it needs deciding.**

- Whether this is a workspace concern (a third kind of persistent entity,
  under [`docs/workspace.md`](docs/workspace.md) §1's model) or a separate
  primitive entirely.
- What a sidecar proxy actually mediates: a network path every outbound
  call is forced through, or a narrower set of tools the workspace marks
  as external.
- Whether a token is minted per call, per activation, or per agent, and
  what a "short-lived" window actually is.
- How this interacts with `ToolContext`
  ([`docs/workspace.md`](docs/workspace.md) §4) and `defineTool`'s own
  `execute` shape (`docs/agent.md` §3), neither of which takes any notion
  of a credential today.

**Where.** [`docs/workspace.md`](docs/workspace.md) §1 names the boundary
and scopes it out to this entry; `ToolContext` in
[`docs/workspace.md`](docs/workspace.md) §4 is the most natural place for
a credential to reach a tool call now, alongside `defineTool`'s `execute`
in [`docs/agent.md`](docs/agent.md) §3.

## A calendar form for reminders

**What.** `remind` takes a time, a delay and a rate: `at`, `after` and
`every` ([`docs/reminder.md`](docs/reminder.md) §2). _Every weekday at
07:00_ is a calendar rule, and none of the three writes it. A cron
expression is the usual form.

**Why.** A product that opens the day with a check wants one reminder that
knows about weekends. Without a calendar form it sets one for every morning
and reads its own reminder on Saturday.

**What it needs deciding.**

- A parser of Ambion's own, or a dependency. `agent.md`'s code rules push
  a third concern into a dependency, and a cron library is a small one.
- Which time zone a calendar rule keeps. `at` is ISO with an offset; a cron
  expression has none, and the room's clock is UTC.
- Whether the same field carries both forms, or a fourth field joins the
  three.

**Where.** `draftReminder` and `nextDue` in
[`reminder.ts`](packages/ambion/src/reminder.ts); the `ReminderInput` shape
in [`types.ts`](packages/ambion/src/types.ts).

## Tasks: the entity a reminder is not

**What.** [`docs/workspace.md`](docs/workspace.md) §11 names tasks beside
reminders as the second entity kind a workspace holds. A reminder is
delivered and done. A task is state that outlives its deliveries, with a
completion that enters the room as a message, the way
[`README.md`](README.md) names a task completing as an event source.

**Why.** The reminder is built and proves the shape: a store behind the
backend, a clock on the run, a message kind with a reach, and a tool bound
beside the four. A task reuses every one of those and adds the state.

**What it needs deciding.** What a task holds between deliveries, who may
complete one, and whether a completion wakes the owner alone the way a
reminder does.

**Where.** [`reminder.ts`](packages/ambion/src/reminder.ts) is the shape to
copy; `Workspace` in [`types.ts`](packages/ambion/src/types.ts) takes a
third property.

## `/dev/null` on the just-bash backends is a file

**What.** just-bash treats `/dev/null` as a plain file. A command that
redirects into it appends to it, and on `directoryBackend` the redirect
creates `dev/null` under the root, on disk
([`docs/workspace.md`](docs/workspace.md) §8). The first live run of the
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

**Where.** `connectOver` in [`just-bash.ts`](packages/ambion/src/just-bash.ts).

## A backend on a real machine

**What.** A `WorkspaceBackend` whose `connect` creates a real OS user when
one is absent and returns an `env` whose `exec` runs as that user through a
real user switch. [`docs/workspace.md`](docs/workspace.md) §10 sketches it
and commits to nothing.

**Why.** The just-bash backend's boundary is nominal
([`docs/workspace.md`](docs/workspace.md) §8): one instance, one identity,
and nothing stops one agent's `bash` call from reading another's home. A
real user turns that into isolation the operating system enforces, the
guarantee a multi-user Linux box gives. The shape is already fixed: two
functions, `connect` and `destroy`, and `connect` takes the tool call's
abort signal because `useradd` and a process spawn are real waits.

**What it needs deciding.**

- How an OS user is named from an agent's `name`, and what happens when two
  workspaces on one host provision the same name
  ([`docs/workspace.md`](docs/workspace.md) §7 accepts the collision and
  checks nothing).
- What `destroy` removes: the users, their homes, or both.
- Whether Pi's `NodeExecutionEnv` is the `env`, with a `sudo -u` prefix on
  every command, or whether the backend spawns as the user itself.

**Where.** `WorkspaceBackend` in
[`types.ts`](packages/ambion/src/types.ts); `directoryBackend` in
[`just-bash.ts`](packages/ambion/src/just-bash.ts) is the shape to copy.

## Whether Agent or AgentHarness is Ambion's foundation

**What.** Ambion's runtime imports Pi's lower-level `Agent` class
(`activation.ts`, `seat.ts`), not `AgentHarness`
(`@earendil-works/pi-agent-core`'s `harness/agent-harness.ts`) — a
heavier engine Pi ships beside it, with its own session tree, lanes,
compaction, and tree navigation. Nobody chose `Agent` over `AgentHarness`
on purpose; it is what the runtime already used before this question was
ever asked.

**Why.** [`docs/workspace.md`](docs/workspace.md) §6 reuses part of what
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
closer still is a real possibility now that reminders
(`docs/reminder.md`) hold a clock on the run, and once tasks
(`docs/workspace.md` §11) or anything with its own turn-scoped state
joins them.

**What it needs deciding.**

- Whether `Agent` stays the right foundation once a second and a third
  workspace-adjacent concept land, or whether `AgentHarness` already
  solves problems this project would otherwise rebuild piece by piece.
- What adopting `AgentHarness` would cost: its own session model
  (`SessionTree`, lanes), compaction, and tree navigation, none of which
  [`agent.md`](docs/agent.md) or `session.ts` has a use for today.
- Whether `ToolContext`'s own resolution (`docs/workspace.md` §4) should
  become Ambion's own provider for `AgentHarnessOptions.toolContext`, if
  `Agent` is ever replaced by `AgentHarness`.

**Where.** `packages/ambion/src/activation.ts` and `seat.ts` hold today's
`Agent` imports; [`docs/workspace.md`](docs/workspace.md) §4 and §6 are
where `ExecutionEnv` was adopted without adopting `AgentHarness`; Pi's
own `harness/agent-harness.ts` and `harness/types.ts`
(`@earendil-works/pi-agent-core`) define what `AgentHarness` actually is.
