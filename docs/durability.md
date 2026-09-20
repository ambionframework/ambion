# Durability

This is the contract for process, storage, wire, and model failure. The
journal implementation is in [`packages/journal/src`](../packages/journal/src)
and the room projection in [`room/fold.ts`](../packages/ambion/src/room/fold.ts).
Read [`agent.md`](agent.md) for the room mechanisms and
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
- **In doubt:** retry with the same `key`, author, recipient, and exact text.
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
the record. Transcript audit failure is reported separately as `audit_error`;
it does not turn successful or deliberately silent collaboration into failed
work, and no durable audit backlog is promised.

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
loses publication authority, including expired leases, pending retries, and unread
steering. Messages recorded afterward can start fresh work. Membership and human
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

**Storage compatibility:** cancellation adds the `cancel` journal entry kind.
Current runtimes read existing journals. Older runtimes must not resume a journal
that contains cancellation entries, because they do not interpret that boundary.

## 5. What the room does not promise

The room does not promise exactly-once model execution or external side effects.
Provider calls and tools may repeat after timeout, expiry, or cancellation;
applications own effect idempotency and transaction rules. It also does not
repair torn storage, reconcile disagreeing clocks, or coordinate two live hosts
over storage without conditional append.

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

| Claim                                                                                                                                                   | Evidence                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stop cleanup across expiry, storage failure, and restart                                                                                                | [`stop-work.test.ts`](../packages/ambion/test/stop-work.test.ts)                                                                                     |
| Atomic cancellation, retry, and restart                                                                                                                 | [`cancellation.test.ts`](../packages/ambion/test/cancellation.test.ts)                                                                               |
| Ordered publication and recovery after submission faults                                                                                                | [`submission.test.ts`](../packages/ambion/test/submission.test.ts)                                                                                   |
| Crash before/after every append, then same-key retry                                                                                                    | [`chaos.test.ts`](../packages/ambion/test/chaos.test.ts)                                                                                             |
| Host handover and lease retry under load                                                                                                                | [`hosts.test.ts`](../packages/ambion/test/hosts.test.ts)                                                                                             |
| Child-process kill and SQLite recovery                                                                                                                  | [`reconnect-process.test.ts`](../packages/ambion/test/reconnect-process.test.ts)                                                                     |
| Random wire, disk, clock, visit, and crash walk                                                                                                         | [`property.test.ts`](../packages/ambion/test/property.test.ts)                                                                                       |
| Invocation/outcome history against the record                                                                                                           | [`consistency.test.ts`](../packages/ambion/test/consistency.test.ts)                                                                                 |
| Stale host loses after a fence                                                                                                                          | [`split.test.ts`](../packages/ambion/test/split.test.ts)                                                                                             |
| The activation lifecycle and the exchange lifecycle: the lease fold, the admissions, the grant, the retry, the opening question, the verdict, the close | [`room/rules.verified.ts`](../packages/ambion/src/room/rules.verified.ts)                                                                            |
| The fence as a state machine, the key, the seq counter, and the cursor                                                                                  | [`journal/src/rules.verified.ts`](../packages/journal/src/rules.verified.ts)                                                                         |
| How a rule is proven, how the gate runs the proofs, and the constructs a rule may use                                                                   | [`formal.md`](formal.md)                                                                                                                             |
| Every verified rule runs on the path its contract describes                                                                                             | [`journal/test/binding.test.ts`](../packages/journal/test/binding.test.ts), [`ambion/test/binding.test.ts`](../packages/ambion/test/binding.test.ts) |

Run the process-boundary scenario without provider credentials:

```sh
pnpm --filter @ambionframework/ambion exec vitest run test/reconnect-process.test.ts
```
