# Backlog

Everything that is not in [next.md](next.md). Each item names the
condition that brings it into a release. Nothing here blocks a release
until the item moves to that file.

**The sections come in the order of their priority.** The decisions of
the owner come first, then the known defects, the release and CI, the
rules and proofs, the simplification findings, and the designs. Inside a section, the first
item comes first. An item whose condition holds moves to the top of its
section.

| Section                                       | Items                               | First item                               |
| --------------------------------------------- | ----------------------------------- | ---------------------------------------- |
| [Pending decisions](#pending-decisions)       | K9, K13, K14                        | K9, the `assistant` option               |
| [Known defects](#known-defects)               | K1–K5                               | K2, the allow-list of the SQL guard      |
| [Release and CI](#release-and-ci)             | L3, R1                              | L3, a billing failure reads as one       |
| [Rules and proofs](#rules-and-proofs)         | P1–P6                               | P1, `returnable` into the verified rules |
| [Simplification](#simplification)             | K10–K27, X1, W8, W10, C2, DOC1–DOC4 | K10, the summary close                   |
| [Designs with a shape](#designs-with-a-shape) | D1–D25                              | D1, exchange bounds                      |
| [Deferred by decision](#deferred-by-decision) | None                                | None                                     |

## Pending decisions

**Each item waits on a decision of the owner.** It joins a release only
when the owner says yes. Each is a simplification row with a design
choice in it.

- **K9. The `assistant` room option.** `normalizeAssistant` in
  `packages/ambion/src/room.ts` turns the option into an `agents` entry, a
  `broadcast` seat, and the `summaryWriter`. The kernel then holds a role
  that it otherwise treats as ordinary. The question: does the option go,
  with a helper in `@ambionframework/assistant` that returns the three
  options? The executor of the assistant is settled: `defineAssistant`
  takes an `executor` function.
- **K13. One counter for the journal.** Both storages append at the head
  plus one, so each `seq` equals its storage position. The journal keeps
  `nextSeq`, `advanceSeq`, and the cursor, which always agree. The
  question: does the seq become the position? The stored format, the
  golden journals, and the verified rules change. Refs and `readThrough`
  keep their meaning.
- **K14. The journal generics.** Only the core imports
  `Journal<TKind, TBodies>`. The question: does the class move into the
  core, do the generics go, or does the package stay as it is? The
  package owns the queue and the fence, and its proofs read no meaning of
  the room.

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
for each of the twelve packages, and the dev stamp reads its base from the
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

## Simplification

**This section lists the concepts that the repository holds twice.** A
concept goes when another concept already carries its meaning. The rank is
the concepts removed times the confidence (high 3, medium 2, low 1).
Twenty-six reductions have landed. The changelog and the git history
record them.

**W5 moved to [next.md](next.md). K9, K13, and K14 wait in
[Pending decisions](#pending-decisions).** The rows below are open on
`main` as of 2026-10-02. The K IDs from K10 are rows of this table. K1 to K5
belong to the known defects.

| ID  | Finding                                                    | Evidence                                                                                                                                                                                         | Rank |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| K10 | Two close shapes still serve one fact                      | `SummaryClose` in `room/exchange.ts` remains; `owed.ts` uses it. `OwedClose` is gone                                                                                                             | 2    |
| K11 | Three state shapes hold the fold                           | `RoomState`, `RoomProjection`, `BaseFacts`; `applyEvent` has two callers                                                                                                                         | 2    |
| K12 | The wakes and the owed summaries are two parallel indexes  | `wakes.ts`, `owed.ts`, `seatLeases`, `closedLeases`; the rules differ                                                                                                                            | 3    |
| K15 | The roster has two stored sources                          | This is D7. The row stays as a pointer                                                                                                                                                           | 2    |
| K17 | Five names describe one exchange                           | `Exchange`, `ExchangeRef`, `ExchangeRange`, `ExchangeRead`, `ExchangeHandle`                                                                                                                     | 4    |
| K18 | Three shapes describe one trace sink                       | `TraceSink`, `StepSink`, `TraceOpener` in `trace.ts`                                                                                                                                             | 2    |
| X1  | One name rule is written fourteen times                    | Core: `NAME_PATTERN`, `SEAT`. Workspace: nine literals in seven sensor files, `NAMESPACE`. Workstation: the serve pattern. Workbench: `ROOM_NAME`, with a bound of 48 that the core does not set | 12   |
| W8  | The backends label themselves under three names            | `server`, `hostname`, `database`                                                                                                                                                                 | 4    |
| W10 | `ProcessKind` has one value                                | `process-files.ts`. D5 holds the question                                                                                                                                                        | 2    |
| C2  | `RoomObject` forwards three methods of the exchange handle | `room-object.ts`                                                                                                                                                                                 | 2    |

**The documentation holds four findings.** They carry the IDs DOC1 to
DOC4, so they do not collide with the designs.

| ID   | Finding                                                                | Evidence                                                                   |
| ---- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| DOC1 | About eight paragraphs repeat across pages                             | Shared option rows and troubleshooting in `pi.md`, `claude.md`, `codex.md` |
| DOC2 | `resources.md` overlaps `workspace.md`                                 | `resources.md` says "two bindings"; seven backend factories exist          |
| DOC3 | "Envelope" has three meanings                                          | `envelope.md`, `durability.md`, `formal.md`                                |
| DOC4 | `durability.md` and `deployment.md` both describe leases and reconnect | The two pages each state the lease, alarm, and SQLite rules                |

**A review of conceptual integrity on 2026-10-02 adds nine rows.** Opus
and Fable read `main` at df2aad8 and asked of each concept what breaks
without it. The core holds: the journal and its fence, the derived
activation ids, `readThrough` freshness, the exchange, and the pass
contract. The rows below sit at the edges of that core. None is in
0.6.0. The owner revisits them after the release.

| ID  | Finding                                                            | Evidence                                                                                                                                                                           | Rank |
| --- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| K19 | The close rule is written three times                              | `reconcile.ts` plans it with `admitsClose`, `transition.ts` checks it again, and `room-run/control.ts` writes its complement. `decide` can return written, not owed, or plan again | 6    |
| K20 | The room records who a message wakes and infers who it steers      | `wakes` is on the body. `steers` comes from the leases at fold time, through a test of seven conditions in `room/delivery.ts`. Record `steers` beside `wakes`                      | 2    |
| K21 | Due work is three lists                                            | `wakes`, `owed`, and `scheduled` in `room/projection.ts`, each with its own rule. The activation id already names every item. K12 holds two of the three                           | 4    |
| K22 | The publication tail keeps caches because it lacks the prior state | `heardLeases`, `heardCloses`, and `seedHeard` in `room-run/`. A step that hands the hearer the state before the entry derives both                                                 | 6    |
| K23 | The view has two windows that count a summary differently          | `capOf` counts raw messages and `tokensOf` counts rendered blocks, in `room/view.ts`. One walk over the blocks, or drop `limits.context.messages`                                  | 4    |
| K24 | One in-doubt append is written four times                          | Cancel, arrival, departure, and stop each keep a promise and a key in `room-run/`. One keyed single-flight helper serves all four                                                  | 6    |
| K25 | A package import sets the default execution of its kind            | `defaults` in `execution/route.ts` is module state, and resolution reads three tiers. The one value in the definitions that is not a value                                         | 6    |
| K26 | A scheduled say is a flag on `said`, and a dismissal is a message  | `delaySeconds` on `said` and the `dismissed` kind, which every message reader excludes. One `scheduled` entry with an optional `from` also serves D3                               | 4    |
| K27 | Sensors fail the test that the actuator page states                | `connect`, `disconnect`, `observe`, and a versioned wire API, about 2,100 lines of `packages/workspace`. `curl` and `snapshot` give the same bytes. A product decision             | 8    |

**K19, K22, and K24 change nothing that a host sees.** They stay inside
`room-run/` and `reconcile`, and one change can carry all three. K20,
K23, and K25 each change one contract: a body field, a limit, or the
quickstart. K21 and K26 reshape the kernel, with the close as a message
below.

**The deepest kernel option is a close as a message.** A close that
routes to the summary writer makes the summary an ordinary respond
activation. The `closed` activation source, `owed.ts`, `closedLeases`,
`closeFor`, and `summaryWriter` on the close then go, and K9 goes with
them. The review of 2026-10-02 prices it higher than this row did:

- **The purpose moves into a rule.** A summary reads to its close, reads
  the preferences of the person, and writes one summary for each person.
  These become rules on the kind of the message that woke the writer.
- **A close must not wake the writer in a loop.** A close routes to the
  writer only when a person spoke in its range, as `summaryVerdict` says
  today.
- **The tools still branch.** A summary `say` drops `readThrough`, holds no
  agent tools, and ends after the last recipient.
- **`fixed` stays** unless a close can reach a writer that has no seat.

**Condition:** the second step of D2, a seat that writes a summary over
its own range, is scheduled. The change then takes K21 and K26 with it.

**Considered and kept.** Each of these looks like a duplicate and carries
a meaning of its own. A later review does not propose them again.

- **W7.** Two owners close the sensor connections. The close in `dispose`
  stops pending connects at once. The close in `withProcesses` waits for
  the processes.
- **S1.** The simulator keeps `deadlineSignal`, and the workbench keeps its
  usage formatter. A test pins the reason of the timeout.
- **`pi()` and `piExecution()`.** One definition runs on different
  executions.
- **The unions that `rules.verified.ts` declares again.** LemmaScript
  lowers only the types of its own file.
- **`startRoom` and `resumeRoom`.** A start writes a composition, and a
  resume keeps the recorded one.
- **`visit.send` and `room.post`.** A send has an author, and a post is a
  message of the system.
- **`sqlite.ts` and `sqlite-guard.ts`.** They are one concept in two files.
- **The port suite and the executor suite.** Cloudflare runs the port
  suite.
- **K8, the record line.** The core has one `renderLine`, and
  `execution/render.ts` calls it. The simulator's `messageLine` writes
  `[seq]` and quotes the text as JSON, so a newline cannot start a false
  line in the judge input.
- **`localExecution`.** A host needs one execution of a kind that is not a
  family.
- **The scripts in `scripts/`.** Each holds one concern.
- **Presence and the roster.** Two folds of a like shape carry two
  meanings. A person opens an exchange and receives a summary, and a seat
  does neither.
- **The journal package.** Its proofs read no meaning of the room, and
  SQLite and Durable Objects satisfy its port.
- **The `compose` tool in the core.** It uses what the core owns: the
  signal, the deadline, the `parent` step, `callId`, and `ToolContext`. A
  separate package would import all of them.

## Designs with a shape

**Rooms that run unattended come first.** A room that stays available
between interactions runs on the room's clock with no person present. The
designs that bound, fold, and recover such a room come before the designs
for scale.

### For rooms that run unattended

**D1. Exchange limits, spend, and quotas.** The former SK1 proposal did
not define its accounting or admission contract. A design must state what
it bounds, how concurrent work counts, and what happens at the boundary.
**Condition:** an application requires a kernel-enforced work bound.

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

**D6. Two process changes from a comparison with Codex unified exec.**
Codex gives a model `exec_command` and `write_stdin` over a PTY, with
sessions in memory. Two of its mechanisms fit the process table and keep
the five tools. The graceful cancel is implemented
([Processes](../docs/processes.md#the-cancel)).

1. **An interactive kind of process.** A `pty-<random>` handle runs its
   command on a PTY, and an `input` tool writes to it, Ctrl-C included.
   The workstation gives the PTY. just-bash has none, so it refuses the
   kind. Today stdin is `/dev/null`, so a command that prompts waits until
   its timeout.
2. **The head and the tail in a result.** The result shows the first
   lines of the output beside the last ones. The first lines often hold
   the error that the last lines report.

**Condition:** an agent that must drive a prompt or a REPL. The
interactive kind comes first. The head and the tail in a result stay
open.

**D7. One stored source for the roster.** A composition seeds the roster
from its `agents`, and each seating and unseating changes it. A
recomposition resets the roster, so it drops a seating that a seat made.
The change writes one seating for each seat at a start and drops `agents`
from the composition. **Condition:** a recomposition that must keep a
seating that a seat made.

**D22. A bound on a chain of scheduled says.** A returned say can lead
to another scheduled say. Existing schedule limits bound one delay and
the pending count, not the full chain.
**Condition:** an application needs a finite chain enforced by the room.

**D23. More of the shared git repositories.** Shared repositories are
implemented ([Git](../docs/git.md#shared-repositories)). Four parts remain
open: push notifications, activation reminders, per-seat grants, and
per-room repositories. **Condition:** an application whose agents write one
repository and miss a push of another agent, or need a grant for one seat.

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
  that a ref of a room names and removes the rest. A retained manifest
  also keeps the objects that its snapshot refs name.

**Condition:** an application that must share a file outside the room, or
an object store that grows past what the host keeps.

**D13. More forms of the `ambion` scheme.** The output of a process, a
snapshot of a folder, a file at a commit, and the result of a SQL query
have no ref of their own. A message names them in its text. The kernel
owns each form, and a resource makes the thing it names.

Sensor evidence uses existing snapshot refs. **Condition:** an
agent needs a reference whose meaning an existing snapshot cannot carry.

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

**D17. An `apply_patch` tool for Codex seats.** A Codex seat edits files
through the workspace `edit` tool, a block-replace tool built for Pi. The
Codex catalog patch removes `apply_patch`, the tool that Codex models are
trained to call.
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

**D25. `Grep` and `Glob` over the workspace for Claude seats.** A Claude
seat has no built-in tool. The aliases cover `Bash`, `Read`, `Write`, and
`Edit`, and `Grep` and `Glob` have no target. The workspace has no search
tool. A model emits `Grep` and `Glob` out of habit, and the call fails as
unknown. The tools run `rg` and `find` through the workspace `bash`. They
return the matches as one result, and then they take the two aliases. **Condition:** a
live trace in which a Claude seat tries `Grep` or `Glob` and loses
turns to the failure.

### For sensors

**D21. Sensor capabilities after the functional core.** The sensor
contract uses Git templates for the fork, customize, validate, save, run,
and rollback lifecycle. Connected processes supply observations that the
workspace retains as snapshots. [Sensors](../docs/sensors.md) is the
current contract. The items below extend it.

- **A framework server and SDK.** A shared implementation is useful only
  if several server repositories need one. Reducer state remains internal
  to those implementations. Instrument drivers, SCPI, serial helpers,
  ffmpeg, annotation, and model captions require no framework commitment.
- **Automatic event delivery.** An optional host integration. A design must
  define delivery, cursor recovery, and policy changes. Host time governs
  host interaction. Measurement times remain the source of truth. Existing
  `room.post` needs no change.
- **Additional sensor views.** Live streams, clips, audio playback, browser
  views, CORS, public endpoints, and public tunnels require an application
  that needs them. They add no required API or client code.
- **Service automation.** Persistent connections, automatic restart,
  upgrades, external URL connections, and hot-plug discovery wait for
  experience with explicit process management and `connect`.
- **Additional scenarios.** A multi-instrument bench is a use case for a
  server repository. The template has one small workstation example, and a
  paid live case is optional evidence.
- **Advanced reads.** Pagination, re-reduction controls, multi-sensor
  requests, and configurable rendering wait for a caller that needs them.
  Span reads use the same `observe` operation as latest reads.
- **Clock quality.** Clock correction, skew estimation, and
  synchronization checks. Measurement timestamps stay as the source gives
  them.
- **Camera Chat toward a real camera.** The realism review of the example
  found five changes.
  - Detection moves into the sensor server, which emits typed events
    through a ring that supports spans.
  - A host policy reads those events and calls `room.post`.
  - JPEG and a smaller model copy cut the bytes about ten times.
  - Capture timestamps come from the ffmpeg PTS with a frame counter. Today
    the `at` of a frame is the time that Node received it.
  - Retention needs a TTL for snapshots and rollouts.

  **Condition:** an application that must watch the scene and react to
  events. A question such as "what do you see now" needs none of this.

- **Camera Chat demo off macOS.** `main.ts` refuses `--demo` on a platform
  other than macOS, though the demo needs nothing from macOS. Gate only the
  live path. This item is optional.

**Condition:** an application needs one of these capabilities. No order
between these items is promised.

### For actuators

**D24. Two process features for the actuator pattern.**
[Actuators](../docs/actuators.md) runs a controller as an ordinary `bash`
process, and the workbench ships `templates/actuator-controller`. Today
the agent runs the cleanup script itself and reads the log as a file. Two
optional features of `bash` would move that work into the workspace:

1. **`finally`.** A command that runs once after an unclean end: an exit
   code other than 0, a kill after the grace, or a lost process. A
   `mkdir` claim in the process directory picks one runner among the
   wrapper, the table, and a second host run.
2. **An event log and its fold.** The workspace names a JSON-lines file
   for each process, and folds its `target`, `observe`, `drive`, and
   `state` lines into a status for `status`, `wait`, the reminder, and
   the host's view.

**Condition:** an application must drive
a device from a room, and the workstation accounts hold the device
permissions.

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
