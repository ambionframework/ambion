# Accepted risks

The owner accepted these risks on 2026-10-05. Each one is a reproduced or
code-verified gap in robustness on main at `0d1aced`. Each entry names
the effect, the code, and what a host does about it today. An entry that
a [backlog](backlog.md) item covers links to that item.

**An entry leaves this page in one of two ways.** A fix lands and deletes
the entry. Or the risk moves to [next.md](next.md) as planned work. The
full evaluation, with the method and the claims that hold, is in the
project files under `robustness/evaluation.md`.

**The record holds.** The conditional append is atomic. A fence refuses
every stale write. A retry under the same key lands once. No risk on this
page loses or duplicates a journal entry. The risks are in liveness,
spend, signals, and resources.

| Section                                             | Entries   |
| --------------------------------------------------- | --------- |
| [Unattended rooms](#unattended-rooms)               | AR1–AR5   |
| [Failures with no signal](#failures-with-no-signal) | AR6–AR8   |
| [Leases and fences](#leases-and-fences)             | AR9–AR10  |
| [Workspace and processes](#workspace-and-processes) | AR11–AR16 |
| [Journal operations](#journal-operations)           | AR17–AR20 |

## Unattended rooms

**AR1. A short outage ends a chain of scheduled says.** The room consumes
a returned say when it posts it. The activation that follows retries 3
times, at 30 s and 60 s, and then the room records `abandoned`. Nothing
schedules the say again. A person's question closes `exhausted` after
the same outage. Code: `room/scheduled.ts`, `room/reconcile.ts`, the
`activation` limits in `host/runtime.ts`. **Today:** raise
`limits.activation.attempts` and `backoff`, and watch for `abandoned`.

**AR2. The prompt of an ambient room grows with no bound.**
`limits.context.messages` defaults to `Infinity`. An exchange with no
person owes no summary, so it never folds. The cost of each activation
grows with the record. A provider eventually refuses the prompt with a
400, which the room reads as permanent, and AR1 follows. Code:
`host/runtime.ts`, `room/view.ts`, `owesSummary` in
`room/rules.verified.ts`. **Today:** set a finite
`limits.context.messages`. [D2](backlog.md#designs-with-a-shape) holds
the design.

**AR3. No budget bounds an exchange or a room.** Two seats that direct
messages at each other wrote 324 messages in 3 s inside 2 activations.
Only `limits.lease.deadline` ends an activation, and the next message
starts a new one with no attempts spent. A seat can also keep 4
scheduled says pending at a 60 s floor. **Today:** monitor usage on the
`ended` entries. [D1](backlog.md#designs-with-a-shape) holds the design.

**AR4. The default alarm does not keep a host alive.** The timer in
`host/clock.ts` is `unref`. A host that awaits nothing exits, and a
scheduled say waits on the journal until the next resume. **Today:** keep
the event loop alive, as [Deployment](../docs/deployment.md) says.

**AR5. Sleep delays every alarm and expires every lease.** Timers run on
the monotonic clock, and the room decides on the wall clock. After a
laptop sleeps, alarms fire late, and each running lease expires at its
next renewal and spends an attempt. A backward clock step makes leases
and backoff longer. **Today:** run ambient rooms on a host that does not
sleep.

## Failures with no signal

**AR7 and AR8 can hold a room still.** AR6 hides the cause.

**AR6. A failed background write leaves no signal.** `reconcile` in
`room-run/control.ts` ends in a catch that drops the error. A failed
write arms the alarm again after `limits.port.resend` and emits nothing.
No notification names a failure at the room level. **Today:** a host
sees a storage failure only when one of its own calls fails.

**AR7. A throw from `decide` leaves no alarm.** `decide` runs before the
`try` in `onePass`. A throw there arms no alarm, and the room waits for
the next outside event. Code: `room-run/control.ts`.

**AR8. An opener that throws produces an unhandled rejection on each
resend.** `runner.ts` builds the activation state before its `try`, under
`void this.run`. No attempt is spent, no event is emitted, and the
exchange stays open. With the default Node setting, the rejection ends
the host process. **Today:** an executor must not throw from its opener.

## Leases and fences

**AR9. One lost renewal ends the activation.** `renew` in
`execution/runner.ts` makes one call with no retry. Claim and release
retry. One timed-out renewal cuts the activation at its last confirmed
expiry. The attempt repeats its tool effects. `lease.test.ts` asserts
this behavior.

**AR10. A superseded run keeps its seats running.** `evict()` in
`room-run/room.ts` cuts no port. The old run finds the fence only at its
next write, and an idle old host never finds it. Its executors call
tools until their next renewal. The new run waits for those leases to
expire, so tool effects can run in two processes. **Today:** stop the old
host before a new host resumes the room.

## Workspace and processes

**AR11. A compose child process can outlive its host.** `processRuntime`
kills its children on the `exit` event of the host. A SIGTERM with no
handler or a SIGKILL skips that event. A child in a busy loop then runs
at full CPU with no end. Code: `compose/src/process.ts`. **Today:** use
`quickjsRuntime`, or run the host under a supervisor that kills its
process group.

**AR12. An SFTP call that never returns stalls the workspace.** A
workstation file call has no deadline and no abort. A `write` to a FIFO
can block the SFTP server, and every agent waits in the one workspace
queue. This comes from the code; a real sshd has not reproduced it.

**AR13. Workspace disk grows with no bound.** The `out` file of a
process has no cap. The table keeps 64 finished process directories for
each agent. `fetch` keeps each body twice, in `~/.fetch` and as a
snapshot. Pi keeps sessions in the temporary directory and deletes none.
**Today:** set disk quotas on the workstation accounts.

**AR14. The directory backend refuses to read a file over 10 MiB, with
or without offset and limit.** [Processes](../docs/processes.md) tells an
agent to read the rest of `out` with `read`, which fails for a process
with more than 10 MiB of output.

**AR15. An adopted process keeps running past its timeout until a read.**
`adopt` arms the timeout again only inside `observe`. No package calls
`processes.list` when a host starts. **Today:** call
`workspace.processes.list({ agent })` for each agent after a restart.

**AR16. The failure classifier reads permanence from free text.** A
proxy error page that contains "unauthorized" ends an activation in one
attempt. Code: `execution/failure.ts`.

## Journal operations

**AR17. One malformed entry makes a room unresumable.** The journal
checks an entry before it moves its cursor, so every later read fails at
the same position. The error names no position. No tool inspects or
repairs a journal, and no format marker names the release that wrote it.

**AR18. A storage call that never settles hangs the room.** `stop()`,
`read()`, and every write wait with no deadline, and the room name stays
taken. The shipped storages are synchronous, so only a custom async
storage or Durable Object storage reaches this.

**AR19. The library sets no SQLite pragma.** The Node defaults are
durable. A host that sets WAL with `synchronous=NORMAL` can lose an
acknowledged append on power loss. `busy_timeout` is 0, so a lock held
by another process refuses a write at once. **Today:** keep
`synchronous=FULL` and keep other processes off the file.

**AR20. Replay cost grows faster than the record.** At 100,000 entries,
the projection replays in 13–16 s and holds about 170 MB. Each live
entry costs time in proportion to the history, because the projection
copies whole containers. No snapshot exists. CI runs the crash sweep on
memory storage only; `pnpm chaos` runs it on SQLite.
