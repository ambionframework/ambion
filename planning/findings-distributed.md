# Correctness findings for a distributed host

> A review report, kept as written. The backlog tracks each finding:
> F1 is item 35, closed with a remainder; F2 to F7 are items 37 to 41;
> F8 is item 36; F9 is item 28; F10 is item 32. The LemmaScript contracts
> the report added now live beside the code they check, in
> `packages/ambion/src/log/rules.verified.ts` and
> `packages/ambion/src/room/rules.verified.ts`.

## Scope and evidence

This review treats each room, seat, activation, or exchange as a possible
process boundary. It assumes that processes can run on different hosts.
It also assumes that all processes can append to the same session storage.

The review covers the runtime, room log, lease protocol, seat actor, transport,
and workspace backends. The current tests use direct objects behind a transport
shim. They prove JSON request shapes and failures on that shim. They do not run
a room and its seats in separate operating-system processes.

The environment had no `*_API_KEY` or `API_TOKEN` variable. Thus, no live test
could use an actual provider key. The scripted tests were sufficient for the
storage and coordination findings below. Finding F1 also has a deterministic
regression test that expects the corruption.

## LemmaScript assessment

[LemmaScript](https://lemmascript.org/) translates annotated TypeScript into
Dafny or Lean proof obligations. Its contracts have no runtime cost. This makes
it useful for the pure folds and decisions that define room state.

This change adds a Dafny verification target in
`packages/ambion/verification/distributed.verified.ts`. The target proves these
rules:

- one allocator returns exactly `lastSequence + 1`;
- two private allocators collide when they read the same snapshot;
- an ended lease stays ended as later rows fold over it;
- a generation check accepts exactly the current generation; and
- a proposed atomic append accepts only a current generation, current cursor,
  and unseen key.

LemmaScript 0.6.1 and Dafny 4.11 verified all generated obligations. The root
`check:lemmascript` command repeats the proof. `LemmaScript-files.txt` fixes the
verification scope. CI uses LemmaScript's reusable workflow at a fixed commit.

**The proofs do not make the current storage atomic.** They validate pure
transition rules and the split-brain claim under its shared-snapshot premise.
The application must call the verified transition inside one durable atomic
operation. LemmaScript cannot prove delivery, storage isolation, clock bounds,
or external tool behavior from these functions. Process tests and resource
fences remain necessary.

## Summary

| ID  | Severity | Finding                                                                        | Required boundary or change                                         |
| --- | -------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| F1  | Critical | Two room processes corrupt the logical log.                                    | One fenced coordinator per room name, or atomic storage operations. |
| F2  | Critical | A lease fences messages, but it does not fence tool effects.                   | Effect idempotency and fencing at each external resource.           |
| F3  | High     | The transport has a JSON data plane but no remote configuration plane.         | Deploy definitions and dependencies with each seat.                 |
| F4  | High     | A seat process can lose steering and ordering when its actor identity changes. | One actor per room and seat, or a durable activation mailbox.       |
| F5  | High     | The audit log has no activation-level idempotency or exclusive writer.         | Separate logs per activation, or atomic keyed appends.              |
| F6  | High     | Workspace lifecycle and mutation are local and unfenced.                       | A durable workspace service with atomic mutation and deletion.      |
| F7  | Medium   | Events and completion promises belong to one room process.                     | A durable event cursor and status reads from the coordinator.       |
| F8  | Medium   | Absolute lease times cross host clocks.                                        | Let the room schedule expiry and return renewal intervals.          |
| F9  | Medium   | A crash keeps people present without connection ownership.                     | Durable visit leases or explicit reconciliation by the host.        |
| F10 | Medium   | Read and resume create storage for unknown names.                              | A non-creating lookup operation.                                    |

## Findings

### F1 — Critical: two room processes corrupt the logical log

**The room queue protects one `RoomLog` instance only.** Each instance replays
the log once. It then assigns `message.seq` from its private `lastSeq + 1`.
It checks delivery keys and `readThrough` against private maps and counters.
The instance reads storage again only after one of its own appends fails.
An append by another process stays invisible during normal operation.

Two room processes can therefore append different messages with the same
sequence number. They can also accept the same idempotency key twice. Lease
claims, exchange closes, composition changes, and roster changes have the same
check-then-append race. Their `after` fields can describe obsolete local state.

The `hosts.test.ts` split test starts two runtimes over one repository. It then
asserts that duplicate message sequence numbers exist. The test passed. This is
hard evidence that shared append-only storage does not make the room safe for
multiple writers.

The process-local `runtime.running` map cannot enforce the documented rule of
one run per name across hosts. A Durable Object keyed by room name can enforce
that rule if all room operations reach that object. A coordinator per exchange
or activation cannot enforce it because many such coordinators can append to
the same room log.

**Required change.** Use one authoritative room coordinator for each room name.
Give every incarnation a durable generation token. Reject calls and writes from
older generations. If the storage remains the coordinator, it must provide one
atomic operation that checks the generation, key, cursor, and lease state, then
appends. A plain append API is insufficient.

### F2 — Critical: a lease fences messages, but it does not fence tool effects

**The room validates the lease only when an activation calls room methods.** A
stale activation cannot commit `say`, `summarise`, or `seat`. This protects the
room record after expiry or takeover.

The model can execute custom tools and workspace tools before that commit. A
partitioned process can keep running after its room lease expires. The room can
start the next attempt while the first process still changes files, calls an
external API, or sends an irreversible request. Both attempts can complete the
same effect even though only one can add a room message.

`AbortSignal` does not supply a distributed fence. The room can directly abort
only an in-process `SeatActor`. A remote process can miss the abort. Many
external systems also cannot undo a completed request.

**Required change.** Pass the activation ID, attempt, and room generation into
every tool context. Require mutating tools to use an idempotency key. A durable
workspace service must atomically reject an old generation. External APIs need
their own idempotency or compensation rule. Describe at-least-once tool effects
as the default when a resource cannot enforce either rule.

### F3 — High: the transport has no remote configuration plane

**The wire request and response values are JSON, but seat construction is
local.** `Transport.connect` receives a `RunningRoom` and a `Runtime`. Both hold
functions, maps, model resolvers, session openers, and agent definitions. The
in-process transport gives those objects directly to `SeatActor`.

The serialization test wraps only `wake`, `view`, `commit`, and `lease`. It does
not serialize `connect`, the catalog, tools, workspace backends, the stream
function, or the model resolver. A different host cannot reconstruct a seat
from the current wire protocol alone. Agent definitions also include executable
tool functions, which cannot cross JSON.

**Required change.** Make deployment configuration an explicit input to a seat
service. Resolve a versioned agent definition at the seat by a stable name and
version. Deploy tools, credentials, model configuration, the workspace client,
and the audit store with that version. Keep only identifiers and capability
tokens on the room-to-seat wire.

### F4 — High: a seat process can lose steering and ordering

**`SeatActor` holds important state only in memory.** Its `current` activation,
one queued activation, steer queue, Pi agent, and renewal loop are local fields.
The room caches one port per seat and sends steering to that port.

One durable actor per room and seat matches this design. It serializes wakes and
keeps steering with the running Pi agent. An actor per activation can also work,
but the router must address the current activation exactly and persist every
steer before acknowledging it. The current transport addresses a seat and puts
the activation ID in the payload; it defines no durable routing rule.

The single `queued` string is safe only while one actor serializes calls. If
separate processes handle calls for the same seat, each process can see no
current activation and start work. The room lease stops duplicate room commits,
but F2 still applies to tools and model cost.

**Required change.** Prefer one seat actor keyed by `(room, seat)`. Keep it for
the active room generation and allow it to hibernate between activations. If an
activation is a separate object, store a durable mailbox keyed by activation ID
and make mailbox insertion idempotent by message sequence.

### F5 — High: the audit log is unsafe across activation processes

**All activations for one seat append to `<room>:<seat>`.** The append sequence
writes an unkeyed `ambion/activation` row and then every Pi message. A crash can
leave a prefix. A retry writes another full transcript. There is no activation
ID in the marker, no idempotency key, and no transaction around the group.

One long-lived `SeatActor` holds one cached audit session and serializes its own
activations. An object per activation removes that serialization. Different
activation processes can interleave transcript entries in the same Pi session.
The room lease does not protect this downstream session.

**Required change.** Use one audit stream per activation ID, or add the
activation ID and a stable entry index to every row. The store must atomically
deduplicate that pair. Build a seat history as an index over immutable
activation streams.

### F6 — High: workspace lifecycle and mutation are local and unfenced

**A workspace name is unique only in one `Runtime`.** The `taken` set and the
handle's `destroyed` Boolean are process memory. Two hosts can define the same
name. One host can destroy it while another handle continues to connect.

The default memory backend is not durable across processes. Defining the same
name later creates a different filesystem, despite the workspace documentation
describing the name as durable identity. The directory backend shares files,
but it supplies no transaction, compare-and-swap, generation fence, or lock for
concurrent mutations. Built-in tools serialize calls inside one Pi agent only.
They do not serialize agents or hosts.

A destroy race is also unsafe. One process can delete the directory while a
remote activation uses it. That activation has no durable destroyed mark to
check and no generation to present on later writes.

**Required change.** Treat the workspace as its own durable service keyed by
workspace name. Store a lifecycle generation there. Make connect and every
mutation validate that generation. Define file conflict behavior. Atomic file
replacement alone does not give isolation across a sequence of tool calls.

### F7 — Medium: events and completion belong to one room process

**Listeners, waiters, and wake-send timestamps are memory caches.** A remote
seat emits tool events only when the deployment supplies an out-of-band path;
`SeatContext.emit` is explicitly optional across a process boundary. A room
restart loses subscribers, event delivery state, and `sentAt`.

The room can safely resend wakes because claims are idempotent under one room
coordinator. Host events have no equivalent cursor or delivery key. A client can
miss `message`, `exchange_closed`, `error`, or `quiet` during reconnection.
`settled()` and `quiet()` are promises tied to one process and resolve early
when that room is stopped or evicted.

**Required change.** Expose durable status reads from the room coordinator.
Publish record events with a durable cursor. Treat tool events as telemetry with
documented delivery semantics, or store them when a consumer requires them.

### F8 — Medium: absolute lease times cross host clocks

**The room returns an absolute epoch expiry.** The seat schedules renewal with
its own clock. Clock skew can make a healthy seat renew too late. The room can
expire it and start another attempt while the first process still runs.

A room Durable Object should own all expiry decisions and alarms. The seat only
needs a conservative renewal interval. Network delay must fit inside that
interval, and renewal must identify the room generation.

**Required change.** Return a lease duration or a server timestamp with the
expiry. Renew well before half the remaining server duration. Keep final expiry
judgment at the room coordinator.

### F9 — Medium: a crash keeps people present without connection ownership

**Presence has no lease.** A resumed room folds an unmatched `arrived` as still
present. A host crash loses the visit handle and cannot write `left`. A later
host accepts the record as current presence, although it might own no socket or
request for that person.

This can wake presence-attentive seats incorrectly and can expose stale reader
preferences as current connection state. The backlog already records this
limitation.

**Required change.** Put a connection or visit lease on the record, or require
the new host to reconcile all visits before it accepts messages. Key a visit by
host generation when only that host can attest that the connection exists.

### F10 — Medium: read and resume create unknown storage names

**`sessionsOver.open` creates on every miss.** `readSession` and `resumeSession`
therefore create an empty durable session for a typo. `resumeSession` fails only
after creation when it cannot find a composition.

This is more costly in a Durable Object deployment. A read can create an object
and durable rows or metadata. Repeated untrusted names can create unlimited
empty objects.

**Required change.** Add a non-creating `find` operation. Use it for read and
resume. Reserve creating open for `startSession` after admission checks.

## Recommended lifecycle boundaries

### Room: one durable coordinator per room name

The room is the consistency boundary. It owns sequence allocation, idempotency
keys, composition, presence, leases, exchange closes, routing, and alarms. Keep
one logical coordinator for the complete life of the room name. It can
hibernate. A new process incarnation must continue under a durable generation
and must fence the old incarnation.

Do not make an exchange the room ownership boundary. Questions can arrive while
another exchange closes, and the next exchange depends on the same ordered log.
The close and the next open need one serializer.

### Seat: one durable actor per room and seat

The seat is the execution boundary. It owns at most one current activation, its
Pi agent, steering, renewal, and activation queue. It can hibernate when idle.
Seat configuration must include an immutable agent-definition version.

This boundary limits model concurrency and preserves steering. It does not make
tool effects exactly once. Each resource must still enforce F2.

### Activation: a leased attempt, optionally a child object

The activation ID is a good idempotency and audit key. It is not a sufficient
room or workspace lock. A child object per activation is useful for a durable
mailbox, model checkpoint, or immutable audit stream. The room lease remains the
authority to publish room effects.

### Exchange: folded state, not an actor

An exchange is a range in the room log. It needs no independent process. An
exchange object would duplicate room state and create a handoff race at close.

### Workspace: one durable service per workspace name

The workspace has a lifetime independent of rooms and seats. Put its lifecycle,
generation, authorization, and mutation rules behind one service. A filesystem
mount on each host is shared storage only. It is not a distributed consistency
protocol.

## Evidence gaps

The current suite gives strong evidence for deterministic room logic, retries,
and sequential crash recovery. It does not establish these distributed
properties:

- mutual exclusion between room processes;
- atomic idempotency across storage clients;
- a real network transport and configuration deployment;
- process-isolated seat steering;
- exactly-once or fenced tool effects;
- concurrent audit writers;
- concurrent workspace mutation and destruction;
- durable event delivery;
- behavior under clock skew.

Add process-level integration tests after the coordinator and remote transport
exist. Use two independent Node processes and a production-equivalent storage
service. A useful test must pause the old process without killing it, expire its
lease, start a new attempt, and then release the old process. Verify the room
record, audit record, model count, and every external effect separately.
