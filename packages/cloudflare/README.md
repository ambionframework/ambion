# @ambionframework/cloudflare

A room as Cloudflare Durable Objects. One object holds the room, one object
holds each seat, and the log lives in the room object's SQLite storage.

What is built:

- **`sqlSessions(state)`** is a `SessionOpener` over the object's SQLite.
  The core owns the storage (`sqliteSessions` in `@ambionframework/ambion`):
  this package wraps `ctx.storage.sql` in the two calls it makes, `run` and
  `all` (`sqlOver`).
- **`RoomObject`** runs the room. Its constructor resumes the room the
  storage names, over `resumeSession`. It exposes `start`, `visit`,
  `deliver`, `leave`, `seat`, `unseat`, `abort`, `messages`, `seats` and
  `exchange` over RPC, and the three calls a seat makes: `view`, `commit`
  and `lease`. Its `alarm()` runs `reconcile()`.
- **`SeatObject`** runs one seat. `wake` stores the activation id and sets
  an alarm; `alarm()` claims the lease, reads the view, runs the activation
  and whatever queued behind it to their end, and releases the lease. A wake
  that arrives while an activation runs is handed to the actor, which steers
  the message in; `cut` is handed to it the same way, and stops the
  activation the room ended. The seat's audit session lives in its own
  storage.
- **`configure`** names the agent definitions the objects resolve by name,
  and the model call they make.

The package is private, and nothing deploys it. `pnpm test` runs its three
tests inside workerd, through `@cloudflare/vitest-pool-workers`, as part of
the repository's `turbo test`. The tests serialize every value that crosses
between a seat and its room, which is what the design in
[`docs/agent.md`](../../docs/agent.md) §5 promises. `subscribe` over RPC is
not built.
