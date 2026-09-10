# Durability

What the room promises about its record when the process, the storage,
the wire or a model fails, and how the promise is proved. This page is
the contract. The chaos tier and the history checker hold the room to it.
Read it with [`agent.md`](agent.md) §5, which names the mechanisms, and
[`toolchain.md`](toolchain.md) §8, which says how the tiers run.

## 1. The log is the truth

**One record, one writer, one order.** A room's record is one append-only
log in a Pi session. Every message takes the next seq, and every row the
room writes beside the messages carries `after`, the last seq when it
landed. The fold reads the log from the start and rebuilds the room from
it. That is the roster, the people, the open exchange, every lease, every
wake still pending and every summary still owed. Nothing the room holds
in memory outlives what the log says.

**Durable means the storage's append resolved.** Pi's in-memory repository
holds the record for the life of the process. Pi's JSONL repository
writes every entry to a file and calls no `fsync`. A storage that lies
about an append breaks every promise below.

**One run per name, per runtime.** `startSession` and `resumeSession`
refuse a name the runtime already runs. Nothing refuses a second runtime,
in this process or another. A second live run over the same log is the
one fault the room does not survive yet: §5 says what happens.

## 2. What a delivery promises

**Acknowledged: on the record once.** `deliver()` resolves once the
write is confirmed. The message is on the record and on the stream, and
the wake is sent to every seat it reaches. It stays on the record for
the life of the log.

**Refused: nowhere.** A delivery the room refuses rejects `deliver()`
before anything lands. The visit is over, the room is stopped, or the
recipient is not in the room. Nothing is on the record, nothing is on
the stream, and nobody woke.

**In doubt: at most once.** A write the storage failed, or a process that
died with the write in flight, leaves the host without an answer. The
message is on the record or it is not. The room reads the storage back
before its next write, so a message that landed is on the record before
anything lands on top of it. `deliver({ key })` names the delivery. A
host that never learned whether a delivery landed delivers it again
under the same key, and the key lands once.

## 3. What a read promises

**A prefix, in order.** `messages()` returns the record from seq 1 to
the last seq the run has confirmed or read back, with no gap. A read
never shows a message before the write that carries it is confirmed.

**Forward only.** Two reads by one host over one run never move
backwards. A resumed run replays the whole log first, so a read after a
resume holds everything the run before it confirmed.

**Your own writes.** A read after an acknowledged delivery holds that
delivery.

**The stream is the push side.** A listener learns nothing the pulls
cannot tell it. One `message` event per message, in record order, from
the first message the run saw.

## 4. What a lease promises

**One attempt at a time.** A wake names one message and one seat. The
seat claims a lease under the wake's id and renews it while it works.
The next attempt claims only after the last one ended.

**A lease answers what it heard.** The log says which messages a lease
heard. They are the ones it was at work for, and the ones its view held
because it was claimed after them. A lease answers them while it runs
and once it stood down, through the seq its last renewal confirmed.

**A lease that came to nothing answers nothing.** A lease that expired
or failed leaves every message it heard pending again, whatever it said.
Its words stay on the record, and the seat reads them at the next
attempt. The failure is one attempt. The room wakes the seat again after
the backoff, and at the cap it stops. `runtime.retry` holds the policy:
three attempts by default, thirty seconds after the first failure and
sixty after the second.

**A claim asked twice starts one activation.** A claim of an id the room
already runs is a renewal, and lands as a renewal row. The seat asks
again once when it never heard back. A release asked twice ends the
lease once: the second call is answered stale. A release lost twice
leaves the room to expire the lease on its side.

## 5. What the room does not promise

**Two live hosts over one log.** A host is paused, and a second host
resumes the name while it is paused. Once the first comes back, both
write from their own last seq. In memory, a seq is on the storage twice,
and a delivery the first host acknowledged is off the record the second
host reads. On JSONL, Pi refuses to load the file, and no run can open
the name again. `split.test.ts` pins both. A fence is deferred:
`planning/backlog.md` item 35 says what it takes.

**A storage that tears.** A partial line at the end of a JSONL file, a
lost `fsync`, or entries the storage reorders are not exercised. The
room reads what the storage returns.

**Clocks that disagree.** Every host in the tests shares one clock. A
resumed host whose clock runs ahead of the last run's expires its leases
early, and one that runs behind holds them past their time. No test
moves two clocks apart.

**A model that repeats itself.** A seat woken again reads its own earlier
words on the record. The room hands them to the model, and the model
decides what to add. A scripted model stands down; a real one is held
by its instructions.

## 6. What a host must do

- Retry a delivery it never heard back on under the same key.
- Resume a name after the process that ran it died, with
  `resumeSession(name, { runtime })`. The first reconcile expires what
  the dead run held.
- Run one host per name. Evict a room with `runtime.evict(name)` before
  another host takes it, and never continue a host that was paused past
  its leases.
- Read `messages()` after a resume for what the stream did not carry.

## 7. How it is proved

The scripted tier runs on a fake clock and a scripted model, so a run is
deterministic and a sweep is exhaustive. Two proofs leave the process:
the kill from outside and the `SIGSTOP` half of the split run a child on
the system clock.

| Proof                  | Test                  | What it holds                                                                                                                                      |
| ---------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| A crash at every write | `chaos.test.ts`       | One scenario, crashed before and after every append it takes, resumed and retried under the same key, ends with the same record every time         |
| A handover under load  | `hosts.test.ts`       | The same sweep with a model that fails and a seat whose say wakes a peer: the second host wakes the failed seat again, and every answer lands once |
| A kill from outside    | `chaos.test.ts`       | The scenario in a child process on JSONL, killed with `SIGKILL` at a write, resumed over the directory                                             |
| The random walk        | `property.test.ts`    | Twenty seeded steps of visits, deliveries, seat changes, clock jumps, wire faults, disk faults and crashes; the invariants hold                    |
| The history            | `consistency.test.ts` | Two people and the host take turns under a nemesis; every action is an invocation and an outcome; §2 to §4 are checked against the record          |
| The split              | `split.test.ts`       | A paused host comes back after a takeover, in process and as a process under `SIGSTOP`; what §5 says happens, happens                              |

**The history checker** lives in
[`test/support/history.ts`](../packages/ambion/test/support/history.ts).
Every host action is recorded as `invoke`, then `ok`, `fail` or `info`.
`ok` landed. `fail` was refused, with nothing landed. `info` is an
outcome the client cannot tell, because the storage, the wire or the
process failed under it. The checker reads the history, the record and
the storage together and reports every guarantee that broke:

- an acknowledged delivery is on the record once, one in doubt at most
  once, a refused one never;
- every read is a prefix of the record, a client's reads move forward,
  and every read holds every delivery acknowledged before it was asked;
- every seq on the storage names one message;
- one attempt at a wake or a draft runs at a time;
- once the room drains, nothing runs, nothing is pending, nothing is
  owed.

**The clients take turns.** The people and the host interleave at every
await, and the nemesis acts between two actions. A crash does not cut an
action in flight yet, so a delivery in doubt comes from the storage
alone in this tier. The sweeps in `chaos.test.ts` and `hosts.test.ts`
are where a crash lands inside an append.

**The nemesis** crashes the run and resumes it in a fresh runtime. It
fails the next write before or after it lands. It drops, repeats and
delays requests on the wire. It jumps the clock the way a paused process
sees it. Every run is held to a bound on the errors it reports, checked
when the run dies and at the end. The bound is the leases the run
inherited, the failures the cast injects, the room calls the nemesis
dropped, and the leases live across a jump past the expiry.

`pnpm test` runs 25 seeds of the history and the walk. `pnpm chaos` runs
200 of each, the sweep on JSONL too, the handover at every write, and
the kill at every third write.
