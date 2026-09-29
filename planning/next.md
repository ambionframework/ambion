# Next: the scope for 0.5.0

> **No compatibility promise before 1.0.0.** 0.4.0 shipped on 2026-09-29
> from commit 98ab056, with eleven packages on npmjs. Until 1.0.0, any
> release may change any export, entry point, journal body, stored format,
> or package API.
>
> - **A change carries no compatibility path.** Add no re-export, no
>   deprecated alias, no reader for an older format, no upgrade step, and
>   no compatibility test.
> - **The changelog names each change** to an export, a journal body, or a
>   stored format.
> - **The guards pin the current surface.** The export snapshot,
>   golden journals, and body validation catch unintended changes.
>   A deliberate change updates the affected guards in the same commit.

**0.5.0 gives sensors a Git-template lifecycle.** The agent forks a
template, customizes and validates its code, and saves a working branch.
It starts acquisition as a workstation process, connects, observes, and
cites retained evidence. Replacement and rollback use the same tools.
[Sensors](../docs/sensors.md) owns the contract. This file owns the work
and its acceptance. [The backlog](backlog.md) holds everything else.

## Status

**0.4.0 shipped. SN1 is implemented on this branch.** The wire schemas
and client types exist. The other 0.5.0 steps remain pending. This scope
incorporates the owner's response to the review of `origin/main`
`0f9ef1e27eed0f27c3ec47aef09071d54b044ff8` on 2026-09-29.
[The review disposition](review-0.5.0.md) records the changed decisions.

## The scope

**The release follows the sensor from template to retained evidence.**

```text
fork -> branch -> customize -> validate -> commit and push
                                             |
                                      bash -> connect -> observe -> cite
                                             |
                              cancel -> revise or select an earlier commit
```

**Git is the sensor definition and version store.** A template supplies
source code, tests, and lifecycle instructions. The fork holds saved
customizations. A process activates one version. The workspace adds two
tools to connect that process and read its evidence.

- **`connect({ name, process, port })`** attaches a running process of
  the caller to the workspace. It discovers every sensor of that server.
- **`observe({ sensor, span? })`** reads a sensor and automatically retains
  its result through the existing snapshot object store.
- **The workstation backend carries HTTP through SSH.** The server binds
  to workstation loopback. Guidance names the workstation and remote port.
- **One template proves the full lifecycle.** The agent changes its code,
  saves a branch, runs it, replaces it, and rolls back. It serves numeric,
  frame, and text evidence through the same API.

**The server implementation owns its internals.** It can use stateful
reducers and any durable store. Ambion requires the wire contract alone.
Source timestamps are authoritative. Host time governs host interactions.

**Snapshot refs are the evidence contract.** A successful observation
returns a manifest snapshot that names the retained parts. Existing
`restore` reads them after the server stops. No sensor ref form is added.

**Two packages and one example carry the changes.**

| Location                       | Change                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `@ambionframework/workspace`   | Protocol, client, port interface, connections, tools, reminder, automatic snapshots |
| `@ambionframework/workstation` | Hostname guidance and SSH transport for workstation loopback ports                  |
| `examples/workbench`           | Git sensor-server template and workstation acceptance scenario                      |

**The kernel surface stays as implemented.** This release adds no
exchange limit, journal body, sensor URI, or scheduling rule. It adds no
`@ambionframework/sensors` package and no new model dependency.

## Decisions taken

- Sensor implementations start as Git templates and become agent-owned forks.
- The agent customizes code, validates, commits, and pushes working versions.
- A branch holds ongoing work. A commit identifies a saved version.
- Each run reports its launch source; uncommitted runs remain marked dirty.
- Stop before changing a running checkout. Replacement starts a new process.
- Acquisition data lives outside the checkout. Code rollback does not roll
  back data; the template owns data compatibility.
- The server uses its owner's filesystem. Observers get exports in their
  own homes. Automatic snapshots retain the bytes returned by the API.
- Reducer state and recovery belong inside the supplied sensor server.
- Measurement timestamps stay unchanged through rendering and retention.
- Spend, quotas, exchange limits, and rate-limit policies are outside scope.
- The server runs as an ordinary workspace process in its owning account.
- The agent connects by process handle and workstation port.
- The backend manages the tunnel; the agent sees no SSH credential.
- Connection registrations last for one host run. Reconnect explicitly
  after restart; reuse a surviving process through existing adoption.
- All agents of the workspace can read connected sensors. Only the process
  owner manages that process and replaces its connection.
- Retention happens automatically when `observe` succeeds.
- Server acquisition and unobserved history remain server responsibilities.
- Existing process timeout and disposal behavior remain unchanged.
- The initial transport supports workstation loopback through SSH.

## Out of scope

**D21 holds later sensor work.** The initial release does not require:

- A framework daemon, reducer library, annotation service, or driver suite.
- `followAndPost`, detection subscriptions, and unattended monitoring policy.
- New sensor refs or a sensor-specific evidence store in the workspace.
- Live streaming, clips, audio playback, browser views, or public tunnels.
- Clock correction, skew estimation, or synchronization checks.
- Automatic service restart or persistent connection discovery.
- A second bench or a catalog of instrument scenarios.

**SK1 and SK2 leave the release.** D1 holds exchange bounds. Snapshot refs
remove the need for SK2. D22 remains deferred. No deferred limit is used
as an acceptance condition for this release.

## The order of work

**Each phase has one observable result.** Existing SN identifiers retain
their concern where it still applies. New concerns use SN32-SN35. All
other old SN identifiers are deferred or superseded in D21.
Complete each phase and its evidence before starting the next phase.
Within a phase, items can proceed together when their dependencies allow.

### Phase 1. The template, wire, and workstation transport

- [x] **1.** The minimal schema and launch source metadata. (SN1)
- [ ] **2.** The forkable template and its lifecycle contract. Needs 1. (SN27)
- [ ] **3.** The client and conformance cases. Needs 1 and 2. (SN3, SN4)
- [ ] **4.** The workspace port contract and workstation forwarding. (SN32)

**Evidence:** the template can be forked, customized, validated, committed,
and pushed. Its server passes conformance over HTTP. The same server is
readable through SSH on a workstation loopback port. A refused forward
leaves no transport resources behind.

### Phase 2. Connect, observe, and retain

- [ ] **1.** The connection registry and `connect` tool. (SN33)
- [ ] **2.** Discovery and the reminder. Needs 1. (SN5)
- [ ] **3.** Retain received evidence through snapshots. (SN34)
- [ ] **4.** The observe tool and text-only rendering. Needs 1 and 3. (SN6, SN8)

**Evidence:** a real room connects a process, observes all four part
forms, and cites the manifest ref. Another agent restores the evidence
after the server stops. Source timestamps remain unchanged.

### Phase 3. The complete lifecycle and release

- [ ] **1.** The workstation lifecycle acceptance scenario. (SN35)
- [ ] **2.** Documentation and release checks. Needs 1. (SN31)

**Evidence:** fork, customization, validation, commit, push, start,
connection, observation, citation, replacement, rollback, and restore
all run through their real tools.
The host-restart case reconnects to an adopted process. `pnpm check`
passes, and the OpenSSH tier passes the workstation scenario.

## The items

**SN1. The wire contract.** Implement the types and schemas of
[The sensor API](../docs/sensors.md#the-sensor-api). Export the schema
from `@ambionframework/workspace/sensor-api.schema.json`. Export client
types through `@ambionframework/workspace/sensors`. Update package
entries, build configuration, and export snapshots together.

**Evidence:** exact sample requests, responses, and errors validate.
Bad names, source metadata, digests, times, sample periods, and part
shapes fail. The generated schema matches the published file. Deferred features add no
required type, endpoint, or fixture.

**SN3. The client.** Implement index, observe, and file reads. Resolve
paths against the supplied private transport root. Verify `api` and file
digests. Propagate cancellation and failures. Do not replay an observe
automatically. The entry imports no device or model implementation.

**Evidence:** the three operations work over real HTTP. Wrong versions,
invalid bodies, missing files, digest mismatch, disconnects, and aborts
produce explicit failures. The client preserves timestamps exactly.

**SN4. Conformance.** Export `sensorConformance` from the existing
conformance entry. Supply a small fixture contract for numeric, text,
frame, and file parts, with a fixed span. Check the declared `spans`
capability. Keep the fixture in test support; it is no framework daemon.

**Evidence:** a conforming server passes. A server with a deliberately
wrong version, digest, span response, or name fails the corresponding
case. No test needs ffmpeg, instruments, or a model provider.

**SN32. Workstation ports.** Add the optional `BashBackend.ports`
contract from [Workstation ports](../docs/sensors.md#workstation-ports).
Implement it through the existing workstation SSH session machinery.
Expose the configured hostname in guidance. Reuse account credentials
and host-key verification. Keep the destination at remote loopback.

**Evidence:** both the in-process SSH tier and OpenSSH tier reach a real
HTTP server. Abort, failure, and disposal release session references,
channels, and local listeners. Forwarding denial is visible. just-bash
keeps no port capability. Update the applicable neutral import rules and
their existing probe when adding the transport types.

**SN33. Connections.** Add `connect` only when the backend has ports.
Implement ownership checks, readiness validation, qualified sensor names,
idempotence, name conflicts, and captured launch source. Commit
registration atomically after validation. Concurrent claims on one name have one winner. Dispose a
losing transport. Keep the registry in memory for the host run.

**Evidence:** two agents can read one connection, but cannot register
each other's processes. Equal retries reuse a registration. Conflicting
calls do not replace it. A stopped process cannot be connected. A failed
handshake leaves no registration. Replacing an ended process requires an
explicit owner call. A request after process end cannot reuse its port.

**SN5. The reminder.** Show the workstation, connected process and port,
and qualified sensor names with descriptions. Use the index captured at
connection. Refresh it on an explicit repeated `connect`; dynamic
hot-plug discovery is outside the initial release. Read process state
through the existing process table. Keep media out of the reminder.

**Evidence:** a reminder shows names from two servers without clashes.
An ended process shows an unavailable connection. Existing process
reminders still work. Failed sensor work cannot discard their output.

**SN34. Retained evidence.** Reuse the existing snapshot store for
received bytes and an observation manifest. Include launch source metadata
and preserve its dirty marker. Retain received bytes independently of the
server owner's acquisition files and the observer's mutable exports. Add
an internal buffer helper if needed; add no public snapshot variant.
Keep object and bash owner operations separate. Generate local filenames and one directory per call.
Return success only after retention and export finish.

**Evidence:** `restore` retrieves the manifest and its referenced files
after server shutdown. Test the default store and existing object
conformance path. Modified exports do not modify evidence. Missing files,
changed digests, object-write failures, and partial exports never report
a successful retained observation.

**SN6. Observe.** Implement the input, rendering, audit details, and
snapshot result of [Observe](../docs/sensors.md#observe-and-retain-evidence).
Use host time for request lifecycle and source time for measurements.
Support latest and explicitly supported spans through the same call.

**Evidence:** a real room observes numeric, text, frame, and file results.
The audit result carries the manifest ref. A message can cite it through
the existing ref validator. The initial call works without a prior
activation reminder. Unavailable spans fail explicitly.

**SN8. Text-only rendering.** Add `images?: boolean` to the workspace
bundle options. `false` produces paths in place of image content. Keep
the same tool schema for every executor and retain every image byte.

**Evidence:** Pi and Claude receive image parts through their adapters.
A text-only bundle receives text and paths, and restores identical bytes.
These are adapter checks with no paid model call.

**SN27. The sensor template.** Add `templates/sensor-server` beside the
existing workbench templates. Its small Node program serves deterministic
numeric, frame, and text fixtures. Its README defines setup, customization,
validation, launch, readiness, data storage, stopping, and rollback.
It reads its Git source once at startup and exposes that metadata in the
index. Its data directory lives outside its checkout.

**Evidence:** a fork accepts a code change on a branch. Its tests detect
an incorrect change. A corrected change can be committed, pushed, and
cloned again. The launch command starts acquisition and prints its bound
port. Clean and dirty runs report their launch metadata correctly.
The template requires no framework daemon, ffmpeg, or model provider.

**SN35. Lifecycle acceptance.** Run the template through a real room,
the Git backend, workstation process tools, port transport, and snapshots.
Use the workstation placement; the default just-bash example does not
claim server support.

**Evidence:** the agent forks, customizes, validates, commits, and pushes.
It launches the saved version, reads its port, connects, observes the
changed result, and cites the manifest. Another agent restores that
manifest and its files into its own home without reading the owner's home.

Stop the process, change and save another version, then start and connect
it. Its result and launch commit differ. Roll back to the earlier commit
and verify the earlier behavior. Retained evidence from both runs stays
readable after shutdown. A dirty run remains dirty in its manifest even
after the edits are committed and pushed. Export edits change no snapshot.

After a host crash, an adopted server can be connected again. Its launch
source remains the earlier value even if the branch moved. A clean
workspace disposal follows the existing process stop rules.

**SN31. Release documentation.** Update workspace, workstation, process,
example, trust, and package docs as their pending changes land. Remove
pending labels only for implemented behavior. Record exports and formats
in the changelog. Keep the current package count at eleven.

**Evidence:** the plan's identifiers and relative links validate.
`pnpm check` and the OpenSSH scenario pass. A live model run is optional
confirmation, not a prerequisite for protocol or transport correctness.
