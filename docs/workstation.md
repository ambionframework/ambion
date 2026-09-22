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
    hostKey: secrets.labHostKey,
    credentialFor: (agent) => secrets.sshLogin(agent.name),
  }),
});
```

## The SSH client

**`ssh2` carries the protocol.** Of the candidates below, it alone runs
SFTP and `exec` over one connection. Version 1.17.0 has two dependencies,
`asn1` and `bcrypt-pbkdf`, and the MIT license. It also ships an SSH
server, which the scripted tests use (see [Tests](#tests)).

| Candidate                             | SFTP                         | Decision                                                                 |
| ------------------------------------- | ---------------------------- | ------------------------------------------------------------------------ |
| `ssh2`                                | Yes, with OpenSSH extensions | Use it directly                                                          |
| `node-ssh`                            | Through `ssh2`               | Skip: a promise layer with six more dependencies                         |
| `ssh2-sftp-client`                    | Through `ssh2`               | Skip: it owns its connection, so SFTP and `exec` cannot share one client |
| `@microsoft/dev-tunnels-ssh`          | No                           | Skip: every file call would become an `exec`                             |
| The system `ssh` with `ControlMaster` | Through `sftp -b`            | Fallback: it needs the key on disk, and errors arrive as stderr text     |

**The optional native build stays off.** The `ssh2` install script runs
`node-gyp` for a crypto binding, and `cpu-features` is optional too. The
workspace skips dependency build scripts, so `ssh2` runs its JavaScript
ciphers. The ciphers run slower, and nothing else changes.

**`ssh2` is a CommonJS package with no `exports` map.** The backend
imports its default export. The types come from `@types/ssh2`, at 1.15.6
when this page was written.

**The package runs on Node only.** `ssh2` opens its socket through
`node:net`, so a bundle for workerd cannot hold it. The Cloudflare
adapter gets no workstation in v1.

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
  /** The server's host key fingerprint, as `ssh-keygen -lf` prints it. */
  readonly hostKey: string;
  credentialFor(agent: WorkspaceAgent): WorkstationCredential;
}
```

**The host provisions each account and each key before the first
connection.** The resolver reads them from the store the application
already uses: a secrets manager, an environment variable, or a file. The
backend stores, issues, and rotates no credential.

**The backend refuses to start without a host key.** `ssh2` accepts every
host key when its `hostVerifier` option is unset. The backend always sets
it: it hashes the key the server offers with SHA-256 and compares the
result with `hostKey`. A mismatch ends the handshake before any login.

**A key is Ed25519, ECDSA, or RSA with SHA-2.** `ssh2` reads no OpenSSH
certificate and no FIDO `sk-` key. A short-lived certificate for each
agent is the usual route to credential rotation. If a host needs one, the
system `ssh` client is the fallback.

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
Pi's `NodeExecutionEnv` implements the same methods on a local machine,
and `SshEnv` follows its behavior.

| Part                               | On a workstation                                  |
| ---------------------------------- | ------------------------------------------------- |
| `read`, with images                | Unchanged; images come through `readBinaryFile`   |
| `write`, `edit`, `bash`            | Unchanged                                         |
| `sql`                              | Unchanged; needs `sqlite3` on the server's `PATH` |
| Audit log, change log, room mirror | Unchanged; they write through `WorkspaceEnv`      |
| Postgres or MySQL                  | Not in v1                                         |

**Three methods need more than one SFTP request, and one needs fewer.**

| Method       | SFTP gap                                        | `SshEnv` does                                        |
| ------------ | ----------------------------------------------- | ---------------------------------------------------- |
| `renameFile` | SFTP v3 refuses to rename onto a file           | Calls `posix-rename@openssh.com`, which replaces it  |
| `createDir`  | SFTP makes one directory per request            | Makes each missing component of the path in order    |
| `remove`     | SFTP removes one entry per request              | Runs `rm -rf --` through `exec` for a recursive call |
| `listDir`    | None: `readdir` returns each entry's attributes | One request, where `BashEnv` calls `lstat` per entry |

**The `sql` export and log rotation need the replacing rename.** Both
rename a file onto a path that can exist. OpenSSH servers offer the
`posix-rename@openssh.com` extension, and `ssh2` calls it through
`ext_openssh_rename`.

**`exec` writes the directory and the variables into the command.**
`ssh2` can send an `env` request, and `sshd` drops it unless `AcceptEnv`
names the variable. `SshEnv` sends `cd -- '<dir>' && env NAME=value` in
front of the command, and it quotes every value for the shell.

## Commands and aborts

**Each command runs in its own process group.** Pi's `NodeExecutionEnv`
starts each command detached and kills the whole group with `SIGKILL`.
`SshEnv` starts the command under `setsid`, and the command reports its
group ID first. An abort opens a second channel and sends
`kill -KILL -- -<group>`.

**The SSH signal request cannot do this alone.** OpenSSH 7.9 added signal
delivery to `sshd`. It sends a subset of signals, and only to a login or a
command session. A forced command gets none. The signal reaches the
session's own child, and a pipeline's other processes keep running.

**A deadline takes the same path and reports `timeout`.** `BashEnv` tells
an abort apart from a deadline, and gives a command with no timeout the
default of 30 seconds. `SshEnv` keeps both rules.

**Output streams while the command runs.** `ssh2` delivers stdout and
stderr as the server sends them. `SshEnv` bounds them to the caller's
limits and hands each view to `onUpdate`. `BashEnv` hands one final view,
because just-bash returns the output at the end.

## Connections

**The backend keeps one SSH client for each agent.** The resource owner
calls `connect()` and `cleanup()` once for each operation
([Resources](resources.md#the-resource-contract)). A handshake on each
call adds network round trips to every tool call.

- **`connect()` opens a channel** on the cached client of that agent. It
  builds the client on the first call.
- **`cleanup()` closes that channel.** The client stays open.
- **Each client keeps one SFTP channel open** for its life, and opens one
  `exec` channel for each command.
- **`keepaliveInterval` finds a dead connection.** The backend drops the
  client, and the next `connect()` builds a new one.
- **`dispose()` and `destroy()` close every client.**

**The channels stay under the server's limit.** OpenSSH allows 10 sessions
on one connection by default (`MaxSessions`). The owner runs one operation
at a time, so a client holds at most three channels: SFTP, one command,
and one abort.

**The owner queue serializes every agent.** The queue protects the shared
memory of just-bash and the `sql` write-back. A workstation keeps it in
v1, and each operation now waits on the network. A long command from one
agent delays every other agent's tool call.

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

## Tests

**The scripted tier runs an SSH server in the test process.** `ssh2`
ships a `Server` class, and its SFTP server mode answers file requests.
The test answers them from memory, so the tier needs no container and no
network. `packages/claude` tests on a fake executable the same way.

**The integration tier runs a real `sshd`.** The test starts `sshd` with
a temporary config, a host key, and two accounts. It proves what only
OpenSSH can: the replacing rename, the group kill, `MaxSessions`, and
that one account cannot read another account's home. The `ssh2`
repository runs its own suite against OpenSSH the same way.

## Out of v1

- Postgres or MySQL on the server.
- Credential issuance and rotation, and OpenSSH certificates.
- A workspace across two or more servers.
- A workstation under workerd.
- Concurrent operations on one workspace.

## Open questions

- **Idle clients.** The cache has no eviction. A long workspace run holds
  one client for each agent that connected.
- **The owner queue.** A backend with isolation of its own could run
  operations from two agents at once. The resource contract has no way to
  say so yet.

Sources for the client facts: the published `ssh2` 1.17.0 and
`@microsoft/dev-tunnels-ssh` 3.12.42 packages, and the
[OpenSSH 7.9 release notes](https://www.openssh.org/txt/release-7.9).
