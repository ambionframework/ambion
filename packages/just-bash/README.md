# @ambionframework/just-bash

The just-bash backends for an [Ambion](https://ambionframework.com)
workspace. Each backend is a `BashBackend` over
[just-bash](https://github.com/vercel-labs/just-bash): a virtual Unix
filesystem and shell in the process, in memory or over a real directory. The
`./git` entry holds a git backend over a
[just-git](https://github.com/blindmansion/just-git) server in the process.

## Install

```sh
pnpm add @ambionframework/workspace @ambionframework/just-bash
```

## Use

Pass a backend as `backend.bash`, and the file tools and the process tools of
the workspace run on it. Each agent's home is `/home/<agent name>`. The
simulated shell has the common coreutils, `jq` for JSON, `yq` for YAML and
TOML, `xan` for CSV, and `sqlite3`.

```ts
import { memoryBackend } from '@ambionframework/just-bash';
import { openWorkspace } from '@ambionframework/workspace';

const drive = openWorkspace({ name: 'team-site', backend: { bash: memoryBackend() } });
```

**`memoryBackend(options)` keeps the files in memory**, for as long as the
handle lives. `options.seed` writes files before any agent connects, and
`readFiles()` reads every file back out without an agent.

**`directoryBackend(root, options)` writes through to a real directory.** It
creates the root when an operation needs it. `drive.dispose()` releases the
handle and keeps the root and its files.

Both backends accept `options.git`, the optional git backend. They expose no
workstation endpoints, so a workspace on them has no `fetch` tool. Every
instance runs `javascript` and `python`, so `bash` runs a script with
`js-exec` or `python3`. No instance takes a `network` option, so `curl` and
every other network command stay absent. These backends give no
operating-system isolation between agents: they share every file.

**Every instance has `git`**, from just-git, with a subset of the flags of
real git. The author of a commit is the agent's name. With no git backend,
`git` has no network access, so a remote is a path on the workspace's
filesystem.

## The git backend

**`justGitBackend(options)` runs a just-git server in the host's process.**
Pass it as the `git` option of a backend. The workspace then gives each agent
the `repos` and `fork` tools, and the `git` of each agent's shell reaches the
repositories of the backend.

```ts
import { directoryBackend } from '@ambionframework/just-bash';
import { justGitBackend, sqliteGitStorage } from '@ambionframework/just-bash/git';
import { fromDirectory, openWorkspace } from '@ambionframework/workspace';

const git = justGitBackend({
  storage: sqliteGitStorage('./data/lab-git.db'),
  secret: process.env.LAB_GIT_SECRET ?? '',
  templates: {
    'weekly-report': {
      description: 'A weekly status report: numbers, risks, and next steps.',
      source: fromDirectory('./templates/weekly-report'),
    },
  },
});

const lab = openWorkspace({
  name: 'lab',
  backend: { bash: directoryBackend('./data/lab', { git }) },
});
```

The storage is one SQLite file, through `node:sqlite`. The first use opens
it, and `lab.dispose()` closes it and keeps the file. The root entry of the
package loads no `node:sqlite`.

| Option          | Meaning                                                                |
| --------------- | ---------------------------------------------------------------------- |
| `storage`       | `sqliteGitStorage(path)`, or `sqliteGitStorage(':memory:')` for tests  |
| `secret`        | The key of every token. A new secret revokes every token               |
| `templates`     | The registrations, by template name                                    |
| `shared`        | The registrations of the shared repositories, by name                  |
| `credentialTtl` | Seconds a token lives. The default is 3600                             |
| `onError`       | Called with a fault of the server. Absent, the backend reports nothing |

## Documentation

[The workspace](https://github.com/ambionframework/ambion/blob/main/docs/workspace.md)
states the backends and their limits.
[Git](https://github.com/ambionframework/ambion/blob/main/docs/git.md) states
the options of `justGitBackend`, the templates, and the tokens.
