# @ambionframework/workstation

A workspace bash backend and a git backend for the
[Ambion collaboration kernel](https://ambionframework.com) over SSH. A
workstation is one remote server with one Unix account for each agent. The
operating system of the server keeps one agent's files apart from another's.

## Install

```sh
pnpm add @ambionframework/workspace @ambionframework/workstation
```

The package runs on Node only. It opens its socket through `node:net`, so
workerd cannot load it.

## Use

`workstationBackend(options)` returns a `BashBackend`. Pass it as
`backend.bash`, and the file tools and the process tools of the workspace run
on the server as the calling agent.

```ts
import { readFile } from 'node:fs/promises';
import { openWorkspace } from '@ambionframework/workspace';
import { sqliteBackend } from '@ambionframework/workspace/sqlite';
import { workstationBackend } from '@ambionframework/workstation';

const lab = openWorkspace({
  name: 'lab',
  backend: {
    bash: workstationBackend({
      host: 'lab.internal',
      hostKey: 'SHA256:<the fingerprint that ssh-keygen -lf prints>',
      layout: { audit: '/srv/ambion/lab/audit/audit.jsonl', rooms: '/srv/ambion/lab/rooms' },
      credentialFor: async (agent) => ({
        username: agent.name,
        privateKey: await readFile(`/etc/ambion/keys/${agent.name}`, 'utf8'),
      }),
    }),
    sql: sqliteBackend('./data/lab.db'),
  },
});
```

| Option          | What it is                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `host`, `port`  | The address of the server. The port is 22 by default                                                                             |
| `hostKey`       | The SHA-256 fingerprint of the server's host key. The backend refuses any other                                                  |
| `layout`        | The path of the audit log and the folder of the room mirror on the server                                                        |
| `idleTimeout`   | Seconds a connection may stay with no open environment before the backend closes it. A running process holds one. 300 by default |
| `credentialFor` | The username and private key of an agent, or of the host account `<name>-host`                                                   |

## The git backend

`workstationGitBackend(options)` returns a `GitBackend`. Pass it as
`backend.git`, beside `workstationBackend`. One more account on the same
server owns every repository. Each agent clones and pushes with its own
`git` over SSH to that account on the loopback address, and the host
opens no port.

```ts
import { readFile } from 'node:fs/promises';
import { openWorkspace } from '@ambionframework/workspace';
import { fromDirectory } from '@ambionframework/workspace/git';
import { workstationBackend, workstationGitBackend } from '@ambionframework/workstation';

// `layout` and `credentialFor` are the options of the example above.
const server = { host: 'lab.internal', hostKey: 'SHA256:<fingerprint>' };

const lab = openWorkspace({
  name: 'lab',
  backend: {
    bash: workstationBackend({ ...server, layout, credentialFor }),
    git: workstationGitBackend({
      ...server,
      account: {
        username: 'lab-git',
        privateKey: await readFile('/etc/ambion/keys/lab-git', 'utf8'),
      },
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

| Option         | What it is                                                                             |
| -------------- | -------------------------------------------------------------------------------------- |
| `host`, `port` | The address of the server, the same as for the bash backend. The port is 22 by default |
| `hostKey`      | The SHA-256 fingerprint of the server's host key. The backend refuses any other        |
| `account`      | The username and private key of the git account                                        |
| `root`         | The folder of the repositories, in the account's home. `repos` by default              |
| `alias`        | The host name in every clone URL. `ambion-git` by default                              |
| `templates`    | The templates, by name                                                                 |
| `keyTtl`       | Whole seconds an agent key lives. 3600 by default                                      |
| `idleTimeout`  | Seconds the git account's client may stay unused. 300 by default                       |

**The git backend issues and rotates the git key of each agent.** At each
`connect`, the bash backend writes the key, a `known_hosts` file, and an
ssh configuration for the alias into the agent's `~/.ssh`. The key works
only from the loopback address, until it expires.

## Prepare the server

**The host provisions every account and the key of each account.** The
bash backend stores, issues, and rotates no account key.

- **One account for each agent and for `<name>-host`,** each with a
  login shell that runs a command, and a home of mode `0700`.
- **`bash` and a `setsid` that has `--wait`,** from util-linux.
- **One group for every account.** The folder of `layout.audit` belongs
  to it, with mode `2770` and `setfacl -d -m g::rw`.
- **`layout.rooms` belongs to the host account,** with mode `2750` and
  the same group.

**The git backend needs one more account and one `Match` block.**

- **One git account, such as `lab-git`,** with a login shell of `bash`, a
  home of mode `0700`, and no membership in the agents' group. The host's
  key for it goes in `~/.ssh/authorized_keys`.
- **A `Match` block, last in `sshd_config`,** that adds the file the
  backend writes:

  ```text
  Match User lab-git
    AuthorizedKeysFile .ssh/authorized_keys .ssh/authorized_keys.ambion
  ```

- **`AllowUsers`, when it is set,** names the git account.
- **`git` and `openssh-client`** on the server. An agent runs `ssh` to
  reach the git account.
- **OpenSSH 7.7 or newer,** for the `expiry-time` option of a key line.
- **GNU coreutils and util-linux** for `mv -T`, `date -d`, and `flock`.

[`test/sshd/setup.sh`](https://github.com/ambionframework/ambion/blob/main/packages/workstation/test/sshd/setup.sh) does each step on a disposable
machine.

## Tests

- **`pnpm test`** runs the scripted tier. An `ssh2` server in the test
  process serves a temporary directory, and `workspaceConformance` runs on
  it. It needs `setsid`, so it skips on macOS. The tests of the git
  backend also need `git` and `flock`, and skip without them.
- **`pnpm test:sshd`** runs the integration tier against OpenSSH. Run
  `sudo bash test/sshd/setup.sh <dir>` first, and set
  `AMBION_WORKSTATION_SSHD=<dir>/workstation.json`. The script adds users,
  so run it on a machine you can throw away. The tier runs
  `gitConformance` on the git account `lab-git`.

[Workstation](https://github.com/ambionframework/ambion/blob/main/docs/workstation.md)
and
[Workstation git](https://github.com/ambionframework/ambion/blob/main/docs/workstation-git.md)
hold the design contracts, and
[Trust](https://github.com/ambionframework/ambion/blob/main/docs/trust.md)
states what the server's permissions contain.
