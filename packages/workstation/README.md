# @ambionframework/workstation

A workspace bash backend for the
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
`backend.bash`, and the file tools and the job tools of the workspace run
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

| Option          | What it is                                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `host`, `port`  | The address of the server. The port is 22 by default                                                                         |
| `hostKey`       | The SHA-256 fingerprint of the server's host key. The backend refuses any other                                              |
| `layout`        | The path of the audit log and the folder of the room mirror on the server                                                    |
| `idleTimeout`   | Seconds a connection may stay with no open environment before the backend closes it. A running job holds one. 300 by default |
| `credentialFor` | The username and private key of an agent, or of the host account `<name>-host`                                               |

## Prepare the server

**The host provisions every account and every key.** The backend stores,
issues, and rotates no credential.

- **One account for each agent and for `<name>-host`,** each with a
  login shell that runs a command, and a home of mode `0700`.
- **`bash` and a `setsid` that has `--wait`,** from util-linux.
- **One group for every account.** The folder of `layout.audit` belongs
  to it, with mode `2770` and `setfacl -d -m g::rw`.
- **`layout.rooms` belongs to the host account,** with mode `2750` and
  the same group.

[`test/sshd/setup.sh`](https://github.com/ambionframework/ambion/blob/main/packages/workstation/test/sshd/setup.sh) does each step on a disposable
machine.

## Tests

- **`pnpm test`** runs the scripted tier. An `ssh2` server in the test
  process serves a temporary directory, and `workspaceConformance` runs on
  it. It needs `setsid`, so it skips on macOS.
- **`pnpm test:sshd`** runs the integration tier against OpenSSH. Run
  `sudo bash test/sshd/setup.sh <dir>` first, and set
  `AMBION_WORKSTATION_SSHD=<dir>/workstation.json`. The script adds users,
  so run it on a machine you can throw away.

[Workstation](https://github.com/ambionframework/ambion/blob/main/docs/workstation.md)
holds the design contract, and
[Trust](https://github.com/ambionframework/ambion/blob/main/docs/trust.md)
states what the server's permissions contain.
