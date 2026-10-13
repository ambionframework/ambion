# @ambionframework/workspace

Optional filesystem resources and tools for the
[Ambion collaboration kernel](https://ambionframework.com). A workspace holds
files and a shell for the agents that an application chooses to let share it.
Workspace files remain separate from the collaboration journal.

This package owns the workspace resource, its tools, and the helpers that a
bash backend builds on.

## Install

```sh
pnpm add @ambionframework/ambion @ambionframework/workspace @ambionframework/just-bash
```

The packages install from npmjs with no token. A dev build of `main` installs
from GitHub Packages; see [the toolchain guide](https://github.com/ambionframework/ambion/blob/main/docs/toolchain.md#9-release-and-publishing).

## Use

`openWorkspace` takes its backends by kind: `backend: { bash, sql, objects }`.
`bash` is required, and its `git` option holds the optional git backend.
`sql` and `objects` are optional.

`drive.tools()` returns an ordinary tool bundle. It holds the file tools
(`read`, `write`, `edit`, and `apply_patch`), the process tools (`bash`, `ps`,
`wait`, and `cancel`), and `snapshot` and `restore`. A SQL backend adds `sql`,
a git backend adds `repos` and `fork`, and a backend with endpoints adds
`fetch`. Each tool reaches the environment that the backend built for the
calling agent, rooted at `/home/<agent name>`. Pass the bundle in `bundles`.

```ts
import { defineAgent } from '@ambionframework/ambion';
import { pi } from '@ambionframework/pi';
import { openWorkspace } from '@ambionframework/workspace';
import { memoryBackend } from '@ambionframework/just-bash';
import { sqliteBackend } from '@ambionframework/workspace/sqlite';

const drive = openWorkspace({
  name: 'team-site',
  backend: { bash: memoryBackend(), sql: sqliteBackend('./team-site.db') },
});

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

## Entry points

| Entry                                    | Holds                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| `@ambionframework/workspace`             | `openWorkspace`, `loadSkills`, `fromDirectory`, and the port of a bash backend |
| `@ambionframework/workspace/resource`    | `openResource` and its types. It loads no runtime and no model library         |
| `@ambionframework/workspace/sqlite`      | `sqliteBackend`, the SQL backend over one SQLite database                      |
| `@ambionframework/workspace/s3`          | `s3ObjectBackend`, the object backend over an S3 API. It loads `aws4fetch`     |
| `@ambionframework/workspace/git`         | What every git backend shares. It loads no git library                         |
| `@ambionframework/workspace/conformance` | `workspaceConformance`, `gitConformance`, and `objectConformance`              |

## The bash backends

A bash backend is a separate package, and this package depends on none of them.

| Package                        | Backend                                                           |
| ------------------------------ | ----------------------------------------------------------------- |
| `@ambionframework/just-bash`   | `memoryBackend` and `directoryBackend`, over just-bash in process |
| `@ambionframework/workstation` | `workstationBackend`, over SSH to one remote server               |

A new backend builds its `WorkspaceEnv` on the helpers of the root entry and
runs `workspaceConformance`.

## Documentation

[The workspace](https://github.com/ambionframework/ambion/blob/main/docs/workspace.md)
states the resource, the tools, and the backends.
[Processes](https://github.com/ambionframework/ambion/blob/main/docs/processes.md),
[Snapshots](https://github.com/ambionframework/ambion/blob/main/docs/snapshots.md),
[SQL](https://github.com/ambionframework/ambion/blob/main/docs/sql.md), and
[Skills](https://github.com/ambionframework/ambion/blob/main/docs/skills.md)
state the parts.

## License

Apache-2.0
