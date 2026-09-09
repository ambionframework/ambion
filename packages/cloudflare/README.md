# @ambionframework/cloudflare

A room as Cloudflare Durable Objects. One object holds the room, one object
holds each seat, and the log lives in the room object's SQLite storage.

What is built:

- **`SqliteSessionStorage`** implements Pi's `SessionStorage` over
  `ctx.storage.sql`: one `entries` table, one `lanes` table, one `meta`
  table. It implements what `Session.appendCustomEntry`, `appendMessage`
  and `findEntries` reach. Every other method throws `not supported`.
  `sqlSessions(state)` is a `SessionOpener` over it.
- **`RoomObject`** runs the room. Its constructor resumes the room the
  storage names, over `resumeSession`. It exposes `start`, `visit`,
  `deliver`, `leave`, `seat`, `unseat`, `abort`, `messages`, `seats` and
  `exchange` over RPC, and the three calls a seat makes: `view`, `commit`
  and `lease`. Its `alarm()` runs `reconcile()`.
- **`SeatObject`** runs one seat. `wake` stores the activation id and sets
  an alarm; `alarm()` claims the lease, reads the view, runs the activation
  to its end, and releases the lease. `steer` forwards to the activation in
  flight. The seat's audit session lives in its own storage.
- **`configure`** names the agent definitions the objects resolve by name,
  and the model call they make.

The package is private, and nothing deploys it. `pnpm test` runs its three
tests inside workerd, through `@cloudflare/vitest-pool-workers`, as part of
the repository's `turbo test`. The tests serialize every value that crosses
between a seat and its room, which is what the design in
[`docs/agent.md`](../../docs/agent.md) §5 promises. `subscribe` over RPC is
not built.
