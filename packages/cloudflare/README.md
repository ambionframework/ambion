# @ambionframework/cloudflare

**Run Ambion rooms and agents on Cloudflare Durable Objects.**
One Durable Object holds the room and one holds each seat. Each object uses
its own SQLite storage for the journals it owns.

This package supplies the adapter used by `ambion new` and `ambion dev`.
It joins the lockstep release on GitHub Packages. RPC, alarms, serialization,
and recovery tests run inside workerd. Deployment commands remain future work.
See [Deployment and recovery](../../docs/deployment.md) for host responsibilities.

Create a runnable project with the [CLI](../cli/README.md):

```sh
ambion new my-team
```

What is built:

- **`sqlStorage(state)`** opens one native journal backend over the object's
  SQLite. The runtime derives room journals and Pi audit sessions from it.
  Room and seat objects store their durable metadata under their own names.
  This package only wraps `ctx.storage.sql` in `run` and `all` (`sqlOver`).
- **`RoomObject`** runs the room. Its constructor resumes an initialized room
  unless explicitly stopped; an uninitialized named record waits for
  an explicit `start`. It exposes `start`, `visit`, `send`, `leave`, `seat`,
  `unseat`, `abort`, `read`, `exchange`,
  `waitForClose` and `waitForSummary` over RPC, and the three calls a seat makes: `view`, `commit`
  and `lease`. Its `alarm()` runs `reconcileRoom`.
  Identity and presence come from the room journal. Restart restores handles
  only for present humans; `send` never enters the room implicitly. Explicit
  `visit` ensures presence, and repeated `leave` is harmless.
- **`SeatObject`** runs one seat. `wake` stores the activation id and sets
  an alarm; `alarm()` claims the lease, reads the view, runs the activation
  and whatever queued behind it to their end, and releases the lease.
  `steer` delivers a recorded message to its exact running activation. It
  writes no activation metadata and sets no alarm. Unread messages remain
  recoverable from the room journal. `cut` stops the activation the room ended. The seat's audit session lives in its own
  storage.
  It composes `AgentRunner` services directly from that storage and the worker
  configuration. It does not create a room runtime.
- **`configure`** names the complete agent definitions the objects resolve by name,
  and the model call they make.

`RoomObject.start` receives the complete agent definitions in `agents`, an optional
`summary` name, and an optional `seats` map. The map sets initial members and
attention. An omitted map seats every supplied agent at `broadcast`; an empty
map starts them in the reserve. `seat` and `unseat` take names and cannot
install a new definition. The room metadata retains the definition names, so
automatic resume resolves the same definitions through `configure`. Resume
requires definition names in the room metadata. Every seat uses the same room
tools, including `say`, `seat`, and `unseat`.

`read()` returns the detached coherent room projection, including stopped
records. Messages, participants, exchanges, and the watermark come from
it. The alarm calls `reconcileRoom` from the hosting entry, which reaches
the running room by name. The live `waitForClose()` and `waitForSummary()` conveniences retain their wait behavior
and require a running room. Use `read()` to inspect a stopped open exchange or
its recorded summary outcome.

`pnpm test` runs the adapter tests inside workerd, through `@cloudflare/vitest-pool-workers`, as part of
the repository's `turbo test`. The tests serialize every value that crosses
between a seat and its room, which is what the
[execution boundary](../../docs/agent.md#execution-boundary) promises. `subscribe` over RPC is
not built.
