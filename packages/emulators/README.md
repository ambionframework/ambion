# @ambionframework/emulators

In-process, pure-TypeScript reimplementations of real tools, bound as
[Ambion](https://ambionframework.com) workspace backends. An emulator
reproduces another program's behavior in TypeScript, in process, with no
binary and no operating system beneath it.

This package owns two backends over
[just-bash](https://github.com/vercel-labs/just-bash): a virtual Unix
filesystem and shell, with no key and no network. It implements the resource
contract that [`@ambionframework/workspace`](https://www.npmjs.com/package/@ambionframework/workspace)
defines.

## Install

```sh
pnpm add @ambionframework/ambion @ambionframework/workspace @ambionframework/emulators
```

The packages install from npmjs with no token. A dev build of `main` installs
from GitHub Packages; see [the toolchain guide](https://github.com/ambionframework/ambion/blob/main/docs/toolchain.md#9-release-and-publishing).

## Use

`drive.tools()` returns the tools and optional guidance that the backend
supplies. Pass it in `bundles`; each tool reaches the environment the backend
built for that agent, rooted at `/home/<agent name>`.

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

## The two backends

**`memoryBackend(options)` keeps the files in memory**, for as long as the
handle lives. `options.seed` writes files before any agent connects, and
`readFiles()` reads every file back out without an agent. A host reaches the
workspace's files with no tool call, which is what a real directory gives for
free.

**`directoryBackend(root)` writes through to a real directory.** It creates
the root when an operation needs it. `drive.destroy()` deletes its contents
and keeps the root.

Agents connected to one workspace share every file. just-bash is single-user,
so one agent can read another agent's home. Neither backend provides
operating-system isolation between agents or distributed ownership of a
shared directory. Hosts own credentials and authorization for external
services.

Every instance runs with `javascript: true` and `python: true`, so `bash`
runs a script with `js-exec` or `python3` beside just-bash's coreutils, `jq`,
`yq`, `xan` and `sqlite3`. No instance takes a `network` option, so `curl`
and every other network command stay absent.

## The contract

[`docs/emulators.md`](https://github.com/ambionframework/ambion/blob/main/docs/emulators.md)
documents both backends. [`docs/workspace.md`](https://github.com/ambionframework/ambion/blob/main/docs/workspace.md)
and [`docs/resources.md`](https://github.com/ambionframework/ambion/blob/main/docs/resources.md)
specify the resource contract this package implements.

## License

Apache-2.0
