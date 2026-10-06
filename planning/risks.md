# Accepted risks

The owner accepted these risks on 2026-10-05. Each one is a reproduced or
code-verified gap in robustness on main at `0d1aced`. Each entry names
the effect, the code, and what a host does about it today. An entry that
a [backlog](backlog.md) item covers links to that item.

**An entry leaves this page in one of two ways.** A fix lands and deletes
the entry. Or the risk moves to [next.md](next.md) as planned work. The
plan for 1.0.0 took the risks of retries, prompt size, sleep, silent
failures, leases, workspace disk, restarts, malformed entries, and SQLite
settings. The entries below stay open after 1.0.0.

**The record holds.** The conditional append is atomic. A fence refuses
every stale write. A retry under the same key lands once. No risk on this
page loses or duplicates a journal entry.

| Section                 | Entries    |
| ----------------------- | ---------- |
| [Spend](#spend)         | AR3        |
| [Processes](#processes) | AR11, AR12 |
| [Signals](#signals)     | AR16       |
| [Storage](#storage)     | AR18, AR20 |

## Spend

**AR3. No budget bounds an exchange or a room.** Two seats that direct
messages at each other wrote 324 messages in 3 s inside 2 activations.
Only `limits.lease.deadline` ends an activation, and the next message
starts a new one with no attempts spent. A seat can also keep 4
scheduled says pending at a 60 s floor. **Today:** monitor usage on the
`ended` entries. [D1](backlog.md#designs-with-a-shape) holds the design.

## Processes

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

## Signals

**AR16. The failure classifier reads permanence from free text.** A
proxy error page that contains "unauthorized" ends an activation in one
attempt. Code: `execution/failure.ts`. UR1 in the plan makes a transient
failure cost less, and it does not change this classifier.

## Storage

**AR18. A storage call that never settles hangs the room.** `stop()`,
`read()`, and every write wait with no deadline, and the room name stays
taken. The shipped storages are synchronous, so only a custom async
storage or Durable Object storage reaches this.

**AR20. Replay cost grows faster than the record.** At 100,000 entries,
the projection replays in 13–16 s and holds about 170 MB. Each live
entry costs time in proportion to the history, because the projection
copies whole containers. No snapshot exists. A snapshot is a cache of
the projection, so it can arrive after 1.0.0 with no change of format.
