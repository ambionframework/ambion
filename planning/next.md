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
and its acceptance. [0.6.0.md](0.6.0.md) lines up the release after it,
the `compose` tool. [The backlog](backlog.md) holds everything else.

## Status

**0.4.0 shipped. SN1, SN3, SN4, SN5, SN6, SN8, SN27, SN32, SN33, SN34,
and SN35 are implemented and validated. SN31's release documentation and
required checks are complete.** The wire schemas, HTTP client,
conformance runner, template, workstation ports, connection registry,
discovery reminder, `connect` and `observe` tools, snapshot retention, and
the OpenSSH lifecycle acceptance exist. SN33's focused Linux checks passed;
SN35 separately validates the complete path on the provisioned OpenSSH tier.
This scope incorporates the owner's response to the review of `origin/main`
`0f9ef1e27eed0f27c3ec47aef09071d54b044ff8` on 2026-09-29.
[The review disposition](review-0.5.0.md) records the changed decisions.

**0.5.0 also holds the layer boundaries that a review of `main` found
open on 2026-10-01.** The review read the import graph of every source file and
probed every import rule of `biome.jsonc`. LB1 and LB2 are done. LB3 to
LB9 remain, in [Phase 4](#phase-4-the-layer-boundaries).

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

**Two packages and one example carry the sensor changes.**

| Location                       | Change                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `@ambionframework/workspace`   | Protocol, client, port interface, connections, tools, reminder, automatic snapshots |
| `@ambionframework/workstation` | Hostname guidance and SSH transport for workstation loopback ports                  |
| `examples/workbench`           | Git sensor-server template and workstation acceptance scenario                      |

**The kernel surface stays as implemented.** This release adds no
exchange limit, journal body, sensor URI, or scheduling rule. It adds no
`@ambionframework/sensors` package and no new model dependency.

**The layer boundaries hold by rule and by test.** A package or a core
layer imports only what its place in the layers allows, and an import rule
refuses every other import. A rule that matches nothing fails a test.

| Location                                                     | Change                                                   |
| ------------------------------------------------------------ | -------------------------------------------------------- |
| `biome.jsonc`, `scripts/`                                    | One table of the core layers; complete rules and probes  |
| `@ambionframework/ambion`                                    | The executor contract types move into the vocabulary     |
| `@ambionframework/workspace`                                 | Its own port; the sensor schemas leave the client cycle  |
| `@ambionframework/just-bash`, `@ambionframework/workstation` | Build on the workspace port with no Pi import            |
| `examples/workbench`                                         | Uses the workspace port in place of `BACKGROUND_CONTEXT` |

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
- The workspace owns its port in 0.5.0, and a workspace tool is a core
  tool (W1). The owner moved this item from phase 3 of
  [the simplification](simplification.md) on 2026-10-01.
- The core imports no Node built-in, no Cloudflare module, and no model
  library, in every layer (LB2).

## Out of scope

**D21 holds later sensor work.** The initial release does not require:

- A framework daemon, reducer library, annotation service, or driver suite.
- `followAndPost`, detection subscriptions, and unattended monitoring policy.
- New sensor refs or a sensor-specific evidence store in the workspace.
- Live streaming, clips, audio playback, browser views, or public tunnels.
- Clock correction, skew estimation, or synchronization checks.
- Automatic service restart or persistent connection discovery.
- A second bench or a catalog of instrument scenarios.

**The layer work leaves four known facts as they are.**

- The import rules and the review read `src` only. The core's tests read
  the Pi source by relative path, and the core lists Pi as a
  devDependency. `packages/ambion/test/package.test.ts` keeps a model
  import out of the core source.
- `@ambionframework/cloudflare`, `@ambionframework/assistant`, and
  `@ambionframework/simulator` depend on the Pi executor.
  `docs/toolchain.md` §1 documents these edges, and simplification K9
  holds the assistant.
- `examples/workbench/src/brand.ts` reads `brand/tokens` at the
  repository root. The example is private.
- `packages/codex/src/room-tools-server.ts` is a build entry that the
  Codex executor starts by path. The manifest exports it under no name.

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
- [x] **2.** The forkable template and its lifecycle contract. Needs 1. (SN27)
- [x] **3.** The client and conformance cases. Needs 1 and 2. (SN3, SN4)
- [x] **4.** The workspace port contract and workstation forwarding. (SN32)

**Evidence:** the template can be forked, customized, validated, committed,
and pushed. Template tests validate its responses against SN1 schemas and
run SN4 conformance against the cloned server. The SN3 client and SN4 raw
HTTP runner both pass against the template. A real loopback HTTP fixture is
readable through SSH on a workstation. A refused forward leaves no transport
resources behind.

### Phase 2. Connect, observe, and retain

- [x] **1.** The connection registry and `connect` tool. (SN33)
- [x] **2.** Discovery and the reminder. Needs 1. (SN5)
- [x] **3.** Retain received evidence through snapshots. (SN34)
- [x] **4.** The observe tool and text-only rendering. Needs 1 and 3. (SN6, SN8)

**Evidence:** focused workspace acceptance passes twelve cases. A real room
observes numeric, text, frame, and file parts, cites the manifest ref, and
records it in the audit result. A separate cross-agent restore case stops the
fixture server before restoring the manifest and exact frame and file bytes.
Other cases cover supported and unavailable spans, image paths and fixed
schema, continued shell work while HTTP is blocked, process end before
verification and during file fetch, connection replacement during an in-flight
request, cancellation during observation and file fetch, and retention failure
without a replay.
Manifest timestamps and series boundaries remain exact. Adapter checks pass
for Pi (2/2) and Claude (1/1) image-delivery fixtures; Pi also checks
text-only output. Workspace checks separately verify text-only paths and
restored bytes.

### Phase 3. The complete lifecycle and release

- [x] **1.** The workstation lifecycle acceptance scenario. (SN35)
- [x] **2.** Documentation and release checks. Needs 1. (SN31)

**Evidence:** fork, customization, validation, commit, push, start,
connection, observation, citation, replacement, rollback, and restore
all run through real room tools. The host-crash case reconnects to an adopted
process after a separate checkout advances its branch. `pnpm check` passes.
The focused lifecycle passes 2/2, and `pnpm test:live-local-workstation`
passes 48/48 across four OpenSSH files, including the actual template,
host-staged runtime, crash recovery, and orphan cleanup after a timed-out
startup response.

SN31 updates current sensor capability, backend requirements, exports, and
the 0.5.0 JSON manifest format. Release packaging validates all eleven
packages, version agreement, package hygiene, and the packed sensor schema.
The final Linux `pnpm format && pnpm check` passes all 23 Turbo tasks;
`pnpm test:reports` passes 79/79. The final OpenSSH target passes 48/48.
An optional Pi live run with `openai/gpt-6-luna` at medium reasoning completed
all 38 cases once with no skips or provider errors: 35 passed and 3 failed.
The findings are the `corrects-3` judge rejecting "referenced withdrawn
limit" where the criterion expected explicit "planned" wording, an extra
`override` scheduled self-message
that was later dismissed, and a `direct-question` answer broadcast instead
of sent to Priya. The ignored run evidence is under
`packages/assistant/test/live/runs/openai-gpt-6-luna/`.

### Phase 4. The layer boundaries

- [x] **1.** Hold the neutral and published-surface rules. (LB1, #417)
- [x] **2.** Refuse model libraries and platform modules in every core
      layer. (LB2, #419)
- [ ] **3.** One table of the core layers drives the probes. (LB3)
- [ ] **4.** The overrides outside the core refuse subpaths. (LB4)
- [ ] **5.** The host layer imports no execution file. Needs 3. (LB5)
- [ ] **6.** The room-host core imports none of its mechanisms. Needs 3.
      (LB6)
- [ ] **7.** No cycle of value imports. (LB7)
- [ ] **8.** The workspace owns its port. Needs 4. (LB8)
- [ ] **9.** The tests pass under full parallel load. (LB9)

**Evidence:** `scripts/import-rules.test.mjs` derives its core cases from
one layer table and probes every pair of layers. A test fails on any cycle
of value imports in `packages/*/src`. No source file and no `dependencies`
field of the workspace, the workstation, or just-bash names
`@earendil-works/*`. `pnpm check` passes, and `turbo run test --force`
passes five runs in a row on Linux.

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

**SN3. The client.** `createSensorClient(root)` implements index, observe,
and file reads. It preserves transport-root path prefixes, validates version
1 request and response bodies, verifies file digests, propagates cancellation
and transport failures, and does not follow redirects or retry requests. The
entry imports no device or model implementation.

**Evidence:** focused real HTTP tests exercise the three operations, the
SN27 server template, wrong versions and malformed bodies, missing files,
digest mismatch, disconnects, aborts, prefix resolution, and no observe
replay. Measurement timestamps and returned bytes are checked exactly.

**SN4. Conformance.** Export `sensorConformance` from the existing
conformance entry. Its fixture contract covers numeric, text, frame, and file
parts with a fixed span. The cases check the declared `spans` capability.
Fixtures and the raw HTTP probe stay in test support. The runner starts no
framework daemon.

**Evidence:** a conforming server passes. A server with a deliberately
wrong index or observation version, digest, span response, or name fails its
case. The four-part HTTP fixture tests supported spans and sample boundaries.
The landed template passes with its three parts and unsupported spans. No
test needs ffmpeg, instruments, or a model provider.

**SN32. Workstation ports.** Add the optional `BashBackend.ports`
contract from [Workstation ports](../docs/sensors.md#workstation-ports).
Implement it through the existing workstation SSH session machinery.
Expose the configured hostname in guidance. Reuse account credentials
and host-key verification. Keep the destination at remote loopback.

**Evidence:** the in-process SSH and rootless OpenSSH tiers reach a real
loopback HTTP server. Tests cover disabled forwarding, a destination outside
loopback, invalid ports, establishment cancellation, disconnect, close, and
backend disposal. They verify release of session leases, channels, and local
listeners. Forwarding refusal is explicit. just-bash has no port capability.
The import rules and their probe cover the neutral transport types.

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
The focused Linux tests cover the registry and the real process-to-HTTP path
through the in-process SSH workstation fixture; `pnpm check` passes. SN33
was not run against the provisioned OpenSSH tier. The observe flow remains
pending.

**SN5. The reminder.** Show the workstation, connected process and port,
and qualified sensor names with descriptions. Use the index captured at
connection. Refresh it on an explicit repeated `connect`; dynamic
hot-plug discovery is outside the initial release. Read process state
through the existing process table. Keep media out of the reminder.

**Evidence:** a reminder shows names from two servers without clashes.
The captured index refreshes only on explicit `connect`. An ended process
shows an unavailable connection. Another agent reads discovery without the
owner's process paths or the private transport URL. Existing process
reminders still work when a sensor status read fails or exceeds its bound.
Focused tests use a real room, a running process table, and a real local HTTP
index server. The workspace suite passes 469 tests and skips 11. The
workstation SSH test is skipped on macOS. The ten MinIO tests skip without a
configured endpoint. The full `pnpm check` passes. SN35 still covers the full
workstation lifecycle.

**SN34. Retained evidence.** The internal retention operation reuses the
existing snapshot object store for verified received bytes and an
observation manifest. The manifest preserves exact observations, request,
qualified sensor, process handle, connection facts, and launch source
metadata including its dirty marker. Received bytes are independent of the
server owner's acquisition files and the observer's mutable exports. The
snapshot buffer helper stays internal; no public snapshot variant is added.
Object and bash owner operations remain separate. The operation writes safe
generated filenames into a per-call directory under the observing agent's
home and reports success only after the complete export is published.

**Evidence:** `restore` retrieves the manifest and its referenced files
after HTTP server shutdown, including for another agent. Tests cover the
default directory-backed store and the existing object conformance
backends. Modified exports do not modify evidence. Missing files, changed
digests, object-write failures, reversed requests, and cancelled partial
exports never report a successful retained observation. A real Git-template
test retains a dirty launch before stopping the server, advances the checkout
to a later commit, and restores the original launch source and bytes afterward.

**SN6. Observe.** The `observe` tool implements the input, rendering, audit
details, and snapshot result of
[Observe](../docs/sensors.md#observe-and-retain-evidence). It uses host time
for request lifecycle and source time for measurements, and supports latest
and explicitly supported spans through the same call.

**Evidence:** a real room observes numeric, text, frame, and file results.
The audit result carries the manifest ref. A message can cite it through
the existing ref validator. The initial call works without a prior
activation reminder. Unavailable spans fail explicitly.

**SN8. Text-only rendering.** `WorkspaceToolsOptions.images?: boolean`
controls inline image content for the bundle. `false` returns paths in place
of image content while the observe tool retains image bytes. The observe
schema stays the same for every executor.

**Evidence:** Pi passes 2/2 adapter cases and Claude passes 1/1 image-delivery
fixtures. Pi also verifies text-only output. Workspace checks verify that
text-only results name frame paths and that restoring the manifest returns
the exact retained image bytes. Adapter checks use no paid model call.

**SN27. The sensor template.** Add `templates/sensor-server` beside the
existing workbench templates. Its standalone Node program serves
deterministic numeric, frame, and text fixtures. Its README defines how to
build and pack the workspace package from the checkout that contains SN1,
install that tarball without saving a machine-local path, customize and
validate the server, start it in the foreground, read readiness, preserve
data, stop, replace, and roll back. It imports schemas from
`@ambionframework/workspace/sensors` rather than copying the contract, and
pins its direct `typebox` dependency. It reads its Git source once at
startup and exposes that metadata in the index. Its data directory lives
outside its checkout.

**Evidence:** a fork accepts a code change on a branch. Its tests detect
an incorrect change. A corrected change can be committed, pushed, and
cloned again. The launch command starts fixture acquisition and prints its
bound port only after writing initial acquisition data. Clean, dirty, and
detached runs report their launch metadata correctly. The template tests
cover schema and HTTP behavior, error cases, digest and data-path safety,
and clean/dirty/detached metadata. The Workbench lifecycle test proves an
invalid fixture is rejected, a corrected change is committed and pushed,
and a fresh clone runs the saved commit and returns the changed value. The
Workbench lifecycle test runs `sensorConformance` against the fresh clone.
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
source remains the earlier value even if the branch moved. If startup fails
after the remote server is ready, a fresh workspace adopts and cancels the
orphan, then verifies its port closed. A clean workspace disposal follows the
existing process stop rules.

**SN31. Release documentation.** Update workspace, workstation, process,
example, trust, and package docs as their pending changes land. Remove
pending labels only for implemented behavior. Record exports and formats
in the changelog. Keep the current package count at eleven.

**Evidence:** the plan's identifiers and relative links validate.
`pnpm check` and the OpenSSH scenario pass. A live model run is optional
confirmation, not a prerequisite for protocol or transport correctness.

**LB1. The neutral and published-surface rules.** #417 closed it. The
two neutral backend files, `git-backend.ts` and `object-backend.ts`, keep
their own rule. `packages/assistant` reaches the core through its
published entries. The dead `tools/` rules are gone, and every core layer
override has probe cases. Backlog K6 is closed.

**LB2. The core-wide ban in every layer.** #419 closed it. Biome replaces
the options of a rule for overlapping overrides, so most core layers lost
the core-wide ban. Each layer override now repeats it. The ban refuses
`node:*`, `cloudflare:*`, `@earendil-works/**`, and `@ambionframework/pi`,
with their subpaths.

**LB3. One table of the core layers.** The `biome.jsonc` comment writes
the core layer order, and the overrides repeat it by hand. The comment
omits `conformance*.ts`, and `docs/toolchain.md` §1 names four of the
layers. No override names `answers.ts`, `testing/`, `testing.ts`, or
`conformance*.ts` as a target. So `room/` can import `../answers.ts`, and
`execution/` can import `../testing/scripted.ts`, with no lint error. LB2
wrote the core-wide ban in ten copies.

Write the layer order once, as a table in `scripts/`. The table names a
layer by a glob, so one file such as `answers.ts` or `room-host/core.ts`
is a layer. The probe test derives a case for every pair of layers from
the table, and fails when `biome.jsonc` disagrees. Add probe cases for the
neutral files `resource.ts` and `resource-entry.ts`, which have none.

A case with `null` for its refusal must list pairs only. A bare specifier
in such a case always fails, so make the test refuse that form. Add a pass
case for the override of `packages/ambion/src/**` alone, in a file that no
layer override matches.

**Evidence:** the rules refuse every forbidden pair of layers and pass
every allowed pair. Delete one pattern from one layer override, and the
test fails on that pair. The `biome.jsonc` comment lists every layer of
the table.

**LB4. Subpaths outside the core.** A Biome group reads as a gitignore
pattern, and `*` does not cross `/`. Three overrides refuse a package root
and pass its subpaths. The journal override passes
`@earendil-works/pi-ai/providers/all` and
`@ambionframework/workspace/resource`. The workstation and just-bash/git
overrides pass `just-bash/browser` and `@ambionframework/just-bash/git`.
No package declares these dependencies, so no such import resolves today.
Add the `/**` form beside each root in the three groups.

**Evidence:** each of the three overrides refuses one subpath probe for
each group.

**LB5. The host layer imports no execution file.** `host/runtime.ts`
imports the types `Executor` from `execution/executor.ts` and
`TraceOpener` from `execution/trace.ts`. Four execution files import
`host/runtime.ts`. The host layer sits below execution, and its rule
refuses only `../execution/runner*`.

Move the executor contract into the vocabulary, beside `AgentPort` in
`protocol.ts`. The types are `Executor`, `ExecutorActivation`,
`ExecutorSession`, `Pass`, `PassInput`, `PassRecord`, `PassResult`,
`RoomTool`, `StepSink`, `TraceSink`, and `TraceOpener`.
`execution/` keeps the driver, the room tool bodies, and the sink. Then
make the host rule refuse `../execution/*`.

**Evidence:** no file of `host/` imports `execution/`. The rules refuse a
probe from `host/` to `../execution/executor.ts`. The export snapshot is
unchanged, or the changelog names each change.

**LB6. The room-host core imports none of its mechanisms.**
`room-host/core.ts` holds the view that every mechanism shares. It imports
the types `DeliveryState` from `dispatch.ts`, `ExchangeHandle` from
`waits.ts`, and `CompositionDraft` from `room.ts`. Those files import
`core.ts`, so the six room-host files form one cycle. Declare the three
types in `core.ts`.

**Evidence:** `core.ts` imports no other room-host file. An override
refuses an import of a room-host sibling from `core.ts`, with a probe.

**LB7. No cycle of value imports.** `workspace/src/sensors.ts` is the
`/sensors` entry and defines the wire schemas. It re-exports the client
from `sensor-client.ts`, which imports the schemas back. This is the only
cycle of value imports in `src`. It works because the client reads the
schemas inside functions only. Move the schemas into their own module,
which both files import.

Add `scripts/import-cycles.test.mjs`. It reads the relative `import` and
`export … from` lines of `packages/*/src` and `examples/*/src`, drops
`import type` and lists of `type` specifiers, and fails on any cycle.

**Evidence:** the test finds no cycle. A probe pair of modules that import
each other fails it. Type-only cycles stay allowed. The review found seven
besides LB5 and LB6: the vocabulary, `journal/`, the Cloudflare objects,
the workstation git files, the workspace git conformance files, and two in
the Workbench.

**LB8. The workspace owns its port.** This is simplification W1. 36 source
files of the workspace, the workstation, and just-bash import
`@earendil-works/pi-agent-core`. The backend contract `WorkspaceEnv`
extends Pi's `ExecutionEnv`. The file and shell results and errors, the
context, and `withAbortSignal` come from Pi. The default read, write, and
edit tools are Pi's own factories, and `bindTools` wraps a Pi tool into a
core tool. The root entry re-exports `BACKGROUND_CONTEXT`. So a host with
only Claude or Codex seats installs and loads Pi to use a workspace.

The item takes these decisions:

- **The port takes an `AbortSignal` in place of Pi's `Context`.** The
  root entry stops exporting `BACKGROUND_CONTEXT`.
- **The workspace declares its own file and shell types.** These replace
  `ExecutionEnv`, `Result`, `ok`, `err`, `FileError`, `FileErrorCode`,
  `FileInfo`, `ExecutionError`, the `ShellExec` and `ShellOutput` types,
  `JsonValue`, and `AgentToolResult`.
- **The workspace copies the helpers that it uses.** These are
  `applyShellOutputUpdate`, `truncateHead`, `truncateTail`,
  `DEFAULT_MAX_BYTES`, `DEFAULT_MAX_LINES`, `formatSize`, and
  `formatSkillsForSystemPrompt`.
- **The workspace implements `read`, `write`, and `edit` over its port.**
  They keep the parameters and output of Pi's factories.
  `packages/workspace/test/matrix.test.ts` pins them on every executor.
- **A workspace tool is a core `AmbionTool`.** `bindTools` and the Pi
  invocation stub go. The Pi executor needs no adapter.
- **The consumers move with the port.** The workstation, just-bash, and
  `examples/workbench/src/files.ts` use the new port.
- **The docs name the port.** `docs/workspace.md`, `docs/resources.md`,
  `docs/workstation.md`, and `docs/compose.md` drop the Pi binding.

The export snapshots and the changelog name every changed export.

**Evidence:** no source file and no `dependencies` field of the
workspace, the workstation, or just-bash names `@earendil-works/*`. Their
tests may reach Pi through devDependencies. The five overrides of the
workspace, the workstation, and just-bash refuse `@earendil-works/**`,
with a probe each. A new packed-consumer check installs the workspace
tarball in an empty project and finds no `@earendil-works` package. The
workspace conformance, the backend suites, the matrix cases, and the SN35
lifecycle on OpenSSH pass.

**LB9. The tests pass under full parallel load.** Three tests timed out in
full parallel test runs on 2026-10-01 and passed alone:
`examples/workbench/test/sensor-retention-source.test.ts`,
`packages/just-bash/test/just-bash.test.ts` ("ends a change that the host
asks for while the last change of a script runs"), and
`packages/workspace/test/sensor-workstation.test.ts`. Find the cause of
each. A longer timeout is a fix only when the cause is the time the work
needs.

**Evidence:** each fix names its cause. `turbo run test --force` passes
five runs in a row on Linux at the default concurrency, and the test jobs
of `.github/workflows/ci.yml` pass.
