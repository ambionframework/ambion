# The workspace

`@ambionframework/workspace` owns a workspace resource and its filesystem.
The collaboration core holds ordinary agent tools only. Workspace files are
separate from runtime journal storage.

## Open one resource

```ts
import { openWorkspace, memoryBackend } from '@ambionframework/workspace';

const drive = openWorkspace({ name: 'team-site', backend: memoryBackend() });
```

`openWorkspace` returns one owner for a backend and its data. A host creates
one owner for each shared filesystem it intends agents to share. The package
does not coordinate separate owners or processes.

The owner serializes complete operations. Each `use` call checks revocation,
opens a fresh backend environment for its agent, runs the operation, and
cleans up the environment in `finally`.

```ts
await drive.use(
  agent,
  async (env) => {
    const result = await env.writeFile('/home/surveyor/notes.txt', 'Checked the plan.');
    if (!result.ok) throw result.error;
  },
  signal,
);
```

The resource checks revocation before it connects. A queued operation that
starts after destruction is refused.

## Give the resource to an agent

`workspace.tools()` returns an ordinary Ambion `ToolBundle`. A backend supplies
its tools and optional guidance. The bundle binds each backend tool through
the resource owner and keeps one stable identity.

```ts
import { defineAgent, defineTool } from '@ambionframework/ambion';

const surveyor = defineAgent({
  name: 'surveyor',
  identity: 'Quantity surveyor. Holds the tonnage.',
  instructions: 'Read the pour plan before you answer.',
  model: 'anthropic/claude-sonnet-5',
  tools: [drive.tools()],
});
```

The core flattens tool bundles when it defines the agent. Bundle guidance is
included for message activations. The assistant's opening and closing
activations retain only their `seat` and `summarise` authority.

Custom tools close over the resource. They select the calling agent and pass
the call signal to `use`.

```ts
import { Type } from 'typebox';

const readPlan = defineTool({
  name: 'read_plan',
  description: 'Read the current pour plan.',
  parameters: Type.Object({}),
  execute: async (_params, ctx) =>
    drive.use(
      ctx.agent,
      async (env) => {
        const result = await env.readTextFile('/home/surveyor/pour-plan.md');
        if (!result.ok) throw result.error;
        return result.value;
      },
      ctx.signal,
    ),
});
```

`ToolContext` contains `agent`, `signal`, `callId`, and `onUpdate`. It holds
no workspace or resource field.

## Destroy a resource

```ts
await drive.destroy();
```

Destruction immediately revokes new and queued work. It waits for an active
operation and its cleanup, then asks the backend to delete its data once.
Concurrent calls join that deletion. A successful deletion is terminal. A
failed deletion leaves the resource active and retryable, though the backend
can have deleted some data before it reports failure.

`dispose()` releases local resources and terminally closes the handle. A
directory resource keeps its files when it is disposed. `destroy()` during
disposal, or after disposal, is refused. `dispose()` during destruction joins
the destruction. A failed release or deletion leaves its operation retryable.

A `use` callback must not await another `use`, `dispose`, or `destroy` call
on the same owner. The owner serializes those operations, so such nesting
would wait for the callback that is already running.

## Backends and limits

`memoryBackend()` keeps files in process. Its optional seed writes files
before the first use, and `readFiles()` supports host inspection. Disposal
releases its cached filesystem, so a disposed resource does not recreate a
seeded filesystem.

`directoryBackend(root)` operates on a real directory. It creates the root
when a backend operation needs it. `destroy()` deletes its contents and
keeps the root directory.

Both backends use just-bash. They provide a virtual Unix filesystem and shell
for tools, with JavaScript and Python execution available. Network commands
are absent. just-bash is single-user: agents sharing one resource can read
each other's homes. The resource boundary separates those commands from the
host machine; it does not provide user isolation or cross-process locking.

Backends perform raw filesystem I/O below the owner. They do not maintain a
second destruction mark or a second operation queue.
