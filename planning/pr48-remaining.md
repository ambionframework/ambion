# What is left of PR 48

PR 48 is the branch `SPLIT_PLAN.md` cut into fifteen pull requests. This
page says what each one still needs, after what landed on `main` and
what the open pull request carries. Read it with the plan on the PR 48
head, tagged `split-source` in a local clone.

## Landed

| Plan | Pull request | What it is                                                                 |
| ---- | ------------ | -------------------------------------------------------------------------- |
| 1    | #49          | The `Runtime` value, the layers, the harness                               |
| 2    | #50          | One serial commit queue, under a key                                       |
| 3    | #51          | The seat side behind three JSON calls                                      |
| 4    | #52          | The composition, the identities and every close on the log; the fold       |
| 5    | #53          | Leases on the log, `decide`, `resumeSession`, `runtime.evict`              |
| 6    | #54          | The chaos tier: a crash at every write, a kill, the walk; the doubt path   |
| 7    | #56          | Wake attempts; who heard a message, read off the log's order; the handover |
|      | #57          | The history tier and `docs/durability.md` (outside the plan)               |
|      | #59          | The run row as the fence; LemmaScript on the real rules (outside the plan) |
| 8    | #61          | The review fixes: the seat's wake queue, `free`, the commit's stale check  |
| 9    | #62          | `cut` on the wire, so a seat in another process stops now                  |
| 10   | #64          | A deadline on every activation, and the cut the seat takes at it           |
| 11   | #66          | A row at the cap: the room says when it gives up                           |
| 13a  | #68          | The SQLite storage in the core, over a two-call `Sql` port                 |
| 13b  | #70          | The conditional append, so a fenced run's write is refused                 |
| 12   | #69          | The checkpoint row, and the compaction that reads it                       |
| 14   | #71          | A room as Durable Objects, one per room and one per seat                   |
| 15   | this branch  | The demo that crashes, its report, and the example on both hosts           |

Two things the plan gave PR 7 landed another way. `heard` on the lease
rows is not needed: the fold reads who was at work when a message landed
from the position of the rows. `wakes` naming the seats at work is not
needed for the same reason. What PR 7 still owes is below.

## PR 7, the remainder: the live proof of a resume

**Scope.** `test/live/resume.test.ts` from the branch: a room on a real
model dies mid-activation, a second runtime resumes it, and the seat
answers again after the backoff. `test/live/loop.test.ts` from `2b0c65b`
where it differs from `main`.

**What it needs.** The two test files only. The runtime side is on
`main`. `test/live/support.ts` may need the fake clock the kill test
uses, so the wait for the expiry does not cost sixty real seconds.

**Size.** Small. One day.

## The order

PR 7's remainder is the last step of the plan. It needs a provider key,
and it reads better now that the room abandons at the cap.
