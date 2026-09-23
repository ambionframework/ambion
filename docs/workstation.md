# The workstation

**This page is a design. No package implements it yet.** The
[backlog](../planning/backlog.md#designs-with-a-shape) names the condition
that schedules it. The design builds on the workspace interface that
[Workspace](workspace.md) states. Every name below that the workspace
package does not export is a proposal, and it changes if the review
changes it.

**A workstation is one remote server with one Unix account for each
agent.** A workspace connects to it over SSH, and each agent logs in with
its own credentials. The operating system of the server keeps one agent's
files apart from another's. The just-bash backends have no such boundary
([Workspace](workspace.md#backends-and-limits)).

## The name and the protocol

**The name is the concept, and SSH is the v1 protocol.** The package
`@ambionframework/workstation` exports `workstationBackend(options)`. It
returns a `BashBackend`, the one backend kind that every workspace has. A
later protocol joins the same package under the same name.

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

**The example names each account after its agent.** It reads each
private key from a file on the Ambion host. `lab.host.name` is `lab-host`, so
the server has an account and a key of that name too.

**The package reaches the workspace through its root entry.** That entry
holds the interface and the environment helpers, and it loads no just-bash
and no `node:sqlite`. The tests also import
`@ambionframework/workspace/conformance`.

## What the backend supplies

**A `BashBackend` supplies a transport and the facts of its server.** The
workspace supplies everything that holds on every backend
([The resource contract](workspace.md#the-resource-contract)).

| Part                                  | Owner                                           |
| ------------------------------------- | ----------------------------------------------- |
| `connect()` and `dispose()`           | The workstation                                 |
| `SshEnv`, the transport of each call  | The workstation                                 |
| `layout`: the audit log and the rooms | The workstation, from its options               |
| `guidance` about the shell            | The workstation                                 |
| `read`, `write`, `edit`, `bash`       | The workspace: the four file tools              |
| `sql`                                 | The workspace, when `backend.sql` is set        |
| Path rule, deadline, output view      | The workspace: the environment helpers          |
| Audit log and room mirror             | The workspace, at the paths that `layout` names |

**The workstation adds no tools.** The four file tools cover every file
and shell operation on a server, so `tools` stays unset.

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

**The host owns every credential.** The workspace states the rule for
every backend: the host owns credentials for external services. The
backend takes one resolver and holds no credential of its own.

```ts
import type { WorkspaceLayout } from '@ambionframework/workspace';
import type { WorkspaceAgent } from '@ambionframework/workspace/resource';

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
  readonly layout: WorkspaceLayout;
  /** Seconds a client may stay unused before the backend closes it. The default is 300. */
  readonly idleTimeout?: number;
  credentialFor(agent: WorkspaceAgent): WorkstationCredential | Promise<WorkstationCredential>;
}
```

**The resolver answers for every agent and for `workspace.host`.** A
`WorkspaceAgent` holds `name` alone. `openWorkspace` builds the host
agent `<name>-host`, and `mirror()` writes as it
([The layout and the host identity](workspace.md#the-layout-and-the-host-identity)).
The host gives it an account and a key, the same as an agent.

**The host provisions each account and each key before the first
connection.** The resolver reads them from the store the application
already uses: a secrets manager, an environment variable, or a file. The
backend awaits the resolver each time it builds a client for an agent. It
stores, issues, and rotates no credential.

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
home from the server's own user management. The SFTP server starts in that
home, so the backend reads it once for each client with `realpath('.')`.
`resolvePath` resolves `~` and a relative path against that home.

**The server runs bash and util-linux.** `SshEnv` runs each command
through `bash`, whatever the login shell of the account is. It also needs
a `setsid` that has the `--wait` option. Each account needs a login shell
that runs a command, so `nologin` does not serve.

## The layout on a server

**`layout` names one file and one folder.** `layout.audit` is the path of
the audit log. `layout.rooms` is the folder that `mirror()` writes each
room's record under. Different accounts write the two paths, so they need
different permissions.

| Path                  | Writer                                                 | Mode on the server                                |
| --------------------- | ------------------------------------------------------ | ------------------------------------------------- |
| The folder of `audit` | Every agent: each tool call writes its entry as itself | Group write, setgid, and a default ACL of `g::rw` |
| `rooms`               | The host account alone                                 | Owner write, group read                           |
| Each agent's home     | That agent alone                                       | `0700`                                            |
| `/tmp`                | Every account, one private file each                   | The server's own `/tmp`, with the sticky bit      |

**One group holds every agent account and the host account.** The folder
of the audit log belongs to that group, with group write and the setgid
bit, so a new file keeps the group. A rotation renames the active file
inside that folder, so the folder needs group write as well as the file.

**A default ACL keeps each new audit file writable for the group.** The
SFTP server creates each file under its own umask, and that umask is
usually `022`. A `umask` inside a command does not reach it. The host sets
`setfacl -d -m g::rw` on the audit folder, and `SshEnv` asks SFTP for mode
`0664` on an ordinary file. The agent that rotates the log creates the
next file, and every other agent still appends to it.

**Each home stays at mode `0700`.** A file of mode `0664` in a home
reaches no other account.

**A temporary file is private to its account.** Every account shares
`/tmp`. `SshEnv` creates a temporary file with an exclusive create and
mode `0600`, and a temporary directory with mode `0700`. A spill file
holds a command's full output, so no other agent reads it.

## The environment

**`SshEnv` implements the transport of Pi's `ExecutionEnv`.** A file call
goes over SFTP. Each `exec` opens one channel on the SSH client. The root
entry's helpers supply the rest:

- `resolvePath` for `~` and a relative path
- `Deadline`, which tells an abort apart from a timeout
- `boundedView` and `spill` for the output view and its spill file
- `tempDirPath`, `tempFilePath`, and `spillPath` for the names under `/tmp`

Pi's `NodeExecutionEnv` implements the same methods on a local machine,
and `SshEnv` follows its behavior.

**SFTP needs five adjustments.** `workspaceConformance` checks each row.

| Method                | SFTP gap                                                                                          | `SshEnv` does                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Every file method     | OpenSSH answers `ENOTDIR` as `NO_SUCH_FILE`, and `EISDIR`, `EEXIST`, and `ENOTEMPTY` as `FAILURE` | On either status, one `lstat` picks the Pi code, as the next paragraph states |
| `renameFile`          | SFTP v3 refuses to rename onto a file                                                             | Calls `posix-rename@openssh.com`; a server without it gets a plain `RENAME`   |
| `createDir`           | SFTP makes one directory per request, and an existing one answers `FAILURE`                       | Makes each missing component in order; `lstat` finds a directory that exists  |
| `remove`              | SFTP removes one entry per request                                                                | Runs `rm -rf --` through `exec` for a recursive call                          |
| `fileInfo`, `listDir` | SFTP gives `mtime` in seconds                                                                     | Multiplies it by 1000 for `mtimeMs`; `readdir` gives each entry's attributes  |

**One `lstat` classifies a coarse status by the operation.** A file
operation on a directory gives `is_directory`. A directory operation on a
path that is not a directory gives `not_directory`. A path that does not
exist gives `not_found`. Any other case, such as `rmdir` on a folder that
holds files, gives `invalid` or `unknown`, as `BashEnv` does. The `lstat`
runs after the failed call. A change between the two can pick the wrong
code, and it changes no file.

**The `sql` export keeps its rename on one filesystem.** `WorkspaceFiles`
writes an export to a temporary file beside the target and renames it
onto the target. Many servers mount `/tmp` as a filesystem of its own, and
a rename across two filesystems fails. Log rotation also renames inside
one folder.

**`exec` checks the directory first.** `SshEnv` runs one SFTP `lstat`
of the working directory. When the directory does not exist, it returns
`spawn_error`, as `NodeExecutionEnv` does, and opens no channel.

**`exec` sends the script on standard input.** `sshd` drops an `env`
request unless `AcceptEnv` names the variable. `SshEnv` runs
`exec setsid --wait bash -s` on the channel and writes the script to its
standard input:

1. `printf 'AMBION_PGID=%s\n' "$$" >&2`, which gives the process group
   ID.
2. `cd -- '<dir>' || exit 1`, which stops the script when the directory
   went away after the check.
3. One `export NAME='value'` for each variable, with each value quoted
   for the shell.
4. The command as the body of a quoted heredoc, passed to `bash -c` with
   standard input from `/dev/null`:

   ```sh
   bash -c "$(cat <<'AMBION_7f3a9c'
   <command>
   AMBION_7f3a9c
   )" </dev/null
   ```

   The command runs as `bash -c <command>`, the same as in
   `NodeExecutionEnv`, and it reads an empty standard input. `SshEnv` picks
   a random delimiter that no line of the command equals.

**`SshEnv` removes its own lines from stderr.** It buffers stderr until
the first newline, reads the `AMBION_PGID=` line, and keeps it out of the
output view. After a group kill, `setsid` writes a line that the child did
not exit normally, and `SshEnv` removes that line too.

**No value reaches a command line.** `ps` on the server shows no variable
of one agent to another account.

## Commands and aborts

**Each command runs in its own process group.** Pi's `NodeExecutionEnv`
starts each command detached and kills the whole group with `SIGKILL`.
`setsid --wait` makes `bash` the leader of a new group and waits for it,
so the channel reports the exit status of the command. An abort opens a
second channel and sends `kill -KILL -- -<group>`. An abort that comes
before the `AMBION_PGID=` line waits for that line, which is the first
thing the script prints.

**The SSH signal request cannot do this alone.** OpenSSH 7.9 added signal
delivery to `sshd`. It sends a subset of signals, and only to a login or a
command session. A forced command gets none. The signal reaches the
session's own child, and a pipeline's other processes keep running.

**A deadline takes the same path and reports `timeout`.** `Deadline`
tells an abort apart from a timeout, and a command with no timeout gets
30 seconds. `SshEnv` supplies the group kill for both.

**`SshEnv` hands one view to `onUpdate`.** The conformance suite expects
one update for each command, the same as `BashEnv` gives. `SshEnv`
collects stdout and stderr until the command ends and builds one
`boundedView`. `spill` writes the whole output when the view cuts it.

**A process that starts its own session escapes the kill.** Its channel
stays open until it exits. When the client cannot open a channel, the
backend drops the client, and the next `connect()` builds a new one.

## Connections

**The backend keeps one SSH client for each agent.** The resource owner
calls `connect()` and `cleanup()` once for each operation
([Resources](resources.md#the-resource-contract)). A handshake on each
call adds network round trips to every tool call.

- **`connect()` returns an `SshEnv` over the cached client** of that
  agent. On the first call it builds the client, opens its SFTP channel,
  and reads the home.
- **Each command opens one `exec` channel** and closes it when the
  command ends. `cleanup()` closes any channel that the operation left
  open. The client and its SFTP channel stay open.
- **An `error` event drops the client.** The backend listens on every
  client, because an `error` event with no listener stops the Node
  process. `keepaliveInterval` turns a dead connection into that event.
  The next `connect()` builds a new client.
- **A call that loses its connection fails, and nothing retries it.** An
  append that the connection lost can have landed or not, and the caller
  cannot tell which.
- **`idleTimeout` closes an unused client.** A client that runs no
  operation for `idleTimeout` seconds closes, and the default is 300. The
  next `connect()` for that agent builds a new client. A long workspace
  run holds a client only for an agent that works.
- **`dispose()` closes every client.** The backend deletes no data on the
  server. The host removes a workspace's folders with its own tools.

**The channels stay under the server's limit.** OpenSSH allows 10 sessions
on one connection by default (`MaxSessions`). The bash owner runs one
operation at a time, so a client holds at most three channels: SFTP, one
command, and one abort.

**The bash owner serializes every agent's file and shell work.** A
workstation keeps one queue in v1, and each operation now waits on the
network. A long command from one agent delays every other agent's file
tool. A query runs on the SQL owner, so a command delays no query.

## The shared database

**The workstation adds no SQL backend.** The `sql` tool runs on
`backend.sql`, a backend kind apart from the shell
([Query the shared database](workspace.md#query-the-shared-database)). A
workspace on a workstation sets it as any workspace does.

**`sqliteBackend` is the v1 pairing.** Its database lives on the Ambion
host, beside the workstation, so no agent reaches the file through
`bash`. The workstation needs no `sqlite3` for the `sql` tool.

**An export lands on the workstation as the calling agent.** The SQL
backend streams the CSV through `WorkspaceFiles`, one operation on the
bash owner as that agent. The file lands in the agent's home, or at the
path the agent names, with that account's permissions.

**A database server waits in the backlog.** The
[backlog](../planning/backlog.md#designs-with-a-shape) entry for a SQL
backend over a database server pairs it with a workstation. That backend
connects as each agent with its own database credential, so the server
enforces the grants. `sqliteBackend` gives every agent one handle and one
set of grants.

## Guidance

**The workspace describes the tools, and the workstation describes its
shell.** The workstation's `guidance` states what every workstation has:
a real shell, open network access, and one account for each agent. The
application names the commands that its server installs.

## Trust

**`docs/trust.md` gets a new row before the backend ships.** An agent on
a workstation has a real shell and network access. The account
permissions on the server contain it. The kernel does not.

**The live exclusivity test covers the just-bash backends only.** It
shows that a seat cannot read `/etc/hosts`
([Trust](trust.md#what-each-harness-exposes)). On a workstation that
result depends on the server's permissions.

**Every agent can change the audit log.** Each agent writes its own
entries through its own account, so the group has write access to the
file. An agent can edit or remove earlier entries through `bash`. The
[backlog](../planning/backlog.md#designs-with-a-shape) decides which
identity writes the audit log.

**No agent can change the room mirror.** Only the host account writes
`layout.rooms`, and the agents read it through the group.

**No agent reads another agent's temporary files.** Each temporary file
and spill file has mode `0600`, and each temporary directory has mode
`0700`.

## Tests

**Both tiers run `workspaceConformance`.** A `ConformanceBackend` harness
opens a fresh `workstationBackend` and disposes of it. The cases check the
`ExecutionEnv` rules that the four file tools need. `startSshServer` is a
proposed test helper: the scripted tier starts an `ssh2` server, and the
integration tier starts `sshd`.

```ts
import type { ConformanceBackend } from '@ambionframework/workspace/conformance';
import { workspaceConformance } from '@ambionframework/workspace/conformance';
import { workstationBackend } from '@ambionframework/workstation';
import { describe, it } from 'vitest';
import { startSshServer } from './support/ssh.ts';

const harness: ConformanceBackend = {
  name: 'workstation',
  async open() {
    const server = await startSshServer(['surveyor', 'planner', 'lab-host']);
    const backend = workstationBackend(server.options);
    return {
      backend,
      dispose: async () => {
        await backend.dispose?.();
        await server.stop();
      },
    };
  },
};

describe(harness.name, () => {
  for (const c of workspaceConformance(harness)) it(c.name, c.run);
});
```

**The scripted tier serves a temporary directory over SFTP.** The test
starts an `ssh2` `Server` in its own process. Its SFTP handlers read and
write a temporary directory on the local disk, and each `exec` runs `bash`
in that directory. The tier needs no container and no network, and
`pnpm check` runs it. It needs `setsid` from util-linux, so it runs on
Linux and skips on a machine without `setsid`, such as macOS.

- **It tests the plain `RENAME` path.** The `ssh2` server announces no
  SFTP extension, so `SshEnv` falls back. The handler replaces an existing
  target, as `rename(2)` does.
- **It tests no permission.** Every account maps to the one user that
  runs the test.

**The integration tier runs in a CI job of its own.** Only root creates
the accounts, and only an `sshd` that runs as root logs in as more than
one user. `pnpm check` runs without root. The job runs a container image
with `sshd`, and it runs only when `AMBION_WORKSTATION_SSHD` is set. It
proves what only OpenSSH can:

- the replacing rename and the group kill
- the error classification against the status codes of OpenSSH
- the channel count under `MaxSessions`
- that one account cannot read another account's home or temporary files
- that a file one agent creates in the audit folder stays writable for
  the other agent
- that an agent cannot write under `layout.rooms`

## Out of v1

- A SQL backend over a database server, or over the server's own
  `sqlite3`.
- Credential issuance and rotation, and OpenSSH certificates.
- A workspace across two or more servers.
- A workstation under workerd.
- Concurrent operations on the bash owner. The
  [backlog](../planning/backlog.md#designs-with-a-shape) holds the backend
  profile that allows them.

Sources for the client facts: the published `ssh2` 1.17.0 and
`@microsoft/dev-tunnels-ssh` 3.12.42 packages, the
[OpenSSH 7.9 release notes](https://www.openssh.org/txt/release-7.9), and
`sftp-server.c` in OpenSSH for the status codes and the umask.
