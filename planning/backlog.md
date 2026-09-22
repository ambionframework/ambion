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

**A workstation backend.** A workstation is one remote server with one
Unix account for each agent. A workspace connects to it over SSH, and each
agent logs in with its own credentials. The operating system of the server
keeps one agent's files apart from another's. The just-bash backends have
no such boundary ([workspace.md](../docs/workspace.md#backends-and-limits)).

- **The name is the concept, and SSH is the v1 protocol.**
  `packages/workstation` exports `workstationBackend(options)`, a
  `WorkspaceBackend` that `openWorkspace` takes like `directoryBackend()`.
  A later protocol joins the same package under the same name.
- **The host owns every credential.** The options hold the server address,
  the port, and `credentialFor(agent)`. The resolver returns a user name
  and a private key. The host provisions each account and each key before
  the first connection. The backend stores, issues, and rotates no
  credential.
- **One server serves one workspace.** The address is fixed at
  construction, and only the account changes from agent to agent.
- **The account's home is the working directory.** `connect()` reads
  `$HOME` from the login and creates no directory. `changedPaths` resolves
  a path against the same home.
- **`SshEnv` implements Pi's `ExecutionEnv`, as `BashEnv` does.** A file
  call goes over SFTP, and each `exec` opens one channel. `read` with its
  images, `write`, `edit`, `bash`, `sql`, the audit log, the change log,
  and the room mirror run with no change.
- **The backend keeps one SSH client for each agent.** The owner calls
  `connect()` and `cleanup()` once for each operation (`resource.ts`), and
  a handshake each time adds network round trips to every tool call.
  `connect()` opens a channel on the cached client, and `cleanup()` closes
  that channel. `dispose()` and `destroy()` close every client.
- **`sql` needs `sqlite3` on the server's `PATH`.** `sql.ts` runs
  `sqlite3` through `exec`, so the tool needs no new code. `ATTACH` of a
  second file works, because the server's `sqlite3` reads the real
  filesystem. With no `xan` on the server, the export row count reads
  zero.
- **The guidance states what every workstation has:** a real shell, open
  network access, and one account for each agent. The application names
  the tools that its server installs.
- **`docs/trust.md` gets a new row before the backend ships.** An agent on
  a workstation has a real shell and network access. The account
  permissions on the server contain it. The live test that a seat cannot
  read `/etc/hosts` covers the just-bash backends only.
- **V1 leaves out** Postgres or MySQL on the server, which needs another
  command, another dialect, and a database credential apart from the SSH
  login. It also leaves out credential issuance and rotation, and a
  workspace across two or more servers.
- **Two questions stay open:** where the host configures the known host
  key of the server, and when the backend closes an idle client.

**Condition:** the owner schedules it.

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
