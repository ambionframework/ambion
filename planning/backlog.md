# Backlog: after 0.2.0

Everything that is not in [next.md](next.md). Some items have a shape, some
are a decision to wait, and some are open pull requests to close or hold.
Nothing here blocks the 0.2.0 tag.

## Designs with a shape

**Tool execution provenance beyond the activation.** `ToolContext` carries
activation, exchange, and room since phase 2 step 11. A purpose field, a retry-safe
operation key derived by the kernel, and a demonstrated domain operation
reused across rooms wait for a consumer.

**Publishing `@ambionframework/evals`.** PR #153 adds room simulations with
human actors, judges, and offline regrading, 4,600 lines at alpha maturity
by its own work-left list: the failure matrix, live acceptance, judge
calibration, and the migration of twelve legacy variants. It stays private
until that list closes. Its harness re-implements the scripted stream and
polls for a quiet room; the 0.1.0 testing entry removes both.

**A durable subscription service across processes.** Subscriptions belong
to one running host in 0.2.0; a client that reconnects reads and reacquires
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

| PR   | Title                                           | Decision                                                 |
| ---- | ----------------------------------------------- | -------------------------------------------------------- |
| #151 | Exchange-scoped tasks and Relay background work | Retire in 0.2.0 phase 3; rebuilt by reference            |
| #153 | Room simulation evals (draft)                   | Land the closing-context slice; keep the package private |

**The Pi pair.** PR #113 and PR #114 each bump one half of
`pi-agent-core` and `pi-ai` to 0.85.1, so each lockfile resolves two
copies of `pi-ai` and the type checks fail. One pull request bumps both in
`ambion`, `cloudflare`, `pi-journal`, and `workspace`; the release notes
name no change to `Agent`, `StreamFn`, `AgentTool`, or `Session`. Run the
live tier once after the bump because 0.85.0 changes what an Anthropic
transport writes into replayed context, and confirm the workerd bundle size
with the new `chord` dependency. PR #111 and PR #112 are green; PR #5, #6,
and #7 are green; PR #4 needs a rebase.
