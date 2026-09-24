# Backlog: after 0.2.0

Everything that is not in [next.md](next.md). The first section is the
scope for 0.3.0. Every other item names the condition that brings it into
a release. Nothing here blocks the 0.2.0 tag.

## 0.3.0: the room works between questions

**0.3.0 makes a room useful between questions.** An event or a clock wakes
it, and it hands work to another room. The work starts on the kernel that
0.2.0 tags, because 0.2.0 changes the same room files and the same rules
file. After the 0.2.0 tag, this section moves into [next.md](next.md) with
phases, steps, and evidence.

| Theme                     | Acceptance                                                                                                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W Wake sources            | A room wakes a seat on a notice from a resource and on a timer that the journal records. A restart re-arms every timer. An `awaiting` exchange expires on a stated bound.                      |
| D Delegation by reference | A working room is a room. A message that carries a ref to it delegates the work. The origin exchange awaits the working room, and one message with a ref returns the result. No task database. |

**Three format changes.** Each change lands with a golden journal of the
new shape, and the changelog names each one.

| Change                                  | Item | Kind                       |
| --------------------------------------- | ---- | -------------------------- |
| The notice message kind                 | W1   | A new message union member |
| The timer entry                         | W2   | A new entry kind           |
| An `awaiting` outcome that names a room | D1   | A new outcome union member |

**The order is the notice, the timer, then the delegation.** The notice
host call needs the notice kind, the timer needs the host call, and the
delegating message needs the notice. The Cloudflare adapter runs a timer
through its alarm after the timer lands.

**Decisions taken for 0.3.0.**

- **A notice is the scheduler ingress.** The application owns its
  schedule and delivers a notice through one host call. The kernel adds no
  scheduler.
- **The journal records a timer, and the host runs it.** The host owns the
  clock. A restart reads the timer entries and arms them again.
- **Delegation has no task database.** A working room is a room, and a ref
  connects the two.
- **W2 decides `exchangeOutcome`.** If the `awaiting` expiry writes on the
  `awaiting` outcome, the rule gates a write and stays verified. Otherwise
  it leaves the rules file, as the 0.2.0 M2 sweep states for read views.

**W1. A notice from a resource.** A room wakes only when a person speaks,
so an agent cannot react when a brief changes or a run completes. Add a
message kind with a ref and no author, routed by attention. One host call
delivers it with a stable key, so a retried delivery lands once. An
application scheduler calls the same host call, so the kernel needs no
scheduler of its own. A notice opens no exchange by itself and arrives
through no hidden timeout. **Evidence:** a scripted test and a chaos case
for the kind and for the host call, with its durable start and its restart
semantics.

**W2. A timer that the journal records.** Nothing wakes a room on a clock,
and an `awaiting` exchange waits for ever. A timer entry records the due
time and the wake it owes. The host arms it and writes the wake when it is
due. A restart reads the open timer entries and arms them again, so a
crash loses no timer. The `awaiting` expiry is a timer that the close
schedules. The Cloudflare adapter runs a timer through its alarm, and a
measurement records the resume cost of a room with many timer wakes.
**Evidence:** a kill between the timer entry and the wake keeps the wake;
the docs that call timers future work say what shipped.

**D1. Delegation by reference.** PR #151 stored tasks in the journal and
scanned every task on each reconcile pass. Use a ref and the `awaiting`
outcome. The delegating message carries a ref to
`ambion://room/<working>/message/<from>`. The origin exchange closes as
`awaiting` that room. The working room closes with one message that
carries a ref back. Status is a read of the exchange that the referenced
message opened. **Evidence:** the workbench delegates one question to a
second room; a restart in the middle keeps the work. Then close PR #151
with a comment that names the new route.

## Designs with a shape

**The checkpoint entry.** A checkpoint entry lets a resume skip settled
history, and full replay stays the reference. It is a format change, so it
lands with a golden journal of the new format. **Condition:** the resume
measurement of 0.3.0 item W2 comes near the default
`limits.lease.ttl` of 60 seconds ([envelope.md](../docs/envelope.md)). Past
that point, replay sets the recovery time.

**Tool execution provenance beyond the activation.** `ToolContext` carries
the activation, the exchange, and the room. A purpose field, a retry-safe
operation key that the kernel derives, and a domain operation reused across
rooms wait. **Condition:** an application that needs one of the three.

**An `apply_patch` tool for Codex seats.** A Codex seat under
`nativeTools: 'none'` reaches files through the workspace `edit` tool, a
block-replace tool built for Pi. The Codex catalog patch removes
`apply_patch`, the tool Codex models are trained to call, so every edit
goes through a call shape the model was not tuned on. `@openai/agents-core`
exports `applyDiff`, a pure TypeScript function, MIT licensed, that parses
and applies one file section of the same patch grammar with no file I/O of
its own. What remains is an envelope parser for the full patch (`Add
File`, `Delete File`, `Update File`, `Move to`) and a tool that writes
each section through `FileSystem`, the interface `edit` already uses.
Such a tool then works on the memory backend, the directory backend, and
the workstation alike. A shell command such as `patch` or `git apply`
reads a different grammar, and only the workstation runs a real one, so it
buys the tool nothing that `FileSystem` and `applyDiff` do not already
give it. OpenAI's own Rust crate, `codex-rs/apply-patch`, holds the ground
truth grammar; a Python binding ships on PyPI as `codex-apply-patch`, but
neither reaches Node without a WASM build. **Condition:** a live
comparison of the `edit` tool against an `apply_patch` prototype, on the
same editing task, shows a real gain in tool-call success for a Codex
seat. Build the tool only after that measurement.

**The evals package.** PR #153 adds room simulations with human actors,
judges, and offline regrading: 8,455 lines at alpha maturity by its own
list of open work. That list holds the failure matrix, live acceptance,
judge calibration, and twelve legacy variants. Its harness re-implements
the scripted stream and polls for a quiet room, and the 0.1.0 testing entry
removes both. **Condition:** a live-eval budget and an owner for the
calibration. The package then starts again from main on the testing entry.

**A durable subscription service across processes.** Subscriptions belong
to one running host. A client that reconnects reads and reacquires its
handles. **Condition:** a placement that serves one room from more than one
process.

**A generated API reference.** One reference per entry, with a CI check
that fails when it is stale. **Condition:** an adapter or host author who
cannot work from the typed README examples and the export snapshot.

**A SQL backend over a database server.** `backend.sql` takes any
`SqlBackend` ([Workspace](../docs/workspace.md#query-the-shared-database)),
and the package ships `sqliteBackend`. A backend over a database server
connects as each agent with its own credential, so the server enforces the
grants. It passes `sqlConformance`. **Condition:** the lab setup, one workstation and
one database server, is scheduled.

**A backend profile and concurrent operations.** A backend declares its
isolation, its network, and whether the owner may run operations from two
agents at once. The owner then keeps one queue for each agent. The same
design decides which identity writes the audit log. It builds on
the workspace interface of 0.2.0 item M7. **Condition:** a workstation
run where one agent's command delays another agent's file tool.

## Proofs to write

[docs/formal.md](../docs/formal.md) states the mechanism and the line a
proof must pay for. These proofs are open, and none removes a known defect.

| Proof                 | What it states                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| The stop-loop measure | A measure that the stop loop decreases                                                          |
| The pass measure      | A measure that each reconciliation pass decreases, so the `PASSES` bound is a proof             |
| Unique roster names   | `reseated` and `foldRoster` keep one seat per name                                              |
| `seatLive`            | The seats that are live now, as a rule beside `exchangeLive`                                    |
| `storedIdAccepted`    | The kinds on which `validate.ts` reads an activation id; a refusal on others is a schema change |

The chaos drain and the walk's `drained` check witness the two measures
today. **Condition:** a fault that one of them would have caught.

## Deferred by decision

- Hot-loaded definitions; the definition set is fixed per run.
- Multiple simultaneous discussions within one room; separate rooms.
- Per-tab presence tokens and automatic departures; hosts reconcile.
- Distributed workspace ownership; one owner per resource.
- Automatic summary skipping by message count; manual summary retry.
- Exchange budgets; deadlines and caps bound activations only.
- Agent source retrieval and pagination under the shared summary policy.
- Browser-only execution, a managed service, arbitrary edge platforms,
  turnkey deployment commands, multiple terminal clients.
- A `SeatObject` class rename in the Cloudflare adapter; it needs
  Durable Object migration evidence.
- The lease `since` in `room/rules.verified.ts` keeps its name until a
  proof edit renames it.
- A provider-neutral plugin ecosystem beyond the executor contract.
- A second live-tier provider job. Add one only if a provider-specific
  defect turns up.

## Open pull requests

| PR   | Title                                           | Decision                                                    |
| ---- | ----------------------------------------------- | ----------------------------------------------------------- |
| #151 | Exchange-scoped tasks and Relay background work | Close in 0.3.0 item D1; delegation by reference replaces it |
| #153 | Room simulation evals (draft)                   | Hold; see the evals package above                           |
| #171 | Workspace log regression and path checks        | Carry onto main, then land in 0.2.0 item M4 first           |
