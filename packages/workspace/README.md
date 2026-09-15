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

Installing requires a GitHub Packages read token; see the
[repository README](https://github.com/ambionframework/ambion#install).

## Use

`drive.tools()` adds the tools and optional guidance that the backend supplies.
Each tool reaches the environment the backend built for that agent, rooted at
`/home/<agent name>`.

```ts
import { defineAgent } from '@ambionframework/ambion';
import { memoryBackend, openWorkspace } from '@ambionframework/workspace';

const drive = openWorkspace({ name: 'team-site', backend: memoryBackend() });

const surveyor = defineAgent({
  name: 'surveyor',
  identity: 'Quantity surveyor. Holds the tonnage.',
  instructions: 'Read the pour plan before you answer.',
  model: 'anthropic/claude-sonnet-5',
  tools: [drive.tools()],
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
