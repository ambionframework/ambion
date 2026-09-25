# Durability

This is the contract for process, storage, wire, and model failure. The
journal implementation is in [`packages/journal/src`](../packages/journal/src)
and the room projection in [`room/fold.ts`](../packages/ambion/src/room/fold.ts).
Read [`room.md`](room.md) for the room mechanisms and
[`deployment.md`](deployment.md) for host recovery procedures.

## 1. The journal is the source of collaboration state

One room has one append-only record, one ordered sequence, and one conditional
writer at a time. Every message and administrative entry consumes the next
sequence position, so message positions may have gaps. Folding the ordered
record reconstructs the composition, roster, people, exchanges, leases,
routing, pending work, and summaries. In-memory state is a cache of that fold.

The journal envelope owns `kind`, `body`, `seq`, `key`, and `run`. The room owns
message freshness and validates recognized bodies before replay. One append
operation handles every entry kind: it reads recovery state, evaluates the
room's synchronous decision, and either appends or returns a result. A repeated
key returns its original entry before the decision runs; reusing a key for a
different kind fails. Keys never expire while the record is retained.

The journal owns its cache and sequence counter. Public reads, append receipts,
and callbacks receive detached values. Incremental room projection reads only
new entries, so protecting ownership does not copy old history on every operation.

The first entry of each run is a fence and every write carries that run id. A
later fence voids writes from earlier runs after the fence position. A
superseded run emits `superseded`, drops its live handles, and writes nothing
more. Hosts must run one live room per name and use storage with an atomic
conditional append; the SQLite backend supplies this comparison.

After a confirmed append, the room folds and captures the resulting facts
before handing them to a host-local ordered publication tail. That tail sends
notifications, steering, and cuts for both newly written and recovered
entries. Listener or transport failure cannot turn a confirmed journal write
into a rejected submission; publication has no durable backlog.

Memory storage lasts for the process. SQLite persists the record. A storage
that reorders entries, tears writes, or lies about durability is outside this
contract.

## 2. What a delivery promises

- **Acknowledged:** `visit.send()` resolves only after the message append is
  confirmed and returns the exchange handle for that question. The message and
  recorded routing remain on the journal.
- **Refused:** a stopped room, ended visit, invalid recipient, or stale
  conditional append writes nothing and rejects.
- **In doubt:** retry with the same `key`, author, recipient, exact text, and
  refs in the same order.
  The message is either absent or already present; an exact retry lands at most
  once and returns the original exchange handle, including after restart.
- **Superseded:** a later run's fence prevents future writes from an earlier
  run. Entries accepted before that fence remain in the journal; the old run's
  subsequent handles and writes are stale.

Keys are scoped to the room, not to a person or visit. Reusing a key for another
author, recipient, or text within the same operation rejects without changing
the original entry. An explicitly supplied empty string is a key; omitting it
generates one. Applications should generate unique keys and save the key with
the request before sending. Leaving and reentering does not reset a key.

Agent contributions likewise bind a key to their activation and contribution.
A retry may carry a newer read position, but cannot replace the accepted content.
Presence and administrative writes retain the generic journal's kind-level
deduplication. The record retains every token for replay and inspection.

**A commit retry is safe under its key.** The commit key is the tool call id.
A retry under that key returns the message the room already holds. The seat
retries a lost commit first and reports `unknown` only when no attempt
confirms it. The seat then ends the activation and never says the text again
under a new key, which would land the message twice. `unknown` is the one
`CommitResult` that the room does not stamp. This mechanism differs from an
activation retry (see section 4): the seat drives it, and it spends no attempt.

**A commit lands only at the end of the record.** The verified rule
`speechFreshness` in
[`room/rules.verified.ts`](../packages/ambion/src/room/rules.verified.ts)
compares the commit's `readThrough` with the last `seq`. A position at the
last `seq` is fresh. A position short of it is `missed`: the room returns the
messages beyond `readThrough`, and the seat reads them and commits again. A
position off the record is invalid.

A delivery's key and an agent commit's key live in separate spaces. The same
literal key can name a delivery and, independently, a commit, without
colliding: each reads back through `Message.key` exactly as its own caller
supplied it.

## 3. What a read promises

`room.read()` returns confirmed room messages in sequence order; administrative
journal entries may leave gaps between their sequence positions. An acknowledged
write appears in a later read, and a resumed run replays the full record before
answering. `subscribe()` is the push view of the same facts: one `message`
notification per message seen by that run, with no historical replay.

To recover a client, subscribe first, read with an exclusive `since` cursor,
merge overlap by `seq`, and advance the cursor only after consumption. Recreate
subscriptions after restart.

## 4. What a lease promises

A wake names one seat and one message. A closed exchange can also owe one
summary activation. Each activation claims a derived lease, renews while it
works, and ends once. A running lease holds its work. A release settles only
context the executor explicitly acknowledged (`readThrough`); expired or
failed work answers nothing, so heard messages become pending again after
backoff. Repeated claims renew the same activation; repeated release is stale
and harmless.

Lease ids derive from cause, journal position, seat, and attempt. No caller
mints them. The room derives pending wakes and summary assignments from the
record. It retries under `hostingOf(runtime).limits.activation` and records
`abandoned` at `attempts`. `hostingOf` comes from
`@ambionframework/ambion/hosting`, a host's own entry. Each claim or renewal
holds the lease for `limits.lease.ttl`. No renewal reaches past
`limits.lease.deadline` from the first claim.

Steering carries explicit consumed ranges, so reordered or duplicated context
cannot acknowledge a gap. A fresh activation reconstructs missed context from
the record. The trace goes to the host's logger. A logger that fails does
not turn successful or deliberately silent collaboration into failed work.
The room promises no trace.

### Permanent and transient failure

**The executor classifies a failure and the room acts on the cause.** A
`FailureCause` is `permanent` or `transient`. A permanent cause is a
failure that a retry cannot fix: an authentication refusal, a bad request,
a spent credit, quota, or usage limit, or a fault in the configuration. A
transient cause is a rate limit, a server error, or a lost connection.

- **A permanent failure ends in one attempt.** The room records `abandoned`
  at once. A permanent cause on any failed lease makes the whole activation
  permanent.
- **A transient failure retries to the cap.** The activation retry in the
  lease paragraph above is room-driven. Each retry spends an attempt.
- **A room without an execution fails every activation as permanent.** The
  error code is `no_execution`.
- **The Pi executor reads a status only from a provider diagnostic.** It
  treats 400, 401, 402, 403, 404, 405, and 422 as permanent, and credit,
  quota, usage-limit, or authentication text as permanent. It never reads a status from free error
  text, because a rate limit names a token count that looks like a 400.
  Every uncertain failure is transient.

Section 5 states which ends carry usage.

### Transport calls and unclaimed work

**A local timeout leaves the remote result unknown.** Executor calls to the room
use `hostingOf(runtime).limits.call.timeout`, in milliseconds, with a default
of 10,000. Claims and releases retry up to
`hostingOf(runtime).limits.call.attempts`, which defaults to two. Retries
keep the activation identity. A timeout
neither revokes a lease nor reverses a contribution that the journal already
accepted.

A cut ends local claim and release waits. Late replies cannot start cancelled
execution. Renewal waits retain a separate alarm at the last confirmed lease
expiry. An unresolved renewal therefore cannot extend local execution authority.
The room still checks every claim and contribution against recorded authority.
If the executor stops at that expiry, it reports unfinished execution as failed.
A remotely renewed lease must not convert that stop into deliberate silence.
Cloudflare recovery uses the same call limits to release an interrupted
activation. An unknown result frees local seat metadata; the journal still owns
the lease. A late reply cannot clear another activation's metadata.

**Unclaimed work remains pending while eligible.** The room resends delivery
under `hostingOf(runtime).limits.delivery.resend`. Delivery failure does not
consume an execution attempt. Activation deadlines start at a claim, not at
the source message.
An unresolved delivery does not prevent a later resend.
Work can remain pending through a shutdown or a deliberate executor hold.
Abort and unseating record the boundaries that make delayed claims stale.

Hosts receive `delivery_error` diagnostics for failed or uncertain transport
calls. Each diagnostic identifies the agent, activation, and operation.
These are live diagnostics; they do not change the accepted message or establish
a durable exchange outcome. A successful delivery call does not prove that
execution has started.

## Cancellation

**`await room.abort()` confirms one durable cancellation boundary.** The journal
orders cancellation with messages and executor commits. Work before that boundary
loses publication authority, including expired leases, pending retries, unread
steering, and scheduled says that wait to return. Messages recorded afterward can
start fresh work. Membership and human
presence remain unchanged.

Cancellation closes the current exchange without assigning a summary. An existing
pending summary becomes failed; a published or settled outcome remains unchanged.
The cancellation entry records these effects atomically. Replay applies the same
boundary, so restart cannot revive cancelled work.

Concurrent calls share one operation. If storage rejects or leaves the write in
doubt, retry `abort()` on the same room handle. The handle retains its request key
until confirmation. If that entry already committed, the retry acknowledges it
without cancelling newer work. A call after confirmed success is a new cancellation.
Stopped or evicted handles reject cancellation.

Completion confirms journal authority changes. Executor cuts are best effort;
completion does not wait for a provider or tool to exit or reverse external effects.
Hosts must await the promise before reporting cancellation as complete.

## Stop

**`room.stop()` ends a run and loses no pending work.** It settles every
running lease, including expired leases, and every recorded pending
activation. It also settles the unread steering that those revocations expose.
Completion needs a confirmed journal read with no execution obligations left.

- **Stop preserves an open exchange.** A resumed run closes it and assigns a
  new summary through reconciliation. A summary that stop revoked stays failed.
- **Stop preserves a scheduled say.** The say stays on the journal. A resumed
  run arms the room's alarm for its due time, and returns a say that fell due
  while no run held the room at its first reconcile. A crash does the same.
  [`scheduled-say.test.ts`](../packages/ambion/test/scheduled-say.test.ts)
  finds one returned say after each.

[`deployment.md`](deployment.md) holds the host steps.

## Journal format

**Every `run` entry carries `format: 1`, the
journal format.** The constant `JOURNAL_FORMAT` names it. The room writes it on
both start and resume.

**Before 1.0.0 the format carries no promise.** A release may change it. The
change raises `format`, adds a golden journal of the new shape, and adds no
reader for the older format.

- **The golden journals pin the fold of format 1.** The journals in
  [`test/golden`](../packages/ambion/test/golden) replay to the committed
  fold in CI.
- **A key carries a space prefix.** A delivery key starts with `delivery:`
  and a commit key starts with `commit:`, so equal text in the two never
  collides. A key with no prefix, from an older journal, reads as written.
- **A run entry with no `format` reads as format 1.** Journals from before
  the field share the body shape.
- **An unknown format is refused.** A runtime that reads `format: 2` throws
  `Unsupported journal format`. It does not skip the fence and does not
  guess.

**A `session` on an ended lease entry names a harness session.** An
executor hands the driver a harness session at release. The room writes it
as `session: { harness, id }` on the `ended` entry. It hands the latest one
of the seat in the same exchange to the next activation as `spec.resume`.
The room never reads the id.

**The room promises nothing about the session itself.**
[Exchange continuity](executors.md#exchange-continuity) states where each
harness keeps the session and what the next activation does when it is
lost.

Cancellation adds the `cancel` entry kind. Older runtimes must not resume a
journal that contains cancellation entries, because they do not interpret
that boundary.

## 5. What the room does not promise

The room does not promise exactly-once model execution or external side effects.
Provider calls and tools may repeat after timeout, expiry, or cancellation;
applications own effect idempotency and transaction rules. It also does not
repair torn storage, reconcile disagreeing clocks, or coordinate two live hosts
over storage without conditional append.

Usage has a coverage limit. The driver writes usage on the release entry
of an activation, so `released` and `failed` ends carry it. An end the room
writes (`expired`, `revoked`, `abandoned`) carries none, and the exchange sum
omits what those attempts spent.

[Trust](trust.md) states what one seat can and cannot do to the record.

Platform behavior remains a host concern. The Cloudflare adapter relies on one
Durable Object instance and its SQLite storage; a resumed object fences stale
writes. Other placement, network, and credential guarantees must be supplied by
the host.

## 6. What a host must do

After a process failure:

1. Resume with `resumeRoom(name, { runtime, agents })`, supplying executable
   definitions for every recorded agent name.
2. Recreate authenticated visits and preserve recorded presence until the host
   confirms departure.
3. Recreate subscriptions before reading `room.read({ messages: { since } })`; merge by `seq`.
4. Reacquire exchange handles with `room.exchange(from)` and recreate waits.
5. Reconnect remote runners to the current room host. Preserve unexpired leases;
   let expired leases follow normal retry policy.

Evict a dead in-memory room before another host takes its name. Treat
`superseded` like eviction: discard its answers and resume the name. A failed
resume may be retried; its fence is the first write of the new run.

## 7. How it is proved

The scripted suite uses a fake clock, scripted model, serialized transport, and
memory and SQLite storage. The failure matrix and process tests are linked here
for the claims that need more than a unit test:

| Claim                                                                                                                                                   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stop cleanup across expiry, storage failure, and restart                                                                                                | [`stop-work.test.ts`](../packages/ambion/test/stop-work.test.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| A permanent failure abandons in one attempt; a rate-limit token count is not a status; a transient failure retries to the cap                           | [`permanent-failure.test.ts`](../packages/ambion/test/permanent-failure.test.ts)                                                                                                                                                                                                                                                                                                                                                                                                                              |
| A lost commit retries under its key and speaks once; an unknown outcome ends the activation without a second say                                        | [`commit-retry.test.ts`](../packages/ambion/test/commit-retry.test.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Atomic cancellation, retry, and restart                                                                                                                 | [`cancellation.test.ts`](../packages/ambion/test/cancellation.test.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Ordered publication and recovery after submission faults                                                                                                | [`submission.test.ts`](../packages/ambion/test/submission.test.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Golden journals replay to the committed fold, and a newer format is refused                                                                             | [`golden.test.ts`](../packages/ambion/test/golden.test.ts), [`journal-validation.test.ts`](../packages/ambion/test/journal-validation.test.ts)                                                                                                                                                                                                                                                                                                                                                                |
| Crash before/after every append, then same-key retry                                                                                                    | [`chaos.test.ts`](../packages/ambion/test/chaos.test.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Host handover and lease retry under load                                                                                                                | [`hosts.test.ts`](../packages/ambion/test/hosts.test.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Child-process kill and SQLite recovery                                                                                                                  | [`reconnect-process.test.ts`](../packages/ambion/test/reconnect-process.test.ts)                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Random wire, disk, clock, visit, and crash walk                                                                                                         | [`property.test.ts`](../packages/ambion/test/property.test.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Invocation/outcome history against the record                                                                                                           | [`consistency.test.ts`](../packages/ambion/test/consistency.test.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Stale host loses after a fence                                                                                                                          | [`split.test.ts`](../packages/ambion/test/split.test.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| The activation lifecycle and the exchange lifecycle: the lease fold, the admissions, the grant, the retry, the opening question, the verdict, the close | [`room/rules.verified.ts`](../packages/ambion/src/room/rules.verified.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| The fence as a state machine, the key, the seq counter, and the cursor                                                                                  | [`journal/src/rules.verified.ts`](../packages/journal/src/rules.verified.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| How a rule is proven, how the gate runs the proofs, and the constructs a rule may use                                                                   | [`formal.md`](formal.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Every verified rule runs on the path its contract describes                                                                                             | [`journal/test/binding.test.ts`](../packages/journal/test/binding.test.ts), [`ambion/test/binding.test.ts`](../packages/ambion/test/binding.test.ts)                                                                                                                                                                                                                                                                                                                                                          |
| A storage and a transport hold the published contract: the storage cases, and the wake, steer, cut, and room calls of a seat                            | [`journal/src/conformance.ts`](../packages/journal/src/conformance.ts), [`ambion/src/conformance.ts`](../packages/ambion/src/conformance.ts), run by [`journal/test/storage.test.ts`](../packages/journal/test/storage.test.ts), [`ambion/test/transport-conformance.test.ts`](../packages/ambion/test/transport-conformance.test.ts), [`cloudflare/test/storage.test.ts`](../packages/cloudflare/test/storage.test.ts), [`cloudflare/test/transport.test.ts`](../packages/cloudflare/test/transport.test.ts) |

Run the process-boundary scenario without provider credentials:

```sh
pnpm --filter @ambionframework/ambion exec vitest run test/reconnect-process.test.ts
```
