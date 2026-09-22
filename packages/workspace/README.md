# @ambionframework/workspace

The workspace resource contract for the
[Ambion collaboration kernel](https://ambionframework.com): the neutral
resource contract, the filesystem-shaped backend contract over it, and the
generic tooling — audit, change tracking, a room mirror, an append-only log —
that runs over any backend that satisfies it. Applications own these
resources and choose which agents share them. Workspace files remain
separate from the collaboration journal.

This package holds no backend of its own.
[`@ambionframework/emulators`](https://www.npmjs.com/package/@ambionframework/emulators)
implements the backend contract over just-bash, in memory or over a real
directory.

## Install

```sh
pnpm add @ambionframework/ambion @ambionframework/workspace @ambionframework/emulators
```

The packages install from npmjs with no token. A dev build of `main` installs
from GitHub Packages; see [the toolchain guide](https://github.com/ambionframework/ambion/blob/main/docs/toolchain.md#9-release-and-publishing).

## Use

`drive.tools()` returns the tools and optional guidance that the backend
supplies. Pass it in `bundles`; each tool reaches the environment the backend
built for that agent.

```ts
import { defineAgent } from '@ambionframework/ambion';
import { pi } from '@ambionframework/pi';
import { openWorkspace } from '@ambionframework/workspace';
import { memoryBackend } from '@ambionframework/emulators';

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

The root entry exports `openResource` beside `openWorkspace`. The `/resource`
entry holds only the neutral contract: `openResource` and its types. It loads
neither the Ambion runtime nor a model library.

```ts
import { openResource, type ResourceBackend, type ResourceEnv } from '@ambionframework/workspace';

interface NoteEnv extends ResourceEnv {
  readonly notes: string[];
}

const backend: ResourceBackend<NoteEnv> = {
  connect: async () => ({ notes: [], cleanup: async () => {} }),
  destroy: async () => {},
};

const drive = openResource({ name: 'team-notes', backend });
// `drive.use(agent, operation)` runs one operation with an agent's environment.
await drive.dispose();
```

This handle has `use`, `dispose`, and `destroy`. The root `openWorkspace`
function adds the Ambion tool bundle over the same resource implementation.
Both paths use the lifecycle contract below.

## Pick a backend

`WorkspaceBackend` is the contract `openWorkspace` needs: `connect`, `destroy`,
the tools it gives an agent, and optional guidance. This package defines the
contract only. [`@ambionframework/emulators`](https://www.npmjs.com/package/@ambionframework/emulators)
implements it over just-bash, a pure-TypeScript, in-process Unix filesystem
and shell with no key and no network — `memoryBackend()` for a filesystem
that lives as long as the handle, `directoryBackend(root)` for one that
writes through to a real directory.

## The contract

[`docs/workspace.md`](https://github.com/ambionframework/ambion/blob/main/docs/workspace.md)
and [`docs/resources.md`](https://github.com/ambionframework/ambion/blob/main/docs/resources.md)
are the design contract. [`docs/emulators.md`](https://github.com/ambionframework/ambion/blob/main/docs/emulators.md)
documents the just-bash implementation.

## License

Apache-2.0
