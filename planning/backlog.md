# Backlog: after 0.3.0

Everything that is not in [next.md](next.md). Each item names the
condition that brings it into a release. Nothing here blocks the 0.3.0
tag.

## Known defects

**K1. `python3` in a just-bash shell can abort at exit on Node 26.9.** On
macOS with Node 26.9.0 and `just-bash` 3.4.2, `python3` prints its output,
then can abort with "Fatal Python error: gilstate_tss_clear" and "python3:
Security violation: webassembly". The command exits 1, and the error text
joins the output. On 2026-09-24 it failed two gate runs in a row on the
owner's machine and passed the next one. The two tests that show it are
"runs js-exec and python3, and has no curl" in
`packages/just-bash/test/just-bash.test.ts` and the RFC 4180 export case in
`packages/workspace/test/sql.test.ts`. CI runs Node 22.19 and 26.4, and
both pass. The 0.2.0 release ran with `--skip-gate` for this reason. Find
how often it fails, and whether Linux on Node 26.9 fails too. Report it to
`just-bash` with the smallest command that fails. **Condition:** a user
report, a CI Node version at 26.9 or later, or the next release gate on
the owner's machine.

## Carried from 0.2.0

**M5. The conformance suite.** `conformance.ts` and
`conformance-executor-room.ts` each hold their own question, participants
block, and `stale` constant (`conformance.ts:177`,
`conformance-executor-room.ts:91`). All three executors run the executor
suite, so a fixture change reaches three packages. The shared question,
participants block, and `stale` constant move to `conformance-support.ts`,
and `until` accepts an async predicate. **Condition:** the next change to
an executor conformance fixture.

**L3. A billing failure reads as a billing failure.** Twenty-three red
live runs in a row had one cause, and each run read as a set of test
failures. Before the tests, each harness job makes one small request. A
billing or authentication refusal fails the job with an annotation that
names the provider error, and the tests do not run. **Condition:** the
next live run that fails on a provider refusal.

## Release hygiene

**R1. A repeatable release.** The 0.1.0 and 0.2.0 releases ran from one
machine with a passkey and a token, and `DEV_BASE` in `dev-release.yml:40`
is a literal. A trusted workflow with `id-token: write` publishes with
provenance and needs no token on a laptop. The dev stamp reads its base
from the last tag. **Condition:** a release that the owner does not run
from the owner's machine, or a user who asks for provenance.

- npmjs holds a trusted publisher setting for each of the eleven
  packages.

## Designs with a shape

**The checkpoint entry.** A checkpoint entry lets a resume skip settled
history, and full replay stays the reference. It is a format change, so it
lands with a golden journal of the new format. **Condition:** a measured
resume time comes near the default `limits.lease.ttl` of 60 seconds ([envelope.md](../docs/envelope.md)). Past
that point, replay sets the recovery time.

**Processes linked to the room, and more kinds of process.** A process runs until it ends, times out, or gets a
cancel ([Processes](../docs/processes.md)). An exchange closes when no
activation is live, so a cancel at the close stops a process at the first
quiet moment. A link to the room needs its own design. The handle is
`<kind>-<random>`, and `bash` is the one kind. A clone that runs past its call
and a SQL export are candidate kinds. The end of a process wakes no seat, by
decision: the agent waits, and a host can post a message
([Processes](../docs/processes.md#the-end-of-a-process)). The table has no
fence: two runs of the host over one account adopt the same processes.
**Condition:** a process that must stop with its exchange, or a second kind
of work that outlives its call.

**One record for a live process in the table.** The table keeps a process
of this run and an adopted process in two maps, with two stop paths and two
end paths. One record with an optional controller removes about 50 lines,
and each fix to a stop then lands once. A lost process keeps its `pid` and
no end file, so each listing runs `ps` for it until a start forgets it. A
`stop` line that the first read writes ends that cost. **Condition:** the
next change to a stop path, or a table with many lost processes.

**Three process changes from a comparison with Codex unified exec.** Codex
gives a model `exec_command` and `write_stdin` over a PTY, with sessions in
memory ([Processes](../docs/processes.md) holds the Ambion design). Three
of its mechanisms fit the process table and keep the five tools. The
output cursor, a fourth, landed in 0.3.0.

1. **An interactive kind of process.** A `pty-<random>` handle runs its
   command on a PTY, and an `input` tool writes to it, Ctrl-C included.
   The workstation gives the PTY. just-bash has none, so it refuses the
   kind. Today stdin is `/dev/null`, so a command that prompts waits until
   its timeout.
2. **A graceful cancel.** `cancel` and the timeout send `SIGTERM` to the
   group, and `SIGKILL` after the grace. Today a stop sends `SIGKILL`, so
   a server or a database gets no time to flush.
3. **The head and the tail in a result.** The result shows the first
   lines of the output beside the last ones. The first lines often hold
   the error that the last lines report.

**Condition:** an agent that must drive a prompt or a REPL. The
interactive kind comes first.

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

**A git server on a second machine.** `workstationGitBackend` keeps the
git account on the workstation, and each agent key works only from the
loopback address ([Workstation git](../docs/workstation-git.md)). A lab
with a git server apart from the workstation needs the address that an
agent's `ssh` uses, the source addresses that `from` names, and an
OpenSSH tier with two machines. **Condition:** a lab with two or more
workstations that share one set of repositories.

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
