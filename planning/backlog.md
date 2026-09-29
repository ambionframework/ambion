# Backlog

Everything that is not in [next.md](next.md). Each item names the
condition that brings it into a release. Nothing here blocks a release
until the item moves to that file.

**The sections come in the order of their priority.** Known defects come
first, then the release and CI, then the rules and proofs, then
the designs. Inside a section, the first item comes first. An item whose
condition holds moves to the top of its section.

| Section                                       | Items  | First item                               |
| --------------------------------------------- | ------ | ---------------------------------------- |
| [Known defects](#known-defects)               | K1–K5  | K2, the allow-list of the SQL guard      |
| [Release and CI](#release-and-ci)             | L3, R1 | L3, a billing failure reads as one       |
| [Rules and proofs](#rules-and-proofs)         | P1–P6  | P1, `returnable` into the verified rules |
| [Designs with a shape](#designs-with-a-shape) | D1–D20 | D1, a hard bound on an exchange          |
| [Deferred by decision](#deferred-by-decision) | None   | None                                     |

## Known defects

**K2. An agent that runs SQL can lift the append-only guard.** The guard
of `sqliteBackend` refuses the statements that it names: `CREATE
TRIGGER`, a DROP or ALTER of a guarded table, `ATTACH`, and the PRAGMAs
`recursive_triggers`, `writable_schema`, and `query_only`. A statement
that it does not name can still lift it. On 2026-09-29 a review lifted it
on Node 22 and Node 26 with `PRAGMA temp_store`, which drops the TEMP
triggers of the guard at compile time. An allow-list closes the class: an
agent call runs only a fixed set of statement kinds, and only the PRAGMAs
that read. Node 22 has no `setAuthorizer`, so the allow-list reads the
text there. **Condition:** a room that gives the `sql` tool to an agent
that the owner does not trust, or a second bypass in use.

**K3. The assistant speaks where its live suite expects silence on
`openai/gpt-5.6-luna`.** On 2026-09-29 the live suite of
`packages/assistant` passed 17 of 23 cases on that model. Five cases
fail there, and they fail the same way on `main` without A1: the three
samples of the superseded constraint at broadcast, the application
override, and the case with no specialist. The case of the material fact
passes one or two samples of three, so it fails on the others. The suite holds its default model,
`anthropic/claude-sonnet-5`. **Condition:** an application that runs the
assistant on an OpenAI model.

**K4. The assistant does the work of a specialist in the Workbench.** On
2026-09-25, in the `firmware` room, the assistant forked, edited, and
pushed the work itself, and sent nothing to a specialist.
[Default assistant](../docs/assistant.md) keeps it to membership and
summaries. The Workbench gives every seat the same tools, so the model
decides. **Condition:** the next change to the seats of the Workbench, or
a second run that shows it.

**K5. A specialist acknowledges before it answers.** In the same run, in
the `power` room, `design` said "Working the sum + margin now … one
moment." before its answer. Its instructions forbid an acknowledgment.
**Condition:** a live case that catches it, or a second report.

**K1. `python3` in a just-bash shell can abort at exit on Node 26.9.** On
macOS with Node 26.9.0 and `just-bash` 3.4.2, `python3` prints its output
and can then abort with "Fatal Python error: gilstate_tss_clear". The
command exits 1, and the error text joins the output. On 2026-09-24 it
failed two gate runs on the owner's machine, and the 0.2.0 release ran
with `--skip-gate`. On Node 26.10 every gate run passed, and CI passes on
Node 22.19 and 26.4. The tests that show it are "runs js-exec and python3,
and has no curl" in `packages/just-bash/test/just-bash.test.ts` and the
RFC 4180 export case in `packages/workspace/test/sql.test.ts`. Find the
rate and whether Linux fails too, and report the smallest failing command
to `just-bash`. **Condition:** a user report, a CI Node version at 26.9 or
later, or a failed release gate on the owner's machine.

## Release and CI

**L3. A billing failure reads as a billing failure.** Twenty-three red
live runs in a row had one cause, and each run read as a set of test
failures. Before the tests, each harness job makes one small request. A
billing or authentication refusal fails the job with an annotation that
names the provider error, and the tests do not run. **Condition:** the
next live run that fails on a provider refusal.

**R1. A repeatable release.** The releases run from one machine with a
passkey and a token, and `DEV_BASE` in `dev-release.yml` is a literal. A
trusted workflow with `id-token: write` publishes with provenance and
needs no token on a laptop. npmjs then holds a trusted publisher setting
for each of the eleven packages, and the dev stamp reads its base from the
last tag. **Condition:** a release that the owner does not run from the
owner's machine, or a user who asks for provenance.

## Rules and proofs

[docs/formal.md](../docs/formal.md) states the mechanism and the line a
proof must pay for. None of these removes a known defect.

**P1. `returnable` moves into the verified rules.** The rule decides when
the room returns a scheduled say, and `reconcile.ts` and `returning` call
it. It lives in `packages/ambion/src/room/scheduled.ts`, outside
`room/rules.verified.ts`, so it has no contract and no binding case.
**Condition:** none. It comes first in this section.

**P2 to P6. The open proofs.** The chaos drain and the walk's `drained`
check witness the two measures today. **Condition:** a fault that one of
them would have caught.

| Item | Proof                 | What it states                                                                                    |
| ---- | --------------------- | ------------------------------------------------------------------------------------------------- |
| P2   | The stop-loop measure | A measure that the stop loop decreases                                                            |
| P3   | The pass measure      | A measure that each reconciliation pass decreases, so the `PASSES_PER_RECONCILE` bound is a proof |
| P4   | Unique roster names   | `reseat` and `rosterAfter` keep one seat per name                                                 |
| P5   | `seatLive`            | The seats that are live now, as a rule beside `exchangeLive`                                      |
| P6   | `storedIdAccepted`    | The kinds on which `validate.ts` reads an activation id; a refusal on others is a schema change   |

## Designs with a shape

**Rooms that run unattended come first.** A room that stays available
between interactions runs on the room's clock with no person present. The
designs that bound, fold, and recover such a room come before the designs
for scale.

### For rooms that run unattended

**D1. A hard bound on an exchange.** Nothing bounds a loop of posts or the
usage of one exchange ([Exchange](../docs/exchange.md#9-a-gap-the-room-has)).
`limits.exchange` bounds the activations or the usage of one exchange, the
room writes the close, and `exchangeOutcome` gets a terminal outcome beside
`exhausted`. **Condition:** a host that must cap the spend of one
exchange.

**D2. Compaction with no person.** A summary goes to a person, so an
exchange where no person spoke never folds. A monitor that ticks each ten
minutes adds about 1,000 returned says in a week. The first step is a
render rule: a closed exchange with no spoken message shows as one line,
and `recall` still reads it. A later step lets a seat write a summary over
its own range. **Condition:** a measured context cost from a
self-scheduling seat.

**D3. A post with `after`.** The host sets a clock on the journal, and the
room posts when it is due, so a reminder of the host survives a restart.
**Condition:** a host that loses a reminder across a restart.

**D4. The checkpoint entry.** A checkpoint entry lets a resume skip
settled history, and full replay stays the reference. It adds a journal
body, so it lands with a golden journal that holds one. **Condition:** a
measured resume time comes near the default `limits.lease.ttl` of 60
seconds ([envelope.md](../docs/envelope.md)). Past that point, replay sets
the recovery time.

**D5. Processes linked to the room, and more kinds of process.** A
process runs until it ends, times out, or gets a cancel
([Processes](../docs/processes.md)). An exchange closes when no activation
is live, so a cancel at the close stops a process at the first quiet
moment. A link to the room needs its own design. The handle is
`<kind>-<random>`, and `bash` is the one kind. A clone that runs past its
call and a SQL export are candidate kinds. The table has no fence: two
runs of the host over one account adopt the same processes.
**Condition:** a process that must stop with its exchange, or a second
kind of work that outlives its call.

**D6. Three process changes from a comparison with Codex unified exec.**
Codex gives a model `exec_command` and `write_stdin` over a PTY, with
sessions in memory. Three of its mechanisms fit the process table and keep
the five tools.

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

**D7. One stored source for the roster.** A composition seeds the roster
from its `agents`, and each seating and unseating changes it. A
recomposition resets the roster, so it drops a seating that a seat made.
The change writes one seating for each seat at a start and drops `agents`
from the composition. **Condition:** a recomposition that must keep a
seating that a seat made.

### For labs at scale

**D8. A SQL backend over a database server.** `backend.sql` takes any
`SqlBackend` ([Workspace](../docs/workspace.md#query-the-shared-database)),
and the package ships `sqliteBackend`. A backend over a database server
connects as each agent with its own credential, so the server enforces the
grants. It passes the SQL cases, which then move from the SQLite tests
back to the conformance entry. **Condition:** the lab setup, one
workstation and one database server, is scheduled.

**D9. A backend profile and concurrent operations.** A backend declares
its isolation, its network, and whether the owner may run operations from
two agents at once. The owner then keeps one queue for each agent. The
same design decides which identity writes the audit log. **Condition:** a
workstation run where one agent's command delays another agent's file
tool.

**D10. A git server on a second machine.** `workstationGitBackend` keeps
the git account on the workstation, and each agent key works only from the
loopback address ([Workstation git](../docs/workstation-git.md)). A lab
with a git server apart from the workstation needs three things: the
address that an agent's `ssh` uses, the source addresses that `from`
names, and an OpenSSH tier with two machines. **Condition:** a lab with two or more
workstations that share one set of repositories.

**D11. A durable subscription service across processes.** Subscriptions
belong to one running host. A client that reconnects reads and reacquires
its handles. **Condition:** a placement that serves one room from more
than one process.

### For refs and objects

**D12. A publish flow for snapshots.** A snapshot keeps its copy inside
the workspace ([Snapshot a file](../docs/workspace.md#snapshot-a-file)). A
publish copies the bytes of a snapshot ref to a store outside it, such as
an object store, and gives the URL that a person outside the room opens.

- **The digest stays the key.** A publish of the same ref writes the same
  object, so a retry is safe, and a reader checks the bytes against the
  digest.
- **The target is the object backend.** The bytes already live in an
  `ObjectBackend` ([The object backend](../docs/workspace.md#the-object-backend)).
  A publish adds `url(digest, { expiresIn })` to `ObjectEnv`, a presigned
  GET on `s3ObjectBackend`, which MinIO serves. The default file store has
  no URL, so a workspace that publishes names an S3 backend.
- **The record carries both refs.** A message cites the snapshot ref and
  the published URL, so a reader inside the room and one outside it read
  the same bytes.
- **A copy that no message cites is garbage.** A sweep keeps each digest
  that a ref of a room names and removes the rest.

**Condition:** an application that must share a file outside the room, or
an object store that grows past what the host keeps.

**D13. More forms of the `ambion` scheme.** A snapshot names the bytes of
one file, and a commit ref names one commit. The output of a process, a
snapshot of a folder, a file at a commit, and the result of a SQL query
have no ref of their own, so a message names them in its text. The kernel
owns each form, and a resource makes the thing it names. **Condition:** an
agent that must cite one of them from another room.

**D14. A Codex seat cites its changes with snapshots.** The Codex executor
cites each file that a completed patch changed as a `file:` URI of the
host path ([Codex](../docs/codex.md)). A seat whose working directory is a
workspace can snapshot each file, so its refs keep their bytes and match
the refs of Pi and Claude seats. **Condition:** a Codex seat over a
workspace directory with native tools on.

**D15. Objects past 5 GiB, and a stream through the ports.** One object is
one S3 PutObject, 5 GiB, and a snapshot holds the whole file in memory:
the bash port reads whole buffers. A larger object needs a multipart
upload, and a large file needs a stream from the bash port to the object
port. **Condition:** an agent that must cite a file past 5 GiB, or a host
that cannot hold one file in memory.

**D16. Loose ends of the object store.** The adversarial review of the
snapshot work left these open:

- **Orphaned temporary files.** A host that stops between the write and
  the rename of the file store leaves `<digest>.<random>.part` under
  `layout.snapshots`, and nothing removes it.
- **A large commit on the workstation.** `show` buffers its output in the
  host, and the capture window of 16 MiB refuses a larger one. just-git
  has no such bound.
- **A FIFO or a device on the workstation.** The workstation reads either
  as a file. `snapshot`, like `read`, then blocks the bash owner until the
  read ends.

**Condition:** a host that runs for weeks on one store, or a report of one
of these.

### For tools and authors

**D17. An `apply_patch` tool for Codex seats.** A Codex seat under
`nativeTools: 'none'` edits files through the workspace `edit` tool, a
block-replace tool built for Pi. The Codex catalog patch removes
`apply_patch`, the tool that Codex models are trained to call.
`@openai/agents-core` exports `applyDiff`, a pure MIT function that applies
one file section of the patch grammar with no file I/O. The tool adds an
envelope parser for `Add File`, `Delete File`, `Update File`, and `Move
to`, and writes each section through `FileSystem`, the interface of
`edit`. It then works on every backend. `codex-rs/apply-patch` holds the
reference grammar. **Condition:** a live comparison of `edit` against an
`apply_patch` prototype on the same task shows a real gain in tool-call
success for a Codex seat.

**D18. Tool execution provenance beyond the activation.** `ToolContext`
carries the activation, the exchange, and the room. A purpose field, a
retry-safe operation key that the kernel derives, and a domain operation
reused across rooms wait. **Condition:** an application that needs one of
the three.

**D19. Posts in `simulate()`.** A scenario posts an event during an
exchange. **Condition:** a simulator case that needs one.

**D20. A generated API reference.** One reference per entry, with a CI
check that fails when it is stale. **Condition:** an adapter or host
author who cannot work from the typed README examples and the export
snapshot.

## Deferred by decision

- Hot-loaded definitions; the definition set is fixed per run.
- Multiple simultaneous discussions within one room; separate rooms.
- Per-tab presence tokens and automatic departures; hosts reconcile.
- Distributed workspace ownership; one owner per resource.
- Automatic summary skipping by message count; manual summary retry.
- Agent source retrieval and pagination under the shared summary policy.
- Browser-only execution, a managed service, arbitrary edge platforms,
  turnkey deployment commands, multiple terminal clients.
- A `SeatObject` class rename in the Cloudflare adapter; it needs Durable
  Object migration evidence.
- A provider-neutral plugin ecosystem beyond the executor contract.
- A second live-tier provider job. Add one only if a provider-specific
  defect turns up.
