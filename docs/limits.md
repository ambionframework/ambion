# Limits and fold cost

**This page owns two subjects: the configurable limits of a room and the
measured cost of its fold.** Other pages link here and do not repeat the
figures. The fold cost is the time to derive room state from the journal.
[Durability](durability.md) owns the journal entry contract.
[Formal](formal.md) owns the proof scope.

## The limits

**One `limits` value bounds every room in a runtime.** A host passes a
partial value and the runtime fills each missing field with the default in
the table. `Limits` in
[`host/runtime.ts`](../packages/ambion/src/host/runtime.ts) is the type.

| Field                             | Bounds                                                      | Default                |
| --------------------------------- | ----------------------------------------------------------- | ---------------------- |
| `limits.port.resend`              | How long a wake stays unanswered before the room resends it | 5,000 ms               |
| `limits.lease.ttl`                | How long a lease lasts from each claim or renewal           | 60,000 ms              |
| `limits.lease.deadline`           | How long an activation runs from its first claim            | 600,000 ms             |
| `limits.activation.attempts`      | Attempts the room makes at one due activation               | 3                      |
| `limits.activation.backoff`       | The wait before each retry, from the attempt number         | `attempt * 30_000` ms  |
| `limits.call.timeout`             | Each executor call to the room                              | 10,000 ms              |
| `limits.call.attempts`            | Retries of a claim or a release                             | 2                      |
| `limits.context.messages`         | Messages one view holds beyond the open exchange            | unbounded (`Infinity`) |
| `limits.message.bytes`            | UTF-8 bytes in one said message or summary text             | unbounded (`Infinity`) |
| `limits.schedule.minDelaySeconds` | The least `delaySeconds` of a scheduled say                 | 60                     |
| `limits.schedule.maxDelaySeconds` | The most `delaySeconds` of a scheduled say                  | 604,800 (7 days)       |
| `limits.schedule.waiting`         | Scheduled says of one seat that wait to return              | 4                      |
| `limits.trace.toolOutputBytes`    | Bytes of tool output that a logged step keeps               | 65,536                 |
| `limits.trace.stepsPerPass`       | Steps that one pass logs                                    | 1,000                  |

**Two limits change what the room does with a message.**
`limits.context.messages` windows the view and refuses nothing. The room
refuses a text over `limits.message.bytes` with `message_too_large`.
[Room](room.md) owns the windowing rules under "History and limits".

**Three limits change how work ends.** The room renews no lease past
`limits.lease.deadline`, so an activation that runs on expires and counts
as an attempt. The view carries that time as `deadline`, so a tool that
waits returns before it. `limits.activation.attempts` caps those attempts. The
journal stays authoritative when a timed out call reached the room.
[Durability](durability.md) owns the lease, retry, and delivery rules.

**No limit caps an exchange.** Deadlines and retry caps bound one
activation. A continuing contribution keeps an exchange open.
[Deployment](deployment.md) covers the limits a host adds.

## The limits of a compose call

**The `compose` option of a seat bounds each compose call.** A field that
the option leaves out keeps its default.
[Compose](compose.md#limits) states what each limit does when a call passes
it.

| Field                       | Bounds                                               | Default    |
| --------------------------- | ---------------------------------------------------- | ---------- |
| `compose.limits.calls`      | Nested calls in one compose call                     | 64         |
| `compose.limits.concurrent` | Nested calls that run at the same time               | 8          |
| `compose.limits.bytes`      | UTF-8 bytes of the encoded return value              | 65,536     |
| `compose.limits.time`       | Wall time of one compose call, within `ctx.deadline` | 120,000 ms |

## The cost of the fold

**The claim is a shape.** The oracle `foldRoom` in
[`test/support/fold.ts`](../packages/ambion/test/support/fold.ts) replays
the whole journal. Its cost grows with the length of the history. The
incremental projection in
[`room/projection.ts`](../packages/ambion/src/room/projection.ts) updates
the addressed fields that one entry changes. It still copies whole
containers for each entry, so a new question costs more as the history
grows. The table below shows it, and replay grows faster than the
history ([Accepted risks](../planning/backlog.md#accepted-risks)).

**The projection is a cache.** It is the one derivation of the room state
that the room runs, and `foldRoom` is the oracle that the tests compare it
with. A resumed room and `readRoom` rebuild the projection with `replay`.
The projection writes no durable checkpoint.

**One measurement shows the shape.** The run below used Node 26.9 on an
Apple silicon laptop on 2026-09-20. Each closed exchange holds a question,
an answer, a close, and a summary. The figures vary with the machine and
the load. They promise nothing.

| Closed exchanges | Fold (ms) | Replay (ms) | Question, reference (ms) | Question, incremental (ms) |
| ---------------- | --------- | ----------- | ------------------------ | -------------------------- |
| 100              | 10        | 3           | 12.9                     | 0.2                        |
| 1,000            | 685       | 58          | 1,090.8                  | 1.1                        |
| 4,000            | 11,440    | 735         | 17,249.6                 | 4.8                        |

**Reproduce it with one command.** The bench is manual because timing is
too noisy for the gate.

```sh
node scripts/projection-cost.mjs 100 1000 4000
```

**The gate checks the result and not the time.** The property test in
[`projection-equivalence.test.ts`](../packages/ambion/test/projection-equivalence.test.ts)
compares the projection with `foldRoom` under cancellation, reseating,
late summaries, takeover, and restart. It runs 50 seeds. Set `AMBION_SEEDS`
to widen the run. The context window bounds model input and does not bound
the replay of the journal on resume.
