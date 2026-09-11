# @ambionframework/workspace

A workspace backend for [Ambion](https://ambionframework.com): a virtual Unix
filesystem and shell that an agent's tools reach into.

`@ambionframework/ambion` names the identity and data boundary an agent
connects to, and it holds no filesystem. `WorkspaceBackend` is the port it
names. This package holds two implementations of that port, over
[just-bash](https://github.com/vercel-labs/just-bash).

## Install

```sh
pnpm add @ambionframework/ambion @ambionframework/workspace
```

## Use

An agent that names a workspace holds four more tools on every activation:
`read`, `write`, `edit` and `bash`. Each one reaches the environment the
backend built for that agent, rooted at `/home/<agent name>`.

```ts
import { defineAgent, defineWorkspace } from '@ambionframework/ambion';
import { memoryBackend } from '@ambionframework/workspace';

const drive = defineWorkspace({ name: 'team-site', backend: memoryBackend() });

const surveyor = defineAgent({
  name: 'surveyor',
  identity: 'Quantity surveyor. Holds the tonnage.',
  instructions: 'Read the pour plan before you answer.',
  model: 'anthropic/claude-sonnet-5',
  workspace: drive,
});
```

## The two backends

**`memoryBackend(options)` keeps the files in memory**, for as long as the
handle lives. `options.seed` writes files before any agent connects, and
`readFiles()` reads every file back out without an agent. A host reaches the
workspace's files with no tool call, which is what a real directory gives for
free.

**`directoryBackend(root)` writes through to a real directory.** It creates
the root on the first connect. `destroyWorkspace` empties the root and leaves
it.

Two agents connected to one workspace share every file. The boundary is
nominal: just-bash is single-user, so one agent's `bash` call reads another's
home. What a workspace offers is a wall between an agent's commands and the
machine.

Every instance runs with `javascript: true` and `python: true`, so `bash`
runs a script with `js-exec` or `python3` beside just-bash's coreutils, `jq`,
`yq`, `xan` and `sqlite3`. No instance takes a `network` option, so `curl`
and every other network command stay absent.

## The contract

[`docs/workspace.md`](https://github.com/ambionframework/ambion/blob/main/docs/workspace.md)
is the design contract. It specifies the handle, the resolver, the built-in
tools and both backends.

## License

Apache-2.0
