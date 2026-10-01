# @ambionframework/cloudflare

**Run Ambion rooms and agents on Cloudflare Durable Objects.**
One Durable Object holds the room and one holds each seat. Each object uses
its own SQLite storage for the journals it owns.

This package supplies the Durable Object adapter for a Cloudflare Worker.
It joins the lockstep release on GitHub Packages. RPC, alarms, serialization,
and recovery tests run inside workerd. Deployment commands remain future work.
See [Deployment and recovery](../../docs/deployment.md) for host responsibilities.

What is built:

- **`sqlStorage(state)`** opens one native journal backend over the object's
  SQLite. The runtime derives room journals from it.
  Room and seat objects keep their durable metadata in one row each of the
  `ambion_metadata` table, beside the room journals.
  This package only wraps `ctx.storage.sql` in `run` and `all` (`sqlOver`).
- **`RoomObject`** runs the room. Its constructor resumes an initialized room
  unless explicitly stopped; an uninitialized named record waits for
  an explicit `start`. It exposes `start`, `visit`, `send`, `leave`, `seat`,
  `unseat`, `abort`, `read`, `exchange`, `dismiss`,
  `waitForClose` and `waitForSummary` over RPC, and the three calls a seat makes: `view`, `commit`
  and `lease`. Its runtime reaches each seat through `rpcExecution`, an
  execution with no kind whose port calls the seat object over RPC. Its
  `alarm()` runs `Room.reconcile()`.
  Identity and presence come from the room journal, and the object keeps no
  copy. `send` and `leave` take the visit with `visitOf` from the hosting
  entry, so a restart reaches only present humans. `send` never enters the
  room implicitly. Explicit `visit` ensures presence, and repeated `leave` is
  harmless.
- **`SeatObject`** runs one seat. `wake` stores the activation id and sets an
  alarm; `alarm()` claims the lease, reads the view, runs the activation and
  whatever queued behind it to their end, and releases the lease. A second
  `alarm()` while a run is live in the object returns at once. An `alarm()`
  that finds a run that an eviction lost calls `AgentRunner.recover`, which
  releases the activation as failed. The recovery needs the definition of the
  seat. For a seat that the worker no longer configures, the recovery fails,
  and the room ends the lease of the lost run only when the lease expires.
  `steer`
  delivers a recorded message to its exact running activation. It writes no
  activation metadata and sets no alarm. Unread messages remain recoverable
  from the room journal. `cut` stops the activation the room ended. The seat
  gives the steps of each activation to the `logger` that `configure` takes.
  Absent, it drops them. The seat object runs the execution of its own host:
  it connects the Pi execution of the worker once, and the `AgentRunner` and
  its executor live on the object instance. The executor keeps the Pi harness
  sessions of the seat in a `MemorySessionRepo` there. An eviction loses the
  sessions, and the next activation starts fresh. The seat object does not
  create a room.
- **`configure`** names the complete agent definitions the objects resolve by
  name, the model call they make, and an optional `logger` for the steps of
  each activation. To send the steps to Workers Logs, pass
  `(traced) => console.log({ ambion: 'step', ...traced })`. Its `estimators`
  go to the runtime of the room object, which windows each view: an agent
  with `activationTokenLimit` names one of them, or `length`, in
  `estimateTokens`.

`RoomObject.start` receives the complete agent definitions in `agents`, an optional
`summary` name, and an optional `seats` map. The map sets initial members and
attention. An omitted map seats every supplied agent at `broadcast`; an empty
map starts them in the reserve. `seat` and `unseat` take names and cannot
install a new definition. The room metadata retains the definition names, so
automatic resume resolves the same definitions through `configure`. Resume
requires definition names in the room metadata. Every seat uses the same room
tools, including `say`, `seat`, and `unseat`.

`read()` returns the detached coherent room projection, including stopped
records. Messages, participants, exchanges, and the read position `through` come from
it. The alarm calls `reconcile()` on the running room. The live `waitForClose()` and `waitForSummary()` conveniences retain their wait behavior
and require a running room. Use `read()` to inspect a stopped open exchange or
its recorded summary outcome.

`pnpm test` runs the adapter tests inside workerd, through `@cloudflare/vitest-pool-workers`, as part of
the repository's `turbo test`. The tests serialize every value that crosses
between a seat and its room, which is what the
[execution boundary](../../docs/executors.md#the-executor-contract) promises. `subscribe` over RPC is
not built.
