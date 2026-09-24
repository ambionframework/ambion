# @ambionframework/git

A git backend for an [Ambion](https://ambionframework.com) workspace. A host
registers read-only templates. An agent forks a template, clones the fork
into its home, edits, commits, and pushes. A push persists the edits across
a restart of the host.

## Install

```sh
pnpm add @ambionframework/workspace @ambionframework/just-bash @ambionframework/git
```

## Use

Pass a backend as `backend.git`. The workspace then gives each agent the
`repos` and `fork` tools, and the `git` of each agent's shell reaches the
backend's repositories.

```ts
import { directoryBackend } from '@ambionframework/just-bash';
import { fromDirectory, gitBackend, sqliteGitStorage } from '@ambionframework/git';
import { openWorkspace } from '@ambionframework/workspace';

const lab = openWorkspace({
  name: 'lab',
  backend: {
    bash: directoryBackend('./data/lab'),
    git: gitBackend({
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

## The backend

**`gitBackend(options)` runs a `just-git` server in the host's process.**
The storage is one SQLite file, through `node:sqlite`. The first use opens
it, and `lab.dispose()` closes it and keeps the file.

| Option      | Meaning                                                                 |
| ----------- | ----------------------------------------------------------------------- |
| `storage`   | `sqliteGitStorage(path)`, or `sqliteGitStorage(':memory:')` for tests   |
| `secret`    | The key of every token. A new secret revokes every token                |
| `url`       | The base of every clone URL. The default is `http://git.ambion.invalid` |
| `templates` | The registrations, by template name                                     |
| `tokenTtl`  | Seconds a token lives. The default is 3600                              |

**A template never changes after registration.** The backend registers
each template before its first operation. A registration with a changed
source fails with an error that names the template. Register the change
under a new name.

**On the just-bash backends, no request leaves the process.** The name
`git.ambion.invalid` never resolves. The `git` command passes each request
to the server in the process, with a token that no file holds.

**On a workstation, the host serves `handler` over HTTP.** Listen with
`http.createServer(git.handler)` on an address that the server reaches, and
set `url` to it. The workstation backend keeps each account's
`~/.git-credentials` current.

## Tests

**`pnpm test`** runs `gitConformance` on the memory and the directory
backends, and the tests of the tokens, the registration after a crash, a
restart over one file, and a real `git` over HTTP. Every test runs in
process, with no key and no network.

[Git](https://github.com/ambionframework/ambion/blob/main/docs/git.md)
holds the design contract.
