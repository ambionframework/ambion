# @ambionframework/cloudflare

**Run Ambion rooms and agents on Cloudflare Durable Objects.** One Durable
Object holds the room and one holds each seat. Each object uses its own
SQLite storage for the journals it owns. RPC, alarms, serialization, and
recovery tests run inside workerd.

## Install

```sh
npm install @ambionframework/ambion @ambionframework/journal @ambionframework/pi @ambionframework/cloudflare
```

Every package needs Node 22.19 or newer. The packages install from npmjs with
no token. A dev build of `main` installs from GitHub Packages; see
[the toolchain guide](https://github.com/ambionframework/ambion/blob/main/docs/toolchain.md#9-release-and-publishing).

## Use

A worker calls `configure` at module scope and exports the two object
classes. The package ships no deployment commands.
[Deployment and recovery](https://github.com/ambionframework/ambion/blob/main/docs/deployment.md)
states the host responsibilities.

```ts
import { defineAgent } from '@ambionframework/ambion';
import { pi } from '@ambionframework/pi';
import { configure, RoomObject, SeatObject } from '@ambionframework/cloudflare';

const assistant = defineAgent({
  name: 'assistant',
  identity: 'Writes the one message a person reads.',
  executor: pi({
    instructions: 'Answer what was asked, once.',
    model: 'anthropic/claude-sonnet-5',
  }),
});

configure({ agents: [assistant] });

export { RoomObject, SeatObject };

export default {
  fetch: () => new Response('The room is a Durable Object.', { status: 404 }),
};
```

```jsonc
// wrangler.jsonc
{
  "name": "my-ambion-worker",
  "main": "src/worker.ts",
  "compatibility_date": "2026-08-15",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [
      { "name": "ROOM", "class_name": "RoomObject" },
      { "name": "SEAT", "class_name": "SeatObject" },
    ],
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["RoomObject", "SeatObject"] }],
}
```

## The objects

- **`configure`** names the complete agent definitions that the objects
  resolve by name, and the model call they make. Two optional functions take
  the output of a seat: `logger` receives the steps of each activation, and
  `onSeatEvent` receives the events that a seat raises. To send the steps to Workers Logs,
  pass `(traced) => console.log({ ambion: 'step', ...traced })`. The room
  object windows each view with the `estimateTokens` function of the agent,
  and an agent with `activationTokenLimit` and no function counts
  `Math.ceil(text.length / 4)`.
- **`sqlStorage(state)`** opens one native journal backend over the object's
  SQLite. The runtime derives room journals from it. Each object keeps its
  durable metadata in one row of the `ambion_metadata` table, beside the room
  journals. The room row holds `stopped`. The seat row holds `activation`,
  `phase`, and `hold`. `sqlOver` wraps `ctx.storage.sql` in `run` and `all`.
- **`RoomObject`** runs the room. Its name is the name of the room, so reach it
  with `idFromName(room)`. An object with no name throws. A stub from
  `idFromString`, and a proxy from a `wrangler dev` in another process, carry
  no name.
- **`SeatObject`** runs one seat. The object is named for the room and the
  seat, and the name gives both. It does not create a room.

### RoomObject

- **The constructor resumes an initialized room** with the definitions of its
  recorded agents from `configure`, unless the room is explicitly stopped. An
  uninitialized record waits for an explicit `start`.
- **RPC calls:** `start`, `visit`, `send`, `leave`, `seat`, `unseat`,
  `cancel`, `read`, `exchange`, `dismiss`, `post`, `stop`, `waitForClose`, and
  `waitForSummary`. A seat makes three more calls: `view`, `commit`, and
  `lease`. `subscribe` over RPC is not built.
- **`start` takes no room name,** because the stub names the room. It receives
  the names of the definitions in `definitions`, an optional `summaryWriter`
  name, and an optional `seats` map. The map sets the initial seats and their
  attention. An omitted map seats every supplied agent at `broadcast`. An
  empty map starts them in the reserve.
- **`seat` and `unseat` take names** and cannot install a new definition.
  Automatic resume resolves each agent on the record, seated or in reserve,
  through `configure`. Every seat uses the same room tools, including `say`,
  `seat`, and `unseat`.
- **Its runtime reaches each seat** through an internal execution with no
  kind, whose port calls the seat object over RPC. Its `alarm()` runs
  `Room.reconcile()`.
- **Identity and presence come from the room journal,** and the object keeps
  no copy. `send` and `leave` take the visit with `visitOf` from the hosting
  entry, so a restart reaches only present humans. `send` never enters the
  room implicitly. Explicit `visit` ensures presence, and repeated `leave` is
  harmless.
- **`read()` returns the detached coherent room projection,** including
  stopped records: messages, participants, exchanges, and the read position
  `through`. The live `waitForClose()` and `waitForSummary()` require a
  running room. Use `read()` to inspect a stopped open exchange or its
  recorded summary outcome.

### SeatObject

- **`wake` stores the activation id and sets an alarm.** `alarm()` claims the
  lease, reads the view, runs the activation and whatever queued behind it to
  their end, and releases the lease. A second `alarm()` while a run is live in
  the object returns at once.
- **`alarm()` recovers a lost run.** When it finds a run that an eviction
  lost, it calls `AgentRunner.recover`, which releases the activation as
  failed. The recovery needs the definition of the seat. For a seat that the
  worker no longer configures, the recovery fails, and the room ends the lease
  of the lost run only when the lease expires.
- **`steer` delivers a recorded message** to its exact running activation. It
  writes no activation metadata and sets no alarm. Unread messages remain
  recoverable from the room journal. `cut` stops the activation the room
  ended.
- **The seat object runs the execution of its own host.** It connects the Pi
  execution of the worker once, and the `AgentRunner` and its executor live on
  the object instance. The executor keeps the Pi harness sessions of the seat
  in memory there. An eviction loses the sessions, and the next activation
  starts fresh. The seat gives the steps of each activation to the `logger`
  that `configure` takes, and drops them when it is absent.

## Limits

**A worker seat has `compose` and `describe`.** `pi()` gives every seat both
tools, with `quickjsRuntime()`. `describe` works in workerd. A compose call
fails there with an error that says QuickJS could not load its WebAssembly,
because a worker loads WebAssembly only from its bundle. The call fails until
a runtime for workerd exists. A host can pass `compose: { runtime }` with
a runtime that workerd can run
([Compose](https://github.com/ambionframework/ambion/blob/main/docs/compose.md#the-runtime)).

**`pnpm test` runs the adapter tests inside workerd** through
`@cloudflare/vitest-pool-workers`, as part of the repository's `turbo test`.
The tests serialize every value that crosses between a seat and its room,
which is what the
[execution boundary](https://github.com/ambionframework/ambion/blob/main/docs/executors.md#the-executor-contract)
promises.
