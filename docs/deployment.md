# Deployment and recovery

**The host supplies execution; Ambion supplies collaboration semantics.**
Placement, journal persistence, and tool resources are separate decisions.
[The plan](../planning/next.md#the-scope) defines support targets and
tracks the evidence still required for release.

## Deployment models

| Model                         | Placement                        | Persistence                  | Current status                                                                  |
| ----------------------------- | -------------------------------- | ---------------------------- | ------------------------------------------------------------------------------- |
| Embedded Node application     | Room and runners in one process  | In-memory journals           | Implemented; storage lasts for the instance's lifetime                          |
| Persistent Node service       | Application-managed service      | SQLite journals              | SQLite recovery tests include a fresh process after SIGKILL; see evidence below |
| Separate room and agent hosts | Calls cross the JSON protocol    | Each host chooses storage    | Extension contract with a published conformance suite                           |
| Cloudflare Durable Objects    | One object per room and per seat | Each object's SQLite storage | Publishable adapter tested in workerd; deployment commands pending              |

## Embedded Node

**The embedded model needs no remote coordination service.** Use Node 22.19
or later and ESM. Supply agent definitions, provider credentials, and domain
tools. Keep the process alive while agents work. The default in-memory
journals lose their contents when their storage instance is lost.

The [three-harness team](../README.md#one-team-on-three-harnesses) uses this model.
Pi remains the supported model loop; its integration supplies provider access.

## Persistent Node

**The application owns service startup and recovery.** `sqliteJournals(sql)`
provides the journal adapter. `createRuntime` accepts the journal opener, and
`resumeRoom` reconstructs a named room from its confirmed entries.
See the [runtime contract](agent.md) and [durability contract](durability.md)
for the current signatures and failure rules.

The [Workbench example](../examples/workbench) hosts three sample rooms and
several people in one process, behind an OpenTUI terminal. The terminal
calls the host through a typed in-process API and sends keyed messages. The
rooms run while the terminal runs. One SQLite database stores the room
journals, and the next start resumes them with the same agent definitions.

Selecting a room enters it; selecting another leaves the current room. All
rooms share one local directory workspace. The assistant coordinates
datasheet, design, and experiment agents. Stop and Resume preserve workspace
files and room journals.

A host must:

1. Reopen the same durable storage and supply executable agent definitions.
2. Maintain one authoritative writer per room and handle supersession.
3. Resume the room and let journal rules recover pending work.
4. Reconcile recorded human presence with actual client connections.
5. Recreate subscriptions, read durable messages, and reacquire exchange handles.
6. Restore domain resources under their own persistence contracts.

**The trace goes to the host's logs.** Room history lives in the journal.
Pass a `logger` to `createRuntime`, or to `configure` on Cloudflare, to
receive the steps of each activation. A restart keeps no trace.

**A harness session is not part of the recovery.** A restart on a new
disk, or on a host with no disk, loses the session, and the next activation
reads the record again. Pi keeps its sessions under `sessionDir` on the
local disk; the default is `ambion-pi-sessions` in the OS temporary
directory. The executor deletes no session file, so a host removes old
files itself. See [Exchange continuity](executors.md#exchange-continuity).

Workspace files and application data have separate lifecycles. The journal
cannot recover JavaScript functions, credentials, or external data.

### Restore human presence

**Presence records what the host reported.** A crash writes no departure.
`resumeRoom` preserves recorded people, identities, and presence. It does not
restore sockets, authenticated sessions, or `Visit` objects.

After authenticating a reconnecting client, call `room.visit(human)` with
its saved definition. If that person remains present, the call restores the
local visit without writing another `arrived`. The recorded identity must
match. Reconnecting does not update the person's recorded preferences.

A host decides when a person has actually left. If it confirms that no client
for a recorded person remains, use the recorded name and identity:

```ts
const visit = await room.visit(
  defineHuman({ name: recordedPerson.name, identity: recordedPerson.identity }),
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

`room.stop()` deliberately revokes work and records departures. It is a
graceful end of that run. [`durability.md`](durability.md#stop) owns the
stop guarantee.

`hostingOf(runtime).evict(name)` drops local handles and observers without
writing departures or releasing leases. `hostingOf` comes from
`@ambionframework/ambion/hosting`, a host's own entry. Neither operation
closes one client's connection while keeping the room active.

Concurrent `stop()` calls wait for the same shutdown operation. If a durable
revocation or departure fails, callers observe that failure and may retry the
stop. Admission remains closed and the runtime releases the room name even on
failure. If another run resumes the room, its journal fence prevents the old
run's retry from changing the new run's presence or work.

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
const visit = await room.visit(human);
const exchange = room.exchange(saved.exchangeFrom);
if (!exchange) throw new Error('The saved exchange is not in this room.');

const discussion = await exchange.waitForClose();
const response = await exchange.waitForSummary(); // A summary, or undefined.
```

An exchange key is its opening question's `seq`. Another message sent while
that exchange is open returns the same `from`. To recover an uncertain send,
retry `visit.send` with the original key and payload. Its returned handle
identifies the original exchange even if the room has since moved on.

Pending waits belong to one running room. Eviction or detected supersession
rejects them; recreate waits on a handle from the resumed room. A stopped
run also rejects waits for unfinished work. Already recorded discussion and
summary results remain available through `readRoom()` or Cloudflare `read()`,
including stopped rooms. Reading recorded state does not resume execution.

**Subscribe before reading history, and merge by sequence.** Subscriptions
are local and do not replay past notifications. A message may appear in both
the replay and the live stream. This example collects both without duplication:

```ts
import type { Message } from '@ambionframework/ambion';

const messages = new Map<number, Message>();
const unsubscribe = room.subscribe((event) => {
  if (event.type === 'message') messages.set(event.message.seq, event.message);
});
const snapshot = await room.read({ messages: { since: saved.lastConsumedSeq } });
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
| A wake had no claim before failure | Let reconciliation deliver the pending wake again                                    |
| Host deliberately cancels work     | Use `abort()` or `stop()` and accept their cancellation semantics                    |

A surviving remote runner can renew, commit, and release its activation through
the new room host. A stale connection to the evicted host cannot do this.
After expiry, old activation calls are refused and retry policy controls
further work. Reacquiring an exchange handle does not renew or replace a lease.

Recovery does not automatically revoke every inherited lease. That would
cancel remote work which can still complete. Local recovery can wait for
expiry; hosts must keep their server or event loop alive and let alarms run.
Manual-clock tests advance time explicitly. A room lease does not cancel an
external effect or make a repeated tool call idempotent.

### Recovery evidence

**Deterministic tests exercise the documented procedures.**
[`reconnect.test.ts`](../packages/ambion/test/reconnect.test.ts) covers human
presence and exchange handles on memory and SQLite.
[`inherited-leases.test.ts`](../packages/ambion/test/inherited-leases.test.ts)
covers surviving remote authority and expiry before local retry.
[`reconnect-process.test.ts`](../packages/ambion/test/reconnect-process.test.ts)
kills a Node process at an active lease, then starts a fresh process over the
same SQLite file and saved client identifiers. The recovered client retries
its delivery, reads missed messages, and waits for the original exchange.

Run the process scenario without provider credentials:

```sh
pnpm --filter @ambionframework/ambion exec vitest run test/reconnect-process.test.ts
```

The process test uses a scripted model and an explicit clock. It verifies
process and storage recovery; it does not verify a provider's interrupted
network request. The site demo resumes an evicted runtime inside one process;
its product state and workspace stay in memory.

**The live tier also crosses a real process boundary.**
[`restart.test.ts`](../packages/ambion/test/live/restart.test.ts) records a
real provider contribution and waits for that activation to release. It then
kills Node while another activation holds a confirmed lease. A fresh process
opens the same SQLite database, resumes the room, and retries the original
delivery. System-clock alarms expire the lost lease and recover pending work.
The test checks the original contribution, exchange ID, single question,
single human arrival, and recovered agent response.

Run it with the configured provider credential:

```sh
pnpm --filter @ambionframework/ambion test:live test/live/restart.test.ts
```

The fixture holds a lease claim response to make the interruption point
observable. It sets `limits.lease.ttl` to five seconds and
`limits.activation.backoff` to zero. It does not preserve a provider
connection across the kill or claim exactly-once model execution.

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

**A lease fences room contributions.** Tools can repeat after failure or
continue briefly after cancellation. Applications own effect idempotency and
external transaction rules. An exchange close certifies a discussion boundary;
it does not certify the correctness of each contribution.

**Recovery depends on execution placement.** A dead local runner and a
remote runner with a valid lease require different handling. Lease expiry and
host topology affect recovery time.

**Control and observation belong to the running room.** Await `abort()` and
`stop()` before reporting their durable work complete. See the
[cancellation contract](durability.md#cancellation). Exchange handles do not
provide independent cancellation.
Subscriptions belong to one host; 0.1.0 includes no durable subscription service
across processes.

**Transport deadlines and execution limits have different scopes.**
`limits.call.timeout` bounds each executor call to the room.
`limits.call.attempts` bounds claim and release retries. A lost answer can
follow a successful remote write; the journal still decides which
contributions were accepted.

Monitor `delivery_error` for failed or uncertain delivery. Unclaimed work stays
pending and retries while eligible, including after a long shutdown. Execution
retry limits apply after a claim. Use `abort()` or unseat the affected agent when
the application must end pending work. See the
[transport contract](durability.md#transport-calls-and-unclaimed-work).

**History and work can grow.** Full history remains in storage and replay.
Activation deadlines and retry limits do not bound the total exchange duration.
Continuing contributions can keep a discussion open.

Ambient rooms remain available between interactions. Native timers, external
event subscriptions, and scheduler ingress remain future work. Browser-only
execution, a managed service, arbitrary edge-platform support, and turnkey
deployment commands are outside 0.1.0.
