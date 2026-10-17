# Deployment and recovery

**The host supplies execution; Ambion supplies collaboration semantics.**
Placement, journal persistence, and tool resources are separate decisions.
The table below states the status of each deployment model.

## Deployment models

| Model                         | Placement                        | Persistence                  | Current status                                                      |
| ----------------------------- | -------------------------------- | ---------------------------- | ------------------------------------------------------------------- |
| Embedded Node application     | Room and runners in one process  | In-memory journals           | Implemented; storage lasts for the instance's lifetime              |
| Persistent Node service       | Application-managed service      | SQLite journals              | SQLite recovery tests include a fresh process after SIGKILL         |
| Separate room and agent hosts | Calls cross the JSON protocol    | Each host chooses storage    | Extension contract with a published conformance suite               |
| Cloudflare Durable Objects    | One object per room and per seat | Each object's SQLite storage | Adapter tested in workerd; the package ships no deployment commands |

## Embedded Node

**The embedded model needs no remote coordination service.** Use Node 22.19
or later and ESM. Supply agent definitions, provider credentials, and domain
tools. Keep the process alive while agents work. `memoryJournals()` keeps
the record in memory and loses it when the storage instance is lost.

The [three-harness team](../README.md#one-team-on-three-harnesses) uses this model.
Pi remains the supported model loop; its integration supplies provider access.

## Persistent Node

**The application owns service startup and recovery.** `sqliteJournals(sql)`
provides the journal adapter. `createRuntime` requires the journal opener
as `storage`, and `resumeRoom` reconstructs a named room from its confirmed entries.
See the [runtime contract](agent.md) and [durability contract](durability.md)
for the current signatures and failure rules.

The [Workbench example](../examples/workbench/README.md) hosts its rooms and
several people in one process. One SQLite database stores the room journals,
and the next start resumes them with the same agent definitions.

A host must:

1. Reopen the same durable storage and supply executable agent definitions.
2. Maintain one authoritative writer per room and handle supersession. Evict
   a dead in-memory room before another host takes its name. Treat
   `superseded` like eviction: discard its answers and resume the name. A
   failed resume may be retried; its fence is the first write of the new run.
3. Resume the room and let journal rules recover pending work.
4. Reconcile recorded human presence with actual client connections.
5. Recreate subscriptions, read durable messages, and reacquire exchange handles.
6. Restore domain resources under their own persistence contracts.

**Pass a `logger` to receive the trace.** Give it to `createRuntime`, or to
`configure` on Cloudflare, to receive the steps of each activation. A restart
keeps no trace.

**A vendor session is not part of the recovery.** A restart on a new
disk, or on a host with no disk, loses the session, and the next activation
reads the record again. Pi keeps its sessions under `sessionDir` on the
local disk. The default is `ambion-pi-sessions-<uid>` in the OS temporary
directory, with access for its owner only. The executor deletes no session
file, so a host removes old files itself. See [Exchange continuity](executors.md#exchange-continuity).

Workspace files and application data have separate lifecycles. The journal
cannot recover JavaScript functions, credentials, or external data.

### Restore human presence

**Presence records what the host reported.** A crash writes no departure.
`resumeRoom` preserves recorded people, identities, and presence. It does not
restore sockets, authenticated sessions, or `Visit` objects.

After authenticating a reconnecting client, call `room.visit(person)` with
its saved definition. If that person remains present, the call restores the
local visit without writing another `arrived`. The recorded identity must
match. Reconnecting does not update the person's recorded preferences.

A host decides when a person has actually left. If it confirms that no client
for a recorded person remains, use the recorded name and identity:

```ts
const visit = await room.visit(
  definePerson({ name: recordedPerson.name, identity: recordedPerson.identity }),
);
await visit.leave();
```

For a person still recorded as present, this writes one `left` and no
intermediate arrival. A connection loss alone need not mean departure.
Apply the application's reconnect policy before marking anyone absent.
Serialize these decisions with connection changes for that person.

**One person has one presence across clients.** Multiple `visit` calls for
a present person refer to the same live visit. One `leave()` ends it for
all those clients. The host tracks tabs or sockets and calls `leave` only
when its person-level presence policy requires it.

`room.stop()` is the graceful end of a run, and a failed stop may be
retried. [`durability.md`](durability.md#stop) owns the stop guarantee.

`hostingOf(runtime).evict(name)` drops local handles and observers without
writing departures or releasing leases. `hostingOf` comes from
`@ambionframework/ambion/hosting`, a host's own entry. Neither operation
closes one client's connection while keeping the room active.

### Restore client reads and exchange handles

**Persist identifiers and acknowledged progress in application storage.**
The room journal stores collaboration facts; the application stores each
client's delivery and display progress.

| Client value                                         | Purpose                                            |
| ---------------------------------------------------- | -------------------------------------------------- |
| Room name                                            | Select the durable room to resume                  |
| Human definition or authenticated identity lookup    | Restore the correct person's visit                 |
| Delivery key and exact payload, saved before sending | Retry a send whose acknowledgement was lost        |
| `exchange.from`, saved after acknowledgement         | Reacquire that exchange after reconnect            |
| Last consumed message `seq`                          | Read messages that the client has not acknowledged |

`Visit.lastDeparture` is the sequence of the person's last recorded departure.
It is shared presence history, not an acknowledged cursor for each device.
Keep a separate cursor per client. Sequence numbers are journal positions;
messages can have gaps between their sequence numbers.

**Resume first, then reacquire handles.** Supply executable definitions for
every recorded agent name and reopen the same storage. A new run may use
updated definitions. With the saved client values:

```ts
const room = await resumeRoom(saved.roomName, { runtime, agents });
const visit = await room.visit(person);
const exchange = room.exchange(saved.exchangeFrom);
if (!exchange) throw new Error('The saved exchange is not in this room.');

const discussion = await exchange.waitForClose();
const response = await exchange.waitForSummary(); // A summary, or undefined.
```

An exchange key is its opening question's `seq`. Another message sent while
that exchange is open returns the same `from`. To recover an uncertain send,
retry `visit.send` with the original key and payload
([Durability](durability.md#2-what-a-delivery-promises)).

Pending waits belong to one running room. Eviction or detected supersession
rejects them; recreate waits on a handle from the resumed room. A stopped
run also rejects waits for unfinished work. Already recorded discussion and
summary results remain available through `readRoom()` or Cloudflare `read()`,
including stopped rooms. Reading recorded state does not resume execution.

**Subscribe before reading history, and merge by sequence.** Subscriptions
are local and do not replay past notifications. Read with an exclusive
`after` position. A message may appear in both
the replay and the live stream. This example collects both without duplication:

```ts
import type { Message } from '@ambionframework/ambion';

const messages = new Map<number, Message>();
const unsubscribe = room.subscribe((event) => {
  if (event.type === 'message') messages.set(event.message.seq, event.message);
});
const snapshot = await room.read({ messages: { after: saved.lastConsumedSeq } });
for (const message of snapshot.messages) {
  messages.set(message.seq, message);
}
const ordered = [...messages.values()].sort((a, b) => a.seq - b.seq);
```

Continue consuming notifications after the replay. Save a cursor only after
the client consumes the corresponding ordered messages. Release the
subscription when that client detaches. Repeat this procedure after another
host interruption; no subscription or promise survives a process restart.

### Recover inherited leases

**A new room run preserves unexpired activation authority.** A room writer
fence and an activation lease have different jobs. The fence rejects writes
from the old room run. The lease authorizes its runner through the current
room host until it ends or expires.

| What survived                      | Host procedure                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| Room and local runner both died    | Resume the room; the inherited lease expires before the room retries eligible work   |
| Room died, remote runner survives  | Route its calls to the resumed room; preserve the same activation id and valid lease |
| A wake had no claim before failure | Let reconciliation deliver the due wake again                                        |
| Host deliberately cancels work     | Use `cancel()` or `stop()` and accept their cancellation semantics                   |

A surviving remote runner can renew, commit, and release its activation through
the new room host. A stale connection to the evicted host cannot do this.
After expiry, old activation calls are refused and retry policy controls
further work. Reacquiring an exchange handle does not renew or replace a lease.

Recovery does not automatically revoke every inherited lease. That would
cancel remote work which can still complete. Local recovery can wait for
expiry; hosts must keep their server or event loop alive and let alarms run.
Manual-clock tests advance time explicitly. A room lease does not cancel an
external effect or make a repeated tool call idempotent.

## Separate execution and the Cloudflare reference

**Execution hosts need their own agent code and resources.** The JSON
protocol carries collaboration data and identities. It does not deploy tool
functions or establish network authentication. Hosts supply model access,
credentials, authorization, and workspace clients where execution runs.

The [Cloudflare reference](../packages/cloudflare) uses RPC and alarms to
connect room and seat objects. Each object uses its own SQLite storage.
Its workerd tests exercise serialization and recovery, including a room
restart while remote seats continue to work.

Publishing a supported deployment requires packaging, configuration,
operations documentation, and deployment evidence. The Node directory
workspace is not automatically available in a Durable Object.

## Operational boundaries

**Applications own effect idempotency.**
[Durability](durability.md#5-what-the-room-does-not-promise) states what a
lease fences and what an exchange close certifies.

**Recovery depends on execution placement.** A dead local runner and a
remote runner with a valid lease require different handling. Lease expiry and
host topology affect recovery time.

**Control and observation belong to the running room.** Await `cancel()` and
`stop()` before reporting their durable work complete
([cancellation](durability.md#cancellation)). Exchange handles do not provide
independent cancellation. Subscriptions belong to one host. Ambion includes
no durable subscription service across processes.

**Monitor `port_error` for failed or uncertain delivery.** Unclaimed work
stays pending and retries while eligible, including after a long shutdown.
Use `cancel()` or unseat the affected agent when the application must end
pending work. [Durability](durability.md#executor-calls-and-unclaimed-work)
states the call contract and [Limits](limits.md) the values.

**Subscribe to the events that report a failure.** A room that runs
unattended tells its host through notifications only.

| Event                              | What it tells the host                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `error`                            | An activation failed, or the room failed. A failure of the room has no `seat` and no `activation`.     |
| `port_error`                       | A delivery or a call of a seat failed, or its result is unknown.                                       |
| `abandoned`                        | The room gave up on a due activation, for a permanent cause or after the last attempt.                 |
| `exchange_closed` with `exhausted` | The exchange ended after an `abandoned` activation. Read `outcome` of the exchange with `room.read()`. |

A failure of the room is a write that the storage refuses, or a throw in a
rule. The room emits `error` once for a streak of the same failure, arms
its alarm again, and looks again after the resend window. The room emits
the failure again when it changes, or when it returns after a pass that
succeeded. An opener that throws ends its activation as a permanent failure:
the host sees `error` with `cause: 'permanent'`, then `abandoned`.

**History and work can grow.** Full history remains in storage and replay.
Activation deadlines and retry limits do not bound the total exchange duration.
Continuing contributions can keep a discussion open.

Ambient rooms remain available between interactions. The room returns a
scheduled say on the host's clock, and the Cloudflare room object on its
alarm. A host that wants a wake calls `room.post`. Browser-only execution,
a managed service, arbitrary edge-platform support, and turnkey deployment
commands are outside the current scope.
