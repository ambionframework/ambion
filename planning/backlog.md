# Backlog: after 0.1.0

Everything that is not in [next.md](next.md). Some items have a shape, some
are a decision to wait, and some are open pull requests to close or hold.
Nothing here blocks the tag.

## Designs with a shape

**Delegation by reference, with no task database.** PR #151 represents
delegation as a task record with status, owner, subscriptions, and event
history in the journal, a working-room registry, and a protocol extension;
its review found unbounded `taskChanges` scanned on every reconcile pass,
`lastSeq` advanced by a non-message entry, an uncapped retry that holds an
exchange open, and a `stop()` that cancels every open task. The 0.2 shape
builds on references and the awaiting outcome: a working room is a room;
the delegating message carries a ref to
`ambion://room/<working>/message/<from>`; the origin exchange is
`awaiting` the working room's owner; when the working room closes, the
host delivers one message with a ref back, and attention routes it. Status
is a read of the exchange the referenced message opened. Rebuild it on the
incremental fold.

**A notice from a resource.** The first event ingress: a message kind with
a ref, no author, and routing by attention, so an agent wakes when the
brief changes or a run completes. It needs a durable start and restart
semantics, and it must not arrive through a hidden timeout.

**Native timers, external subscriptions, scheduler ingress.** The room
stays available between interactions; the mechanism that wakes it on a
clock or an external event is future work. A timer also expires an
`awaiting` exchange.

**A bounded projection with checkpoints.** The incremental fold keeps full
replay as the reference. A checkpoint entry that lets a resume skip
settled history is a later format change.

**Tool execution provenance beyond the activation.** `ToolContext` carries
activation, exchange, and room since phase 2 step 11. A purpose field, a retry-safe
operation key derived by the kernel, and a demonstrated domain operation
reused across rooms wait for a consumer.

**A published Codex adapter.** `examples/codex` covers the surface. The
package waits for a consumer that needs the stdio room tools server as a
dependency.

**Publishing `@ambionframework/evals`.** PR #153 adds room simulations with
human actors, judges, and offline regrading, 4,600 lines at alpha maturity
by its own work-left list: the failure matrix, live acceptance, judge
calibration, and the migration of twelve legacy variants. It stays private
until that list closes. Its harness re-implements the scripted stream and
polls for a quiet room; 0.1.0's testing entry removes both.

**Automatic admission expiry for unclaimed work.** A wake that no executor
claims stays pending while eligible. Expiry after a bound needs an explicit
durable start; it must not be a hidden timeout.

**A durable subscription service across processes.** Subscriptions belong
to one running host in 0.1.0; a client that reconnects reads and reacquires
handles.

## Deferred by decision

- Hot-loaded definitions; the definition set is fixed per run.
- Multiple simultaneous discussions within one room; separate rooms.
- Per-tab presence tokens and automatic departures; hosts reconcile.
- Distributed workspace ownership; one owner per resource.
- Automatic summary skipping by message count; manual summary retry.
- Exchange budgets; deadlines and caps bound activations only.
- Agent source retrieval and pagination under the shared summary policy.
- Browser-only execution, a managed service, arbitrary edge platforms,
  turnkey deployment commands, CLI remote authentication, multiple
  terminal clients, live activity transport in the CLI.
- A `SeatObject` class rename in the Cloudflare adapter.
- The lease `since` in `room/rules.verified.ts` keeps its name until a
  proof edit renames it.
- A provider-neutral plugin ecosystem beyond the executor contract.
- A second live-tier provider job; Pi's transport is expected to keep
  behavior provider-neutral. Add one only if a provider-specific defect
  turns up.

## Pull requests to close or hold

Nine pull requests from 2026-09-01 to 2026-09-11 conflicted with main, and
main delivered the aim of each by another route: #73, #67, #63, #60, #58,
#48, #44, #40, and #28 are closed, each with a comment naming the route.
Two remain open.

| PR   | Title                                           | Decision                                                          |
| ---- | ----------------------------------------------- | ----------------------------------------------------------------- |
| #151 | Exchange-scoped tasks and Relay background work | Hold; rebuilt by reference above                                  |
| #153 | Room simulation evals (draft)                   | Land the closing-context slice in 0.1.0; keep the package private |

**The Pi pair.** PR #113 and PR #114 each bump one half of
`pi-agent-core` and `pi-ai` to 0.85.1, so each lockfile resolves two
copies of `pi-ai` and the type checks fail. One pull request bumps both in
`ambion`, `cloudflare`, `pi-journal`, and `workspace`; the release notes
name no change to `Agent`, `StreamFn`, `AgentTool`, or `Session`. Run the
live tier once after the bump because 0.85.0 changes what an Anthropic
transport writes into replayed context, and confirm the workerd bundle size
with the new `chord` dependency. PR #111 and PR #112 are green; PR #5, #6,
and #7 are green; PR #4 needs a rebase.
