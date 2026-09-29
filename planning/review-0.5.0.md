# 0.5.0 review disposition

**The owner's feedback narrows the release to the functional core.**
The initial review examined `origin/main` at
`0f9ef1e27eed0f27c3ec47aef09071d54b044ff8` on 2026-09-29.
The revised [plan](next.md) and [sensor contract](../docs/sensors.md)
incorporate the decisions below. They supersede the initial review's
recommendation to expose reducer state or require exchange limits.

## Owner decisions

- Stateful reducers are expected. Their state contract belongs inside
  the sensor server implementation.
- Host-level interactions use host time.
- Spend, quotas, and limits are outside the initial implementation.
- Retained evidence integrates with the existing snapshot object store.
- Measurement timestamps are the source of truth.
- A sensor server can come from a Git repository and run as a process
  that the agent manages on the workstation.
- The agent needs `connect`, plus awareness of the workstation and port.
- Git templates define the initial sensor lifecycle: fork, customize,
  validate, save a branch, start, observe, replace, and roll back.
- Acquisition files stay outside the checkout. Automatic snapshots retain
  observed evidence independently of both source files and mutable exports.

## The resulting design

**The functional path starts with a fork and a saved customization.**
Existing Git tools own branches, commits, and pushes. Existing process
tools activate and stop each version. The agent explicitly replaces or
rolls back a running version; a push alone changes no running code.
`connect({ name, process, port })` registers the running server.
The workstation backend opens an SSH path to its loopback port.
`observe` retains returned evidence and gives a manifest snapshot ref.

**The server owns its internal design.** This removes the framework's
daemon, reducer library, acquisition store, checkpoint format, device
drivers, and model annotations from the release. A supplied program can
implement those mechanisms as needed behind the same small HTTP API.

**Automatic retention removes a second reference system.** Existing
snapshot refs identify the manifest and media bytes. They continue to
work after the source process stops or its history expires. Source names
and timestamps remain metadata in the retained manifest.

**The port belongs to the workstation's address space.** The agent sees
the configured hostname and the remote port. The backend owns the local
endpoint, forwarding channels, credentials, and cleanup. The initial
design does not expose public ports or accept arbitrary remote URLs.

**The initial registry is ephemeral.** After a host restart, the agent
uses existing process adoption and calls `connect` again. This is a
scope choice for the initial implementation. It adds no supervisor or
durable connection database.

## Disposition of the original findings

| Finding                                 | Revised disposition                                                     |
| --------------------------------------- | ----------------------------------------------------------------------- |
| R1: reducer progress and atomic storage | Server implementation concern; no prescribed internal store             |
| R2: stateful detection                  | Accepted internally; no public reducer state contract                   |
| R3: delivery rate and replay            | Automatic event delivery deferred; host time governs future host policy |
| R4: hard spend bounds                   | Removed from 0.5.0                                                      |
| R5: inaccessible retained evidence      | Automatic snapshot manifest and part retention                          |
| R6: sensor-ref identity                 | No new sensor refs; use content-addressed snapshots                     |
| R7: clock quality                       | Source timestamps accepted and preserved; analysis deferred             |
| R8: history pagination                  | No separate history log API; optional spans and file results            |
| R9: cut across the full stack           | Only shipped operations enter types, client, schema, and conformance    |
| R10: callback cancellation              | Server internals stay private; client cancellation closes HTTP work     |
| R11: export handling                    | Verify file digests and generate export paths locally                   |
| R12: child process ownership            | Existing workspace process lifecycle; no daemon-specific PID supervisor |
| R13: type and image contracts           | Small exact wire types; bundle-level image rendering choice             |
| R14: delivery-key conflicts             | No follower helper in the initial release                               |
| R15: acceptance evidence                | One real Git/process/SSH/snapshot scenario and matching doc checks      |

## Implementation boundaries to preserve

- `connect` changes no process timeout or lifetime.
- Every connected sensor is readable by all agents of that workspace.
- The owning agent alone replaces its connection or manages its process.
- A process handle links lifecycle; it does not attest TCP socket ownership.
- SSH authenticates the workstation connection. The initial deployment
  trusts the supplied program and its workstation.
- Retention covers observed data. The server owns data nobody observed.
- A failed snapshot write cannot return a successful retained observation.
- just-bash does not gain a native server runtime or a network tunnel.

**The plan now has twelve implementation items.** They cover the wire,
template, client, conformance, ports, connections, reminder, snapshots,
observation, image rendering, lifecycle acceptance, and release docs.
