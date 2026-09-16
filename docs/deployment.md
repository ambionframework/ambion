# Deployment and recovery

**The host supplies execution; Ambion supplies collaboration semantics.**
Placement, journal persistence, and tool resources are separate decisions.
The [0.1.0 scope](../planning/release-0.1.0.md#f8-deployment-models) defines
support targets. [The delivery plan](../planning/next.md) tracks the evidence
still required for release.

## Deployment models

| Model                         | Placement                        | Persistence                  | Current status                                                             |
| ----------------------------- | -------------------------------- | ---------------------------- | -------------------------------------------------------------------------- |
| Embedded Node application     | Room and runners in one process  | In-memory journals           | Implemented; storage lasts for the instance's lifetime                     |
| Persistent Node service       | Application-managed service      | SQLite journals              | Adapters and recovery tests exist; release restart example remains pending |
| Separate room and agent hosts | Calls cross the JSON protocol    | Each host chooses storage    | Extension contract exercised by the Cloudflare reference                   |
| Cloudflare Durable Objects    | One object per room and per seat | Each object's SQLite storage | Private reference tested in workerd; no published deployment product       |

## Embedded Node

**The embedded model needs no remote coordination service.** Use Node 22.19
or later and ESM. Supply agent definitions, provider credentials, and domain
tools. Keep the process alive while agents work. The default in-memory
journals lose their contents when their storage instance is lost.

The [small room](../README.md#a-small-room) uses this model. The
[site example](../examples/site) adds domain tools and a shared workspace.
Pi remains the supported model loop; its integration supplies provider access.

## Persistent Node

**The application owns service startup and recovery.** `sqliteJournals(sql)`
provides the journal adapter. `createRuntime` accepts the journal opener, and
`resumeRoom` reconstructs a named room from its confirmed entries.
See the [runtime contract](agent.md) and [durability contract](durability.md)
for the current signatures and failure rules.

A host must:

1. Reopen the same durable storage and supply executable agent definitions.
2. Maintain one authoritative writer per room and handle supersession.
3. Resume the room and let journal rules recover pending work.
4. Reconcile recorded human presence with actual client connections.
5. Recreate subscriptions, read durable messages, and reacquire exchange handles.
6. Restore domain resources under their own persistence contracts.

**Room history and Pi audits use separate journal names.** They can share
one database. An `audit_error` reports exhausted transcript persistence without
changing the execution outcome. In-process subscribers receive this event;
Cloudflare reports it through `onSeatEvent`. Inspect audit storage when it occurs.
Unconfirmed transcript data can be lost on process failure.

Workspace files and application data have separate lifecycles. The journal
cannot recover JavaScript functions, credentials, or external data.

**Recovery evidence has a defined scope.** The site demo evicts a runtime
inside one process and resumes over SQLite. Product state and its workspace
remain in memory. The chaos tests also exercise process failure; see
[the test matrix](durability.md#7-how-it-is-proved). A clean persistent Node
restart example and release checks remain pending in the delivery plan.

## Separate execution and the Cloudflare reference

**Execution hosts need their own agent code and resources.** The JSON
protocol carries collaboration data and identities. It does not deploy tool
functions or establish network authentication. Hosts supply model access,
credentials, authorization, and workspace clients where execution runs.

The [Cloudflare reference](../packages/cloudflare) uses RPC and alarms to
connect room and seat objects. Each object uses its own SQLite storage.
Its workerd tests exercise serialization and recovery, including a room
restart while remote seats continue to work.

The [local Cloudflare example](../examples/site#the-same-room-on-cloudflare)
provides a development harness. Publishing a supported deployment requires
packaging, configuration, operations documentation, and deployment evidence.
The Node directory workspace is not automatically available in a Durable Object.

## Operational boundaries

**A lease fences room contributions.** Tools can repeat after failure or
continue briefly after cancellation. Applications own effect idempotency and
external transaction rules. An exchange close certifies a discussion boundary;
it does not certify the correctness of each contribution.

**Recovery depends on execution placement.** A dead local runner and a
remote runner with a valid lease require different handling. Lease expiry and
host topology affect recovery time.

**Control and observation belong to the running room.** `abort()` and `stop()`
affect room work. Exchange handles do not provide independent cancellation.
Subscriptions belong to one host; 0.1.0 includes no durable subscription service
across processes.

**History and work can grow.** Full history remains in storage and replay.
Activation deadlines and retry limits do not bound the total exchange duration.
Continuing contributions can keep a discussion open.

Ambient rooms remain available between interactions. Native timers, external
event subscriptions, and scheduler ingress remain future work. Browser-only
execution, a managed service, arbitrary edge-platform support, and turnkey
deployment commands are outside 0.1.0.
