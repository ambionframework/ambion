# The lifecycle tool

**A lifecycle tool is an ordinary tool that the room calls at an exchange
boundary.** An application annotates a tool with `lifecycle: 'open'` or
`lifecycle: 'close'`. The room calls an `open` tool once when an exchange
opens. The room calls a `close` tool once before an exchange closes. The
tool's recorded result becomes a room fact.

**Status: proposed design. The runtime does not implement it yet.**
[`planning/next.md`](../planning/next.md) owns the work and its evidence.
Read [`exchange.md`](exchange.md), [`agent.md`](agent.md), and
[`workspace.md`](workspace.md) first. This page states nothing that those
contracts already state; see [`README.md`](../README.md) for the positioning.

## The principle

**The room closes an exchange on quiescence.** Quiescence means no seat has
work left. The room derives it from leases and pending wakes, then appends a
close. [`exchange.md`](exchange.md) defines the fold.

**Quiescence and completion are separate facts.** A working group can fall
silent with the work half done. The room reads the silence today. It has no
reading of whether the work is complete.

**A lifecycle tool closes that gap.** The working group states what "done"
means through a tool. The room calls that tool at the close boundary and
reads its answer. A group also seeds shared state through a tool the room
calls at the open boundary.

## The annotation

**One field on a tool binds it to a boundary.** The `defineTool` shape gains
an optional `lifecycle` field. A tool without the field keeps its current
behavior: an agent calls it during an activation.

| Binding  | The room calls the tool          | The tool's result       |
| -------- | -------------------------------- | ----------------------- |
| `open`   | Once, when the exchange opens    | Recorded room facts     |
| `close`  | Once, before the exchange closes | A close decision        |
| _(none)_ | Never; an agent calls it         | An ordinary tool result |

```ts
const checkMachine = defineTool({
  name: 'check_machine',
  lifecycle: 'close',
  description: 'Report whether the exchange reached a terminal state.',
  parameters: Type.Object({}),
  execute: (_params, ctx) => {
    const machine = foldMachine(ctx.exchange);
    if (!machine || machine.terminal) return { done: true };
    return { done: false, feedback: `State ${machine.state} is not terminal.` };
  },
});
```

**The room calls the tool; no seat and no model run.** The room runs the
tool's `execute` and records the result. A lifecycle tool reads the room's
journal projection and the clock. It reaches a workspace resource only under
a configured identity. The result stays the room's record of the boundary.

## The close decision

**A `close` tool returns done or continue.**

```ts
type CloseDecision = { done: true } | { done: false; feedback: string; to?: string };
```

- **`{ done: true }`** lets the close proceed. The room appends the close and
  records the decision on it.
- **`{ done: false, feedback }`** defers the close. The room records the
  `feedback` as a message. The existing attention rules route it. A `to`
  field addresses one participant.

**The routing target decides what continues.** Feedback addressed to seated
agents wakes them under the attention scale, so the group continues the
work. Feedback addressed to the person who owns the exchange reads as
awaiting that person. The room adds no routing rule for this; it reuses the
one in [`roster.md`](roster.md) and [`presence.md`](presence.md).

**A deferral is bounded, so an exchange cannot hang.** Two rules hold the
bound:

1. The room defers a close at most `limits.closeDefer` times for one
   exchange.
2. The room re-attempts a close only when the record moved since the last
   attempt. A close with no new entry proceeds.

Together these rules guarantee termination. A deferral needs new entries,
and the count has a ceiling. After the ceiling, the room closes and records
the incomplete decision as the outcome.

## The open decision

**An `open` tool seeds exchange-scoped state.** The room calls it once when a
person's question opens the exchange. The tool writes the entries the group
needs from the start, such as a default state machine or a checklist. Its
effect is the entries it records.

## Determinism and replay

**The recorded result is the authority.** The room records a lifecycle
tool's result as an entry, keyed by the exchange, the tool, and the boundary
position. A replay reads that entry. The room does not call the tool again.

**This keeps the room's promise.** [`durability.md`](durability.md) states
that a resume is a replay of the journal. A lifecycle tool affects the room
through its recorded result, so a resumed room reaches the same close
decision without running the tool. The idempotent-write rules in
[`durability.md`](durability.md) land each result once under a retry.

## What stays unchanged

- **Attention and membership.** A lifecycle tool wakes no seat by itself. Its
  feedback routes under the existing scale.
- **The say lock.** Speech keeps its freshness check. A lifecycle tool adds
  no lock to conversation.
- **The summary.** A configured summary writer keeps its dedicated closing
  activation. It runs after the close is durable. A `close` tool runs before
  the close. See [`summary.md`](summary.md).
- **The trace.** A lifecycle tool's call records its steps like any tool
  call, so a reader drills into it the same way.

## The first client: an exchange state machine

**A state machine shows the annotation at work.** The machine is an
exchange-scoped artifact that records where the work stands. The working
group defines it and advances it. The room checks it at close.

- **`define_machine`** is an ordinary agent tool with upsert semantics. The
  first call creates the machine. A later call replaces the definition. The
  replacement keeps the current state legal, or it names an explicit reset
  state, or the room refuses it.
- **`transition`** is an ordinary agent tool. The room accepts a move that
  the definition allows from the current state, and refuses a stale or
  illegal move with the current state and the allowed moves.
- **`check_machine`** is a `close` tool. It returns `done` when the machine
  reaches a terminal state. It returns `continue` with the gap when the
  machine stands short of one.

**The machine steers no seat.** A `transition` records a fact and wakes
nobody. Only `check_machine` produces feedback, once, at the close boundary,
under the bound above.

## What this design is not

- **Not a hook system.** The unit is a tool. An annotation binds a tool to a
  boundary. The room reads annotations from the active tool set. The room has
  no separate lifecycle registry.
- **Not a scheduler.** A lifecycle tool fires on an exchange boundary that
  the journal already records. It fires on no clock and no external event.
  Native timers and event ingress remain future work; see
  [`planning/backlog.md`](../planning/backlog.md).
- **Not a task database.** The room folds the recorded results. It stores no
  status record, owner, or subscription.
- **Not a role system.** An annotation grants no authority. The room checks
  activation, lease, recipient, and consumed context at every commit.

## Open questions

- **The default for `limits.closeDefer`.** One deferral proves the mechanism.
  A small ceiling above one gives the group more chances. The plan sets the
  default with the first client.
- **A workspace-reading close tool.** The first client reads the journal
  projection. A close tool that reads a workspace resource needs a configured
  identity and the same recorded-result rule. The plan adds it when a client
  needs it.
- **The summary as a `close` tool.** The summary writer predates this design.
  A later change may express it as a `close` tool. This design keeps the
  summary as it stands until then.
