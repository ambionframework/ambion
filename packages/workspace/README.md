# @ambionframework/workspace

Optional filesystem resources and tools for the
[Ambion collaboration kernel](https://ambionframework.com). Applications own
these resources and choose which agents share them. Workspace files remain
separate from the collaboration journal.

This package owns workspace resources, their tools, and the helpers a bash
backend builds on.

## Install

```sh
pnpm add @ambionframework/ambion @ambionframework/workspace @ambionframework/just-bash
```

The packages install from npmjs with no token. A dev build of `main` installs
from GitHub Packages; see [the toolchain guide](https://github.com/ambionframework/ambion/blob/main/docs/toolchain.md#9-release-and-publishing).

## Use

`drive.tools()` returns three file tools — `read`, `write`, and `edit` —
and five process tools — `bash`, `ps`, `status`, `wait`, and `cancel` — plus `sql`
when the workspace has a SQL backend, plus any tool the bash backend adds of
its own, and their guidance. Pass it in `bundles`; each tool reaches the
environment the backend built for that agent, rooted at
`/home/<agent name>`. `bash` starts each command as a background process and
returns its handle, and `drive.processes` lists them for the host; see [Processes](https://github.com/ambionframework/ambion/blob/main/docs/processes.md).

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

## Use the resource directly

The root entry loads no backend. `./resource` holds only the neutral
contract: `openResource` and its types. It loads neither the Ambion runtime
nor a model library. `./sqlite` holds `sqliteBackend`,
the SQL backend over one SQLite database. `./sql` holds `openSqlResource`, a
resource over its own SQLite database, with its `SqlProvenance` and
`SqlResourceEnv` types. `./conformance` holds `workspaceConformance`, the
scenario matrix a new backend runs to prove it meets the resource contract,
and `sqlConformance` and `gitConformance`, the cases a `SqlBackend` and a
`GitBackend` run.

`./git` holds what every git backend shares, and it loads no git library.
The name rules of a repository ID are `validName`, `namespaceOf`,
`assertAgent`, `readOnly`, `TEMPLATES`, and `SOURCES`. The template helpers
are `fromDirectory`, `filesOf`, `hashesOf`, `sameFiles`, and `changeTo`,
with the `TemplateRegistration`, `TemplateSource`, and `TemplateFiles`
types. `@ambionframework/just-bash/git` holds a git backend that uses them.

`openWorkspace` takes its backends by kind: `backend: { bash, sql }`.
`bash` is required. `sql` is an optional `SqlBackend`, and the `sql` tool
then runs on that database. With no SQL backend, the workspace has no `sql`
tool. The root entry exports the `SqlBackend` interface.

```ts
import { memoryBackend } from '@ambionframework/just-bash';
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

## The bash backends

A bash backend is a separate package, and this package depends on none of
them:

| Package                        | Backend                                                           |
| ------------------------------ | ----------------------------------------------------------------- |
| `@ambionframework/just-bash`   | `memoryBackend` and `directoryBackend`, over just-bash in process |
| `@ambionframework/workstation` | `workstationBackend`, over SSH to one remote server               |

A new backend builds its `ExecutionEnv` on the helpers of the root entry
and runs `workspaceConformance`.

## The contract

[`docs/workspace.md`](https://github.com/ambionframework/ambion/blob/main/docs/workspace.md)
is the design contract. It specifies the resource, its lifecycle, backend
tools and the just-bash backends.

## License

Apache-2.0
