# The workstation

**The workstation forwards endpoints through SSH.** See
[The forward](processes.md#the-forward) for the transport contract.

**`@ambionframework/workstation` implements this page.** It builds on the
workspace interface that [Workspace](workspace.md) states. The
[package guide](../packages/workstation/README.md) shows how to prepare a
server.

**A workstation is one remote server with one Unix account for each
agent.** A workspace connects to it over SSH, and each agent logs in with
its own credentials. The operating system of the server keeps one agent's
files apart from another's. The just-bash backends have no such boundary
([Workspace](workspace.md#backends-and-limits)).

## The name and the protocol

**The protocol is SSH.** The package
`@ambionframework/workstation` exports `workstationBackend(options)`. It
returns a `BashBackend`, the one backend kind that every workspace has.

```ts
import { readFile } from 'node:fs/promises';
import { openWorkspace } from '@ambionframework/workspace';
import { sqliteBackend } from '@ambionframework/workspace/sqlite';
import { workstationBackend } from '@ambionframework/workstation';

const lab = openWorkspace({
  name: 'lab',
  backend: {
    bash: workstationBackend({
      server: 'lab.internal',
      hostKey: 'SHA256:<the fingerprint that ssh-keygen -lf prints>',
      layout: {
        audit: '/srv/ambion/lab/audit/audit.jsonl',
        rooms: '/srv/ambion/lab/rooms',
        snapshots: '/srv/ambion/lab/snapshots',
      },
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
private key from a file on the Ambion host. `lab.mirrorAgent.name` is `lab-host`, so
the server has an account and a key of that name too.

**The package reaches the workspace through its root entry.** That entry
holds the interface and the environment helpers, and it loads no just-bash
and no `node:sqlite`. The workstation does not depend on
`@ambionframework/just-bash`, so it installs no just-bash. The tests also import
`@ambionframework/workspace/conformance`.

## What the backend supplies

**A `BashBackend` supplies a transport and the facts of its server.** The
workspace supplies everything that holds on every backend
([Build a bash backend](workspace.md#build-a-bash-backend)).

**The workstation adds no tools.** The file tools and the process tools cover
every file and shell operation on a server.

## The SSH client

**`ssh2` carries the protocol.** It runs SFTP and `exec` over one
connection. It also ships an SSH server, which the scripted tests use.

**The optional native build stays off.** The `ssh2` install script runs
`node-gyp` for a crypto binding, and `cpu-features` is optional too. The
workspace skips dependency build scripts, so `ssh2` runs its JavaScript
ciphers. The ciphers run slower, and nothing else changes.

**`ssh2` is a CommonJS package with no `exports` map.** The backend
imports its default export. The types come from `@types/ssh2`.

**The package runs on Node only.** `ssh2` opens its socket through
`node:net`, so a bundle for workerd cannot hold it. The Cloudflare
adapter gets no workstation.

## Credentials

**The host owns the key of each account on the server.** The workspace
states the rule for every backend: the host owns credentials for external
services. The bash backend takes one resolver and holds no credential of
its own.

**The git backend owns the git key of each agent.**
[Workstation git](workstation-git.md#keys) states how it issues and
rotates the key.

```ts
import type { WorkspaceLayout } from '@ambionframework/workspace';
import type { WorkspaceAgent } from '@ambionframework/workspace/resource';

interface WorkstationCredential {
  readonly username: string;
  readonly privateKey: string;
  readonly passphrase?: string;
}

interface WorkstationOptions {
  readonly server: string;
  readonly port?: number;
  /** The server's host key fingerprint, as `ssh-keygen -lf` prints it. */
  readonly hostKey: string;
  readonly layout: WorkspaceLayout;
  /** Seconds a client may stay unused before the backend closes it. The default is 300. */
  readonly idleTimeout?: number;
  credentialFor(agent: WorkspaceAgent): WorkstationCredential | Promise<WorkstationCredential>;
}
```

**The resolver answers for every agent and for `workspace.mirrorAgent`.** A
`WorkspaceAgent` holds `name` alone. `openWorkspace` builds the host
agent `<name>-host`, and `mirror()` writes as it
([The layout and the host identity](workspace.md#the-layout-and-the-host-identity)).
The host gives it an account and a key, the same as an agent.

**The host provisions each account and each key before the first
connection.** The resolver reads them from the store the application
already uses: a secrets manager, an environment variable, or a file. The
bash backend awaits the resolver each time it builds a client for an
agent. It stores, issues, and rotates no account key.

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
and agent. The package has neither.

**The account's home is the working directory.** The just-bash backends
make `/home/<name>` on the first connection. A workstation account has a
home from the server's own user management. The SFTP server starts in that
home, so the backend reads it once for each client with `realpath('.')`.
`resolvePath` resolves `~` and a relative path against that home.

**The server runs bash and util-linux.** `SshEnv` runs each command
through `bash`, whatever the login shell of the account is. It also needs
a `setsid` that has the `--wait` option. A new run of the host adopts a
live process through the `ps` of procps
([Processes](processes.md#backends)). Each account needs a login shell
that runs a command, so `nologin` does not serve.

**The server permits local forwards to its loopback.** `endpoints.forward()`
opens a forwarded channel to `127.0.0.1` on the server. The configuration
of `sshd` for each account sets `AllowTcpForwarding local` and
`PermitOpen 127.0.0.1:*`. The backend reports an error when `sshd` refuses
a forward.

## The layout on a server

**`layout` names one file and two folders.** `layout.audit` is the path of
the audit log. `layout.rooms` is the folder that `mirror()` writes each
room's record under. `layout.snapshots` is the folder of the default
object store, one file for each digest, when the workspace names no
`backend.objects`. Different accounts write these paths, so they need
different permissions.

| Path                  | Writer                                                 | Mode on the server                                |
| --------------------- | ------------------------------------------------------ | ------------------------------------------------- |
| The folder of `audit` | Every agent: each tool call writes its entry as itself | Group write, setgid, and a default ACL of `g::rw` |
| `rooms`               | The host account alone                                 | Owner write, group read                           |
| `snapshots`           | The host account alone                                 | Owner write, group read                           |
| Each agent's home     | That agent alone                                       | `0700`                                            |

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

## The environment

**`SshEnv` implements the transport of the `WorkspaceEnv` port.** A file call
goes over SFTP. Each `exec` opens one channel on the SSH client. The root
entry's helpers supply the rest:

- `HomeEnv` for the file methods: `SshEnv` supplies the SFTP operations and
  the error classifier, and overrides `renameFile` to classify an `invalid`
  error against the destination
- `resolvePath` for `~` and a relative path
- `Deadline`, which tells an abort apart from a timeout
- `boundedView` for the output view

**One `lstat` classifies a coarse status by the operation.** A file
operation on a directory gives `is_directory`. A directory operation on a
path that is not a directory gives `not_directory`. A path that does not
exist gives `not_found`. Any other case, such as `rmdir` on a folder that
holds files, gives `invalid` or `unknown`, as the just-bash backends do. The `lstat`
runs after the failed call. A change between the two can pick the wrong
code, and it changes no file.

**The `sql` export keeps its rename on one filesystem.** `WorkspaceFiles`
writes an export to a temporary file beside the target and renames it
onto the target. Many servers mount `/tmp` as a filesystem of its own, and
a rename across two filesystems fails. Log rotation also renames inside
one folder.

**`exec` checks the directory first.** `SshEnv` runs one SFTP `stat` of
the working directory, which follows a symbolic link. When the directory
does not exist, it returns `spawn_error` and opens no channel.

**No value reaches a command line.** `ps` on the server shows no variable
of one agent to another account.

## Commands and aborts

**Each command runs in its own process group.** `setsid --wait` makes `bash` the leader of a new group and waits for it,
so the channel reports the exit status of the command.

**The command is a script on the standard input of `bash -s`.** The script
prints the `AMBION_PGID=` line first, and an abort that comes before that
line waits for it. The script then changes to the directory and writes one
`export` line for each variable, because `sshd` drops an `env` request
unless `AcceptEnv` names the variable. The command runs as `bash -c`, with
an empty standard input. Its stderr joins its stdout, so the output keeps
the order in which the command wrote it.

**A login shell can write lines before the script.** `sshd` runs the
command through the account's login shell, so the output of `~/.bashrc`
can show in the view. It does not stop an abort, which looks for the
`AMBION_PGID=` line among the others.

**An abort stops the group with `SIGTERM`, a grace, and `SIGKILL`.** The
`grace` field of `WorkspaceExecOptions` gives the seconds between the two
signals. Each signal opens a short channel that runs
`kill -<signal> -- -<group>`, in the queue of the client's signals.

| `grace`            | What an abort sends                                                       |
| ------------------ | ------------------------------------------------------------------------- |
| Absent, or 0       | `SIGKILL` at once                                                         |
| 1 or more          | `SIGTERM`, then `SIGKILL` after `grace` seconds if the command still runs |
| Not 0 to 2,147,483 | No command: `exec` fails with `spawn_error`                               |

**The host holds the timer of the grace.** No channel stays open while
the grace runs. The `SIGKILL` after the grace goes only to a group whose
command has not exited. After the exit, the group can be empty, and the
system can give its ID to another program. A child that the command left
in the group keeps running, as after a natural exit. The first signal
goes to the group also after the exit. A deadline that comes while a
child holds the output open sends that child the first signal. With a
grace, that signal is `SIGTERM`, so a child that ignores `TERM` keeps
running until the channel closes. A host that stops during the grace
sends no `SIGKILL`.

**A command that ends inside the grace gives its own exit status.** The
channel reports it, and `exec` still returns the abort as `aborted` or
`timeout`. The process table reads the code from the `exit` file
([Processes](processes.md#the-cancel)). The command's channel closes 2
seconds after the time of the `SIGKILL` at the latest. The times of the
signals count from the `AMBION_PGID=` line. Until that line comes, the
channel closes after the grace and 2 seconds.

**A deadline takes the same path and reports `timeout`.** `Deadline`
tells an abort apart from a timeout, and a command with no timeout gets
30 seconds. `SshEnv` supplies the same signals and the same grace for
both.

**The Ambion host holds a bounded window of the output.** A command can
write gigabytes, and every agent's workspace runs in the host's process.
`SshEnv` keeps twice `maxBytes` on the side the view retains, and counts
the bytes and lines of the whole output.
With no `maxBytes`, the window is 8 MiB.

**A child that keeps the output open does not hold the result.** The
server sends the exit status when the command exits, and the output it
still holds after it. `SshEnv` closes the channel 1 second after the last
output, and 5 seconds after the exit status at most.

**A command that exits before its deadline gives its exit status.** A
background child that keeps writing after the command exits holds the
channel until the 5 seconds end or the deadline fires. Either way, the
result is the command's exit status. When the 5 seconds close the channel
while output still arrives, the view ends with a line that says so. Over
a slow link, that line also marks output of the command itself that the
channel still held.

**A process that starts its own session escapes the kill.** After the
`SIGKILL`, its channel closes 2 seconds later. When the client cannot open
a channel, the backend drops the client, and the next `connect()` builds a
new one.

## Connections

**The backend keeps one SSH client for each agent.** The resource calls
`connect()` and `cleanup()` once for each operation
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
- **A call that loses its connection fails when the client sees the end,
  and nothing retries it.** `ssh2` fails the SFTP requests in flight when
  the channel closes, and keeps a request made after that pending forever.
  So every call races the end of its client. A connection that dies with
  no sign ends after three keepalives with no answer, about 45 seconds. A
  file call answers `unknown`, and a command answers `ShellError`
  `unknown` with no exit code. An append that the connection lost can have
  landed or not, and the caller cannot tell which.
- **`idleTimeout` closes an unused client.** A client with no open
  environment or endpoint for `idleTimeout` seconds closes. The
  default is 300. A background process holds an environment of its own for
  its whole run ([Processes](processes.md#backends)). An open endpoint
  holds a client until its caller closes the endpoint. The timer starts
  when the last lease ends. The next `connect()` for that agent builds a
  new client. A long workspace run holds a client only for an agent that works.
- **`dispose()` closes every client and port listener.** The backend deletes
  no data on the server. The host removes a workspace's folders with its own
  tools.

**A client opens one signal channel at a time.** `Session` holds one FIFO
queue of signals for each client. A `SIGTERM` or a `SIGKILL` of any
command waits for the earlier signal channel of the same client to close,
and then opens. The `SIGKILL` timer starts when the `SIGTERM` joins the queue, so a
delay in the queue shortens the time between the two signals by that
delay. An entry ends when its channel closes, when the session ends,
or after 5 seconds, so a channel that never closes does not hold the
queue. When the session ends, every waiting entry ends with it, and no signal
opens on a closed client.

**The channels stay under the server's limit.** OpenSSH allows 10 sessions
on one connection by default (`MaxSessions`). The count below holds at the
same time on one client of one agent. It does not assume a drained bash
resource, so it covers `dispose()` and a live cancel or timeout alike.

| Holder                                                                                                                             | Channels |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------- |
| The SFTP channel                                                                                                                   | 1        |
| The bash resource: one operation, one `exec`                                                                                       | 1        |
| The processes: a command channel for each process of this run, and one poll read for each adopted process, with 4 processes in all | up to 4  |
| One signal channel, for every abort and every cancel of the client                                                                 | 1        |
| One `exec` of the table on a cancel step: `writeStop`, or the signal script of an adopted cancel                                   | 1        |
| The total                                                                                                                          | 8        |

**The process table allows 4 running processes.** A process of this run
holds one command channel. An adopted process holds none, because its
shell ran on an earlier client, and a poll read of the files holds one
channel at a time for it. A process of this run or an adopted one counts
as one of the 4, so the commands and the polls together stay at 4. The
final read of a process of this run (`settleOwned`, `finalStatus`,
`readFiles`: one listing `exec`) runs after its command channel closed,
and takes the place of that channel. The cancels of one agent take their
steps one at a time, so the table holds one `exec` on a cancel step. The
resource's own abort signal uses the one signal channel. The worst case is
8 channels, 2 below the limit of 10. The count of one signal channel
assumes that a kill channel closes within 5 seconds, the time after which
the queue releases an entry.

**The bash resource serializes every agent's file work and the start of each
process.** A workstation keeps one queue, and each operation waits
on the network. A `bash` process runs off the bash resource, so a long command
delays no file tool of another agent ([Processes](processes.md#a-process)). A
query runs on the SQL resource, so a command delays no query.

## The shared database

**The workstation adds no SQL backend.** The `sql` tool runs on
`backend.sql`, a backend kind apart from the bash backend
([Query the shared database](sql.md#query-the-shared-database)). A
workspace on a workstation sets it as any workspace does.

**`sqliteBackend` is the pairing.** Its database lives on the Ambion
host, beside the workstation, so no agent reaches the file through
`bash`. The workstation needs no `sqlite3` for the `sql` tool.

**An export lands on the workstation as the calling agent.** The SQL
backend streams the CSV through `WorkspaceFiles`, one operation on the
bash resource as that agent. The file lands in the agent's home, or at the
path the agent names, with that account's permissions.

**An import reads the workstation as the calling agent.** `WorkspaceFiles`
reads the CSV file over SFTP as that account. An agent imports only a file
that its account reads.

## A git backend

**`workstationGitBackend` keeps the repositories of the workspace on the
server.** One more account, such as `lab-git`, owns every repository, and
the host reaches it with its own key. The bash backend takes the backend in
its `git` option, which has the type `WorkstationGitBackend`.
[Workstation git](workstation-git.md) states the account, the keys, and the
files that the bash backend writes into the agent's `~/.ssh` at each
`connect`.

## Guidance

**The workspace describes the tools, and the workstation describes its
shell.** The workstation's `guidance` states what every workstation has:
a real shell, open network access, and one account for each agent. The
application names the commands that its server installs. Guidance names
no hostname and no port, because the seat is logged in already.

## Trust

**A process that serves HTTP runs supplied server code.** The deployment
trusts that workstation and code. The device access of the process follows
the process account, and a read-only HTTP API does not restrict its shell.
Any agent of the workspace can read any running process with GET, because
the loopback network of a workstation is shared.

**The live exclusivity test covers the just-bash backends only.** It
shows that a seat cannot read `/etc/hosts`
([Trust](trust.md#what-each-harness-exposes)). On a workstation that
result depends on the server's permissions.

**Every agent can change the audit log.** Each agent writes its own
entries through its own account, so the group has write access to the
file. An agent can edit or remove earlier entries through `bash`.

**No agent can change the room mirror or a snapshot copy.** Only the host
account writes `layout.rooms` and `layout.snapshots`, and the agents read
them through the group. A snapshot reads each file as the agent that asks,
so the host account never reads a home.
