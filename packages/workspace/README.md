# @ambionframework/workspace

Optional filesystem resources and tools for the
[Ambion collaboration kernel](https://ambionframework.com). Applications own
these resources and choose which agents share them. Workspace files remain
separate from the collaboration journal.

This package owns workspace resources and two backends over
[just-bash](https://github.com/vercel-labs/just-bash).

## Install

```sh
pnpm add @ambionframework/ambion @ambionframework/workspace
```

The packages install from npmjs with no token. A dev build of `main` installs
from GitHub Packages; see [the toolchain guide](https://github.com/ambionframework/ambion/blob/main/docs/toolchain.md#9-release-and-publishing).

## Use

`drive.tools()` returns five default tools — `read`, `write`, `edit`, `bash`,
and `sql` — plus any tool a backend adds of its own, and their guidance. Pass
it in `bundles`; each tool reaches the environment the backend built for that
agent, rooted at `/home/<agent name>`.

```ts
import { defineAgent } from '@ambionframework/ambion';
import { pi } from '@ambionframework/pi';
import { openWorkspace } from '@ambionframework/workspace';
import { memoryBackend } from '@ambionframework/workspace/just-bash';

const drive = openWorkspace({ name: 'team-site', backend: memoryBackend() });

const surveyor = defineAgent({
  name: 'surveyor',
  identity: 'Quantity surveyor. Holds the tonnage.',
  executor: pi({
    model: 'anthropic/claude-sonnet-5',
    instructions: 'Read the pour plan before you answer.',
    bundles: [drive.tools()],
  }),
});
```

## Use the resource directly

The root entry loads no backend. `/resource` holds only the neutral
contract: `openResource` and its types. It loads neither the Ambion runtime
nor a model library. `/just-bash` holds the two backends.

```ts
import { memoryBackend } from '@ambionframework/workspace/just-bash';
import { openResource } from '@ambionframework/workspace/resource';

const backend = memoryBackend({
  seed: async (write) => write.writeFile('notes.txt', 'Checked the plan.'),
});
const drive = openResource({ name: 'team-site', backend });
// `drive.use(agent, operation)` runs one operation with an agent's environment.
console.log(await backend.readFiles());
await drive.dispose();
```

This handle has `use` and `dispose`. The root `openWorkspace` function adds
the Ambion tool bundle over the same resource implementation. Both paths use
the lifecycle contract below.

## The two backends

**`memoryBackend(options)` keeps the files in memory**, for as long as the
handle lives. `options.seed` writes files before any agent connects, and
`readFiles()` reads every file back out without an agent. A host reaches the
workspace's files with no tool call, which is what a real directory gives for
free.

**`directoryBackend(root)` writes through to a real directory.** It creates
the root when an operation needs it. `drive.dispose()` releases the handle
and keeps the root and its files. A host deletes the data it owns.

Agents connected to one workspace share every file. just-bash is single-user,
so one agent can read another agent's home. The default workspace provides no
operating-system isolation between agents or distributed ownership of a shared
directory. Hosts own credentials and authorization for external services.

Every instance runs with `javascript: true` and `python: true`, so `bash`
runs a script with `js-exec` or `python3` beside just-bash's coreutils, `jq`,
`yq`, `xan` and `sqlite3`. No instance takes a `network` option, so `curl`
and every other network command stay absent.

## The contract

[`docs/workspace.md`](https://github.com/ambionframework/ambion/blob/main/docs/workspace.md)
is the design contract. It specifies the resource, its lifecycle, backend
tools and both backends.

## License

Apache-2.0
