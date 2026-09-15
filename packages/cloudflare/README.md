# @ambionframework/cloudflare

**A private reference implementation of Ambion's collaboration protocol.**
One Durable Object holds the room and one holds each seat. Each object uses
its own SQLite storage for the journals it owns.

For 0.1.0, this package validates separate room and agent hosts through RPC,
alarms, serialization, and recovery tests. It is not a published deployment
product. See [Deployment and recovery](../../docs/deployment.md) for support
levels and host responsibilities.

What is built:

- **`sqlStorage(state)`** opens one native journal backend over the object's
  SQLite. The runtime derives room journals and Pi audit sessions from it.
  Room and seat objects store their durable metadata under their own names.
  This package only wraps `ctx.storage.sql` in `run` and `all` (`sqlOver`).
- **`RoomObject`** runs the room. Its constructor resumes the room the
  storage names, over `resumeRoom`. It exposes `start`, `visit`,
  `send`, `leave`, `seat`, `unseat`, `abort`, `messages`, `seats`,
  `exchange`, `exchangeMessages` and `response` over RPC, and the three calls a seat makes: `view`, `commit`
  and `lease`. Its `alarm()` runs `reconcile()`.
- **`SeatObject`** runs one seat. `wake` stores the activation id and sets
  an alarm; `alarm()` claims the lease, reads the view, runs the activation
  and whatever queued behind it to their end, and releases the lease.
  `steer` delivers a recorded message to its exact running activation. It
  writes no activation metadata and sets no alarm. Unread messages remain
  recoverable from the room journal. `cut` stops the activation the room ended. The seat's audit session lives in its own
  storage.
- **`configure`** names the agent definitions the objects resolve by name,
  and the model call they make.

The package is private, and nothing deploys it. `pnpm test` runs its three
tests inside workerd, through `@cloudflare/vitest-pool-workers`, as part of
the repository's `turbo test`. The tests serialize every value that crosses
between a seat and its room, which is what the design in
[`docs/agent.md`](../../docs/agent.md) §5 promises. `subscribe` over RPC is
not built.
