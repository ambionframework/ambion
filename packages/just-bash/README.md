# @ambionframework/just-bash

The just-bash backends for an
[Ambion](https://ambionframework.com) workspace. Each backend is a
`BashBackend` over [just-bash](https://github.com/vercel-labs/just-bash): a
virtual Unix filesystem and shell in the process, in memory or over a real
directory. The `./git` entry holds a git backend over a
[just-git](https://github.com/blindmansion/just-git) server in the process.

## Install

```sh
pnpm add @ambionframework/workspace @ambionframework/just-bash
```

## Use

Pass a backend as `backend.bash`, and the file tools and the process tools of
the workspace run on it. Each agent's home is `/home/<agent name>`.

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
backend ([`justGitBackend`](#the-git-backend)), `git` reaches the backend's
URL prefix alone, and the token of each request stays inside the `git`
command. The guidance tells each agent the same.

## The git backend

**`justGitBackend(options)` runs a `just-git` server in the host's
process.** Pass it as `backend.git`. The workspace then gives each agent
the `repos` and `fork` tools, and the `git` of each agent's shell reaches
the backend's repositories. An agent forks a read-only template, clones the
fork into its home, edits, commits, and pushes. A push persists the edits
across a restart of the host.

```ts
import { directoryBackend } from '@ambionframework/just-bash';
import { justGitBackend, sqliteGitStorage } from '@ambionframework/just-bash/git';
import { openWorkspace } from '@ambionframework/workspace';
import { fromDirectory } from '@ambionframework/workspace/git';

const lab = openWorkspace({
  name: 'lab',
  backend: {
    bash: directoryBackend('./data/lab'),
    git: justGitBackend({
      storage: sqliteGitStorage('./data/lab-git.db'),
      secret: process.env.LAB_GIT_SECRET ?? '',
      templates: {
        'weekly-report': {
          description: 'A weekly status report: numbers, risks, and next steps.',
          source: fromDirectory('./templates/weekly-report'),
        },
      },
    }),
  },
});
```

The storage is one SQLite file, through `node:sqlite`. The first use opens
it, and `lab.dispose()` closes it and keeps the file. The root entry of the
package loads no `node:sqlite`.

| Option      | Meaning                                                                |
| ----------- | ---------------------------------------------------------------------- |
| `storage`   | `sqliteGitStorage(path)`, or `sqliteGitStorage(':memory:')` for tests  |
| `secret`    | The key of every token. A new secret revokes every token               |
| `templates` | The registrations, by template name                                    |
| `tokenTtl`  | Seconds a token lives. The default is 3600                             |
| `onError`   | Called with a fault of the server. Absent, the backend reports nothing |

**A registration updates its template.** The backend registers each
template before its first operation. A changed source fast-forwards the
template to a new commit, and a changed description replaces the old one.
A fork keeps the commit it came from.

**No request leaves the process.** Every clone URL starts with
`http://git.ambion.invalid`, a name that never resolves. The `git` command
passes each request to the server in the process, with a token that no
file holds. This is the `in-process` transport. The two just-bash
backends carry it, and a workstation carries `ssh`.
`openWorkspace` throws when the bash backend does not carry the
transport of the git backend.

## Tests

**`pnpm test`** runs `workspaceConformance` on both backends, and the
tests of the adapter, the memory backend, and the `/dev` layer. It runs
`gitConformance` on both backends under `justGitBackend`, and the tests of
the tokens, the registration after a crash, and a restart over one file.
Every test runs in process, with no key and no network.

[Workspace](https://github.com/ambionframework/ambion/blob/main/docs/workspace.md)
and [Git](https://github.com/ambionframework/ambion/blob/main/docs/git.md)
hold the design contracts.
