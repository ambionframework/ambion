# The workstation

**This page is a design. No package implements it yet.** The
[backlog](../planning/backlog.md#designs-with-a-shape) names the condition
that schedules it. Every name below is a proposal, and it changes if the
review changes it.

**A workstation is one remote server with one Unix account for each
agent.** A workspace connects to it over SSH, and each agent logs in with
its own credentials. The operating system of the server keeps one agent's
files apart from another's. The just-bash backends have no such boundary
([Workspace](workspace.md#backends-and-limits)).

## The name and the protocol

**The name is the concept, and SSH is the v1 protocol.** The package
`@ambionframework/workstation` exports `workstationBackend(options)`. It
returns a `WorkspaceBackend`, and `openWorkspace` takes it as it takes
`directoryBackend()`. A later protocol joins the same package under the
same name.

```ts
import { openWorkspace } from '@ambionframework/workspace';
import { workstationBackend } from '@ambionframework/workstation';

const lab = openWorkspace({
  name: 'lab',
  backend: workstationBackend({
    host: 'lab.internal',
    credentialFor: (agent) => secrets.sshLogin(agent.name),
  }),
});
```

## Credentials

**The host owns every credential.** `docs/workspace.md` states the rule
for every backend: the host owns credentials for external services. The
backend takes one resolver and holds no credential of its own.

```ts
interface WorkstationCredential {
  readonly username: string;
  readonly privateKey: string;
  readonly passphrase?: string;
}

interface WorkstationOptions {
  readonly host: string;
  readonly port?: number;
  credentialFor(agent: WorkspaceAgent): WorkstationCredential;
}
```

**The host provisions each account and each key before the first
connection.** The resolver reads them from the store the application
already uses: a secrets manager, an environment variable, or a file. The
backend stores, issues, and rotates no credential.

## One server for each workspace

**The address is fixed at construction.** Only the account changes from
agent to agent. A workspace across two or more servers needs a resolver
that also names the server. It also needs a client cache keyed by server
and agent. V1 has neither.

**The account's home is the working directory.** The just-bash backends
make `/home/<name>` on the first connection. A workstation account has a
home from the server's own user management. `connect()` reads `$HOME`
from the login and makes no directory. `changedPaths` resolves a path
against the same home.

## The environment

**`SshEnv` implements Pi's `ExecutionEnv`, as `BashEnv` does.** A file
call goes over SFTP. Each `exec` opens one channel on the SSH client. The
workspace tools call `ExecutionEnv` only, so each one runs with no change.

| Part                               | On a workstation                                  |
| ---------------------------------- | ------------------------------------------------- |
| `read`, with images                | Unchanged; images come through `readBinaryFile`   |
| `write`, `edit`, `bash`            | Unchanged                                         |
| `sql`                              | Unchanged; needs `sqlite3` on the server's `PATH` |
| Audit log, change log, room mirror | Unchanged; they write through `WorkspaceEnv`      |
| Postgres or MySQL                  | Not in v1                                         |

## Connections

**The backend keeps one SSH client for each agent.** The resource owner
calls `connect()` and `cleanup()` once for each operation
([Resources](resources.md#the-resource-contract)). A handshake on each
call adds network round trips to every tool call.

- **`connect()` opens a channel** on the cached client of that agent. It
  builds the client on the first call.
- **`cleanup()` closes that channel.** The client stays open.
- **`dispose()` and `destroy()` close every client.**

## SQL

**`sql` runs the server's own `sqlite3`.** The tool calls `sqlite3`
through `exec` ([Workspace](workspace.md#query-the-shared-database)), so
it needs no new code. The server must have `sqlite3` on its `PATH`.

**`ATTACH` of a second file works.** The server's `sqlite3` reads the real
filesystem. The just-bash engine opens `:memory:` only.

**The export row count calls `xan`.** With no `xan` on the server, the
count reads zero. The export itself still completes.

**Postgres and MySQL wait.** Each needs another command, another dialect,
and a database credential apart from the SSH login. A second resolver or a
wider `credentialFor` carries that credential.

## Guidance

**The guidance states what every workstation has.** The shell is real,
the network is open, and each agent has its own account. The just-bash
guidance names a fixed tool set and no network, so the workstation writes
its own. The application names the tools that its server installs.

## Trust

**`docs/trust.md` gets a new row before the backend ships.** An agent on
a workstation has a real shell and network access. The account
permissions on the server contain it. The kernel does not.

**The live exclusivity test covers the just-bash backends only.** It
shows that a seat cannot read `/etc/hosts`
([Trust](trust.md#what-each-harness-exposes)). On a workstation that
result depends on the server's permissions.

## Out of v1

- Postgres or MySQL on the server.
- Credential issuance and rotation.
- A workspace across two or more servers.

## Open questions

- **The known host key.** The backend checks the server's host key. The
  design does not yet say where the host configures it.
- **Idle clients.** The cache has no eviction. A long workspace run holds
  one client for each agent that connected.
