# @ambionframework/just-bash

The just-bash backends for an
[Ambion](https://ambionframework.com) workspace. Each backend is a
`BashBackend` over [just-bash](https://github.com/vercel-labs/just-bash): a
virtual Unix filesystem and shell in the process, in memory or over a real
directory.

## Install

```sh
pnpm add @ambionframework/workspace @ambionframework/just-bash
```

## Use

Pass a backend as `backend.bash`, and the four file tools of the workspace
run on it. Each agent's home is `/home/<agent name>`.

```ts
import { memoryBackend } from '@ambionframework/just-bash';
import { openWorkspace } from '@ambionframework/workspace';

const drive = openWorkspace({ name: 'team-site', backend: { bash: memoryBackend() } });
```

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

**Every instance has `git`**, from [just-git](https://github.com/blindmansion/just-git).
It supports the common subcommands, each with a subset of the flags of real
git. The author of a commit is the agent's name, and `git config` does not
change it. With no git backend, `git` has no network access, so a remote is a
path on the workspace's filesystem, such as another agent's home. With a git
backend ([`@ambionframework/git`](../git/README.md)), `git` reaches the
backend's URL prefix alone, and the token of each request stays inside the
`git` command. The guidance tells each agent the same.

## Tests

**`pnpm test`** runs `workspaceConformance` on both backends, and the
tests of the adapter, the memory backend, and the `/dev` layer. Every test
runs in process, with no key and no network.

[Workspace](https://github.com/ambionframework/ambion/blob/main/docs/workspace.md)
holds the design contract.
