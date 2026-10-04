# Resources

**A resource is application data that an agent's tools reach.** This page
owns the resource contract, tool bundles, and the rules for provenance.
[Workspace](workspace.md) owns the workspace's resources, backends, and
tools. [Definitions and tools](agent.md) owns the rules for cited refs.

## The resource contract

`@ambionframework/workspace/resource` is the neutral contract. It exports
`openResource` and the types `ResourceBackend`, `ResourceEnv`,
`WorkspaceAgent`, and `WorkspaceResource`. This entry loads no Ambion runtime
and no model library.

| Name                | Shape                                                    |
| ------------------- | -------------------------------------------------------- |
| `openResource`      | `({ name, backend })` returns a `WorkspaceResource<Env>` |
| `WorkspaceResource` | `name`, `use(agent, op, signal?)`, `dispose()`           |
| `ResourceBackend`   | `connect(agent, signal?)`, optional `dispose()`          |
| `ResourceEnv`       | The smallest environment: one `cleanup()` method         |
| `WorkspaceAgent`    | `{ name }`                                               |

```ts
import { openResource, type ResourceBackend } from '@ambionframework/workspace/resource';

interface NoteEnv {
  readonly notes: string[];
  cleanup(): Promise<void>;
}

const backend: ResourceBackend<NoteEnv> = {
  connect: async () => ({ notes: [], cleanup: async () => {} }),
};

const resource = openResource({ name: 'team-notes', backend });
await resource.use({ name: 'surveyor' }, (env) => {
  env.notes.push('Checked the plan.');
});
await resource.dispose();
```

**One queue serializes every operation.** Each `use` checks revocation,
connects a fresh environment for its agent, runs the callback, and calls
`cleanup()` in `finally`. A queued operation checks revocation before it
connects. An aborted signal refuses the operation before it connects.

**A callback must not await another operation on the same resource.** A
nested `use` or `dispose` would wait for the callback that is already
running.

**Disposal revokes work.** `dispose()` refuses new and queued work at once.
It waits for the active operation and its cleanup, then releases the
backend's local handles once. Concurrent calls join that release. A
successful disposal is terminal. A failed disposal leaves the resource
active and retryable. The host owns deletion of persisted data.

**A backend picks its own environment.** The environment extends
`ResourceEnv`. [Workspace](workspace.md#open-one-resource) lists the
resources that `openWorkspace` opens and the environments that they use.

**The contract has no freshness guarantee.** The room's freshness check
governs what an agent says. It does not govern what a tool reads from a
resource. A tool that needs the current state of the room reads the room.

## Tool bundles

**A `ToolBundle` supplies tools and their guidance to an executor.** The
`bundles` field accepts bundles alongside the ordinary tools of `tools`.
`describeExecutor` flattens them. `defineAgent` refuses duplicate tool
names. Bundle guidance appears in each activation
([The prompt the driver renders](executors.md#the-prompt-the-driver-renders)).

| Field      | Contract                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------ |
| `tools`    | Required. The bundle's `readonly AmbionTool[]`                                             |
| `guidance` | Optional. Instructions for the tools                                                       |
| `macros`   | Optional. `readonly ComposeMacro[]`; a seat with `compose` runs them ([Macros](macros.md)) |
| `remind`   | Optional. Text for one respond activation, or `undefined`                                  |

**A reminder receives the seat and an abort signal.** `ReminderSeat` holds
`agent`, `room`, and `activation` as strings. `Reminder` returns text or
`undefined`, directly or through a promise.
[Processes](processes.md#reminders) owns when reminders run, their time
limit, and the workspace's process reminder.

**Custom tools close over a resource.** They pass `ctx.agent` and
`ctx.signal` to `use`. The [workspace example](workspace.md#give-the-resource-to-an-agent)
shows a bundle and a custom tool.

## References and provenance

**An artifact is cited as a ref on the record.** A message and a summary
carry `refs`, absolute URIs that the room stores and never reads behind.
[Definitions and tools](agent.md) owns the ref rules. A resource change is
cited by a URI that the resource gives, or by one that the application
chooses.

**Each tool call receives a frozen `ToolContext`.** The executor builds it
once per call. It holds `agent`, `signal`, `callId`, and `onUpdate`. It
also carries room provenance and the optional `deadline` and `composeCall`.
[Definitions and tools](agent.md) describes `composeCall`. The context has
no workspace or resource field.

**Provenance names who made a change.** `room` names the room.
`activation` is the id that every event and message of the activation
carries. `exchange` holds the `from` of the exchange that was
open when the activation read the record, and its `person` once a person
spoke in it. It is absent when no exchange was open. All three are absent
outside a room. A binding stamps them where its data allows.

The workspace records calls in its opt-in
[audit log](workspace.md#record-every-tool-call). The SQL backend stamps
[append-only records](workspace.md#records-append-only-tables-with-provenance).
A backend defines where it stores provenance. Host code supplies its own
provenance for direct operations.

**Provenance grants no authority.** A tool does not check it to allow or
refuse a call. A tool that needs current state reads the room.
