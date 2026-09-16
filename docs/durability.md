# Durability

What the room promises about its record when the process, the storage,
the wire or a model fails, and how the promise is proved. This page is
the contract. The chaos tier and the history checker hold the room to it.
Read it with [`agent.md`](agent.md) §5, which names the mechanisms, and
[`toolchain.md`](toolchain.md) §8, which says how the tiers run.
[Deployment and recovery](deployment.md) separates current evidence from
0.1.0 support targets and describes host responsibilities.

## 1. The journal is the source of collaboration state

**One record, one writer, one order.** A room's record is one append-only
journal in journal storage. One counter gives out every place: a message takes
the next seq, and so does every entry the room writes beside the messages.
A seq names one entry of any kind, so the messages are not contiguous. The
fold reads the journal from the start and rebuilds the room from it. That
is the roster, the people, the open exchange, every lease, every wake still
pending and every summary still owed. Nothing the room holds
in memory outlives what the journal says.

**The envelope is the journal's, and the body is the caller's.** The
storage holds one nested value with `kind`, `body`, `seq`, `key`, and `run`.
`seq` is the place the entry took. `key` names the commit. `run` names the writer. The
journal reads those three, and it reads a body only to ask the room
whether the body is one the room takes. A reader that wants the place of
an entry reads it off the entry. One fact stands in one field.

**One append operation handles every entry kind.** The journal reads recovery
entries before it evaluates the caller's synchronous decision. That decision
proposes a body or returns a result without writing. A repeated key returns
its original entry before the decision runs. Keys cover all accepted kinds;
reusing a key for another kind fails explicitly.

**The room owns message freshness.** Its projection contains the messages and
last message position. The room checks consumed context inside the append
decision. A lease renewal advances the journal sequence without changing
message freshness. The journal keeps no separate message cache or freshness
rule.

**The room validates stored bodies before replay.** A malformed body under a
recognized kind stops the read with a diagnostic. An unknown kind remains
outside the room vocabulary. These checks preserve the existing envelope and
storage layout.

**The room reacts to the journal, and to nothing else.** The journal tells the room
about every entry it takes, and the room has one reaction per entry. An
entry this run appended and an entry a read found reach the room the same
way, so a message another run wrote, and a message whose confirmation this
run lost, become an event and a wake exactly as a message this run
committed does. The room writes down to the journal and hears back up from it,
and it holds no second path for the entries it wrote itself.

**Durable means the storage's append resolved.** The default memory journal
holds the record for the process lifetime. SQLite persists the journal. A
storage that lies about an append breaks every promise below.

**One run per name, fenced by one entry.** `startRoom` and
`resumeRoom` refuse a name the runtime already runs. Across runtimes,
the journal fences. The first entry every run writes is its fence, with a
fresh run id, and every entry the run writes carries that id. The fence
is positional: a reader passes the storage in order, and a fence moves
to that run. An entry of another run past the fence is void,
and every reader skips it, the fencing run included. A run reads the
storage before every write. A run that passes its own fence and then a
fence of another run has lost the name: it emits `superseded`, drops
itself from memory, and writes nothing more. A fence that lands late
voids every run whose fence came before it, even when its own run is
gone, so a live run can lose the name to a dead one. §5 says what a
superseded run loses, and where the fence does not reach.

**The journal retains the complete history.** Room state is derived from the
ordered entries on every run. Messages and administrative entries remain
available together, so replay has one source of truth and idempotency keys
remain durable for the life of the journal.

## 2. What a delivery promises

**Acknowledged: on the record once.** `visit.send()` resolves once the
write is confirmed and returns the exchange handle associated with the
committed question. The message is on the record and on the stream, and
the wake is sent to every seat it reaches. It stays on the record for
the life of the journal.

**Refused: nowhere.** A message the room refuses rejects `visit.send()`
before anything lands. The visit is over, the room is stopped, or the
recipient is not in the room. Nothing is on the record, nothing is on
the stream, and nobody woke.

**Superseded: void.** A write the run held while another run took the
name lands past the fence. The run acknowledges it, and no reader holds
it. A host that evicted the run, or heard `superseded`, treats every
answer from that run as no answer.

**In doubt: at most once.** A write the storage failed, or a process that
died with the write in flight, leaves the host without an answer. The
message is on the record or it is not. The room reads the storage back
before its next write, so a message that landed is on the record before
anything lands on top of it. `visit.send({ key })` names the message's idempotency token. A host that
never learned whether a question landed sends it again under the same token,
and the token lands once. The repeated call returns the same exchange handle.

**The token is on the record, and it never expires.** The message the
token landed carries it back on `messages()`, so a host reads which
delivery a message was and holds the room to the promise above. The
journal indexes every record entry's token as it takes the entry, on a
replay as well as on an append, so a host that retries after a crash
meets the token the storage holds. Every record entry stays durable, so the
journal holds no dedup window and no token ages out.

## 3. What a read promises

**A prefix, in order.** `messages()` returns the record from seq 1 to
the last seq the run has confirmed or read back, with no gap. A read
never shows a message before the write that carries it is confirmed.

**Forward only.** Two reads by one host over one run never move
backwards. A resumed run replays the whole journal first, so a read after a
resume holds everything the run before it confirmed.

**Your own writes.** A read after an acknowledged send holds that message.

**The stream is the push side.** A listener learns nothing the pulls
cannot tell it. One `message` event per message, in record order, from
the first message the run saw.

## 4. What a lease promises

**One attempt at a time.** A wake names one message and one seat. The
seat claims a lease under the wake's id and renews it while it works.
The next attempt claims only after the last one ended.

**A lease records explicit acknowledged context.** A running lease holds
work while its executor runs. Completed work requires the executor's
`readThrough`: the highest contiguous position whose context entered a
provider request, including its own accepted ordinary messages.
Renewal advances this position only when the executor reports progress.
The release records its final position; unread work remains pending.
Explicit revocation and abandonment resolve their named work without
claiming context consumption.

**Steering cannot acknowledge a gap.** Each steer names a range between
message positions. Structured context metadata identifies ranges submitted
to the provider. Duplicate or reordered ranges cannot skip missing context.
A later fresh view recovers messages that steering failed to deliver.

**The room says when it gives up.** At the cap the room writes the
attempt it does not make, ended `abandoned`, and the host hears an
`abandoned` event. The entry answers the wake or the close it stood for, so
no reader sees the room still owing it, and the record says the room
stopped trying.

**A lease that came to nothing answers nothing.** A lease that expired
or failed leaves every message it heard pending again, whatever it said.
Its words stay on the record, and the seat reads them at the next
attempt. The failure is one attempt. The room wakes the seat again after
the backoff, and at the cap it stops. `runtime.retry` holds the policy:
three attempts by default, thirty seconds after the first failure and
sixty after the second.

**No lease runs past its deadline.** The room caps the expiry of every
claim and every renewal at the claim time plus `runtime.wake.deadline`,
ten minutes by default. A renewal that moves the expiry nowhere tells the
seat the lease reached the deadline, and the seat cuts the activation
there. The room expires the lease on its alarm, so an activation that
runs on is one attempt that came to nothing.

**A claim asked twice starts one activation.** A claim of an id the room
already runs is a renewal, and lands as a renewal. The seat sends a call
again when it never heard back, up to `runtime.call.attempts`. A release
asked twice ends the lease once: the second call is answered stale. A
release no attempt got through leaves the room to expire the lease on its
side.

**Audit failure does not create failed collaboration work.** The executor
determines the model outcome separately from transcript persistence. Failed
audit writes receive one retry with stable entry identities. A write whose
acknowledgement was lost can be recovered without duplicate transcript entries.

An exhausted audit emits `audit_error`. Successful speech and deliberate
silence still release their activation normally. A provider failure keeps its
execution retry policy, even when its audit also fails. Unconfirmed audit
data can be lost on process failure; no durable audit backlog is promised.

## 5. What the room does not promise

**An append that read an old head is not acknowledged.** The journal passes
each append the position its read left. The entry lands next to that position,
or storage reports that the head moved and writes nothing. A resumed host can
move the head while another host holds an append. That append is refused before
the first host acknowledges it. A client may send again under the same key.

**Two live hosts over storage without conditional append.** Such a host
cannot use that storage for a room journal. The storage contract refuses a
host that cannot atomically append at the position it read.

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

**What one platform gives.** `packages/cloudflare` holds a room in one
Durable Object, over the core's SQLite storage on the object's own
`ctx.storage.sql`. The platform gives one instance per id, and the object
resumes in its constructor, so the room's writer and its storage share a
lifetime. An instance the platform took away is fenced by the resume's
fence, and its late write is void. The storage refuses an append the record
moved under, so that write is refused rather than acknowledged.

## 6. What a host must do

[Deployment and recovery](deployment.md#restore-human-presence) gives the
host procedure for presence, client cursors, exchange handles, and leases.

- Retry a send it never heard back on under the same key; the journal
  returns the original exchange handle identity.
- Resume a name after the process that ran it died, with
  `resumeRoom(name, { runtime, agents })`. Supply definitions again. Recovery
  depends on lease expiry and whether executors died or remain active remotely.
- Run one host per name. Evict a room with `runtime.evict(name)` before
  another host takes it. Treat `superseded` the way it treats its own
  eviction: nothing that run answers from then on is an answer, and the
  host resumes the name again. A stop on a superseded run resolves, and
  the event says why it wrote nothing.
- Retry a resume the storage failed: the fence is the first write a
  resumed run makes.
- Recreate visits from authenticated identities. Preserve recorded presence
  until the host confirms a departure.
- Recreate subscriptions before reading `messages({ since })`. Merge overlaps
  by sequence and advance client cursors after consumption.
- Reacquire exchange handles with `room.exchange(from)` and recreate pending waits.
- Preserve unexpired remote leases. Reconnect runners to the current room host;
  let expired leases follow the normal retry policy.

**A host that may run two runs over one name needs conditional append.**
The core's SQLite storage compares the storage position and writes the next
row in one statement. A writer that raced is refused and reads again. The
journal stamps its envelope seq before it appends and caches it after success.

## 7. How it is proved

The scripted tier runs on a fake clock and a scripted model, so a run is
deterministic and a sweep is exhaustive. Two proofs leave the process:
the kill from outside and the `SIGSTOP` half of the split run a child on
the system clock.

| Proof                  | Test                  | What it holds                                                                                                                                            |
| ---------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A crash at every write | `chaos.test.ts`       | One scenario, crashed before and after every append it takes, resumed and retried under the same key, ends with the same record every time               |
| A handover under load  | `hosts.test.ts`       | The same sweep with a model that fails and a seat whose say wakes a peer: the second host wakes the failed seat again, and every answer lands once       |
| A kill from outside    | `chaos.test.ts`       | The scenario in a child process over SQLite, killed with `SIGKILL` at a write, resumed over the directory                                                |
| The random walk        | `property.test.ts`    | Twenty seeded steps of visits, deliveries, seat changes, clock jumps, wire faults, disk faults and crashes; the invariants hold                          |
| The history            | `consistency.test.ts` | Two people and the host take turns under a nemesis; every action is an invocation and an outcome; §2 to §4 are checked against the record                |
| The split              | `split.test.ts`       | A paused host comes back after a takeover: in process, the fence holds and it loses the one write it held; under `SIGSTOP` on JSONL, Pi refuses the file |
| The rules              | `rules.verified.ts`   | The pure rules the journal and the fold decide by carry contracts, and Dafny proves them: the next seq, rule 5, the fence, who heard a message, the cap  |

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
await, and the nemesis acts between two actions, with one exception. A
cut takes the next append a client makes. It holds the append, crashes
the run and resumes the name while the append is held, and then lets it
land past the fence. An answer from a run that lost the name while the
action ran is recorded as `info`.

**The nemesis** crashes the run and resumes it in a fresh runtime, and
cuts it with an append in flight. It fails the next write before or
after it lands. It drops, repeats and delays requests on the wire. It
jumps the clock the way a paused process sees it. Every run is held to a
bound on the errors it reports, checked when the run dies and at the
end. The bound has four parts: the leases the run inherited, the
failures the cast injects, the room calls the nemesis dropped, and the
leases live across a jump past the expiry.

**The rules are proved.** The pure rules in
[`journal/rules.verified.ts`](../packages/journal/src/rules.verified.ts)
and
[`room/rules.verified.ts`](../packages/ambion/src/room/rules.verified.ts)
carry `//@ requires` and `//@ ensures` contracts. LemmaScript turns them
into Dafny obligations, and CI proves them on every push. The journal and
the fold run these bodies, so the proof is about the code that runs. The
rules are the next seq, the refusal of a commit that read too little,
the fence, what supersedes a run, when a lease is expired, who was at
work when a message landed, who heard it, and the cap on attempts. The
proof says what each rule decides. The tests say what the room does with
the decision.

`pnpm test` runs 25 seeds of the history and the walk. `pnpm chaos` runs
200 of each, the sweep on JSONL too, the handover at every write, and
the kill at every third write.
