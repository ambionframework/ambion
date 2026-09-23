# Backlog: after 0.2.0

Everything that is not in [next.md](next.md). An item with a shape names
the condition that brings it into a release. Nothing here blocks the 0.2.0
tag.

## Designs with a shape

**The checkpoint entry.** A checkpoint entry lets a resume skip settled
history, and full replay stays the reference. It is a format change, so it
lands with a golden journal of the new format. **Condition:** the resume
measurement from 0.2.0 phase 2 step 4 comes near the default
`limits.lease.ttl` of 60 seconds ([envelope.md](../docs/envelope.md)). Past
that point, replay sets the recovery time.

**Tool execution provenance beyond the activation.** `ToolContext` carries
the activation, the exchange, and the room. A purpose field, a retry-safe
operation key that the kernel derives, and a domain operation reused across
rooms wait. **Condition:** an application that needs one of the three.

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

**A workstation backend.** A workspace backend over SSH to one remote
server. PR #268 holds the scope. **Condition:** the owner schedules it.

**A shell backend and a SQL backend.** A workspace opens a shell backend,
a SQL backend, or both, each under its own owner. A SQL backend connects
as each agent with its own credential, and the database server enforces
the grants. `openSqlResource` becomes a tool policy over any SQL backend.
[docs/backends.md](../docs/backends.md) holds the design. **Condition:**
the owner schedules the lab setup: one workstation and one database
server.

**A backend profile and concurrent operations.** A backend declares its
isolation, its network, and whether the owner may run operations from two
agents at once. The owner then keeps one queue for each agent. The same
design decides which identity writes the audit log. It builds on
the workspace interface of 0.2.0 item M7. **Condition:** the workstation
backend is scheduled.

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
| #151 | Exchange-scoped tasks and Relay background work | Close in 0.2.0 phase 3; delegation by reference replaces it |
| #153 | Room simulation evals (draft)                   | Hold; see the evals package above                           |
| #171 | Workspace log regression and path checks        | Land in 0.2.0 phase 5 step 2, before the log cleanup        |
| #268 | Scope a workstation backend                     | Merge into this file as the workstation entry               |
