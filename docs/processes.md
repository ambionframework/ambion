# Processes

**This page is a draft for review.** It states the contract for background
processes in a workspace. Part of it is on this branch, and part of it
waits for review before the code starts.

| Part                                                  | State                              |
| ----------------------------------------------------- | ---------------------------------- |
| `bash` starts a background process and gives a handle | On this branch, under the word job |
| `status`, `wait`, and `cancel` take a handle          | On this branch                     |
| The output file, the limits, and disposal             | On this branch, under `~/.jobs`    |
| The word process, `~/.processes`, and `name`          | Pending review                     |
| `ps`: the running processes of one agent or of all    | Pending review                     |
| `workspace.processes`: the host's view of processes   | Pending review                     |
| A reminder of processes at the start of an activation | Pending review, one core change    |

[For review](#for-review) lists the decisions that this page takes and
that the review must confirm.

**`bash` starts every command as a background process.** The call gives a
handle for the process. `status`, `wait`, and `cancel` take that handle,
and `ps` lists the processes. The whole output of a process goes to a
file in the agent's home. Every workspace has these five tools, on every
bash backend.

**A process runs until it ends, times out, or gets a cancel.** An
activation, an exchange, and a room do not stop a process. The host sees
every process through `workspace.processes`, and it can show them to a
person ([The host's view](#the-hosts-view)).

**`@ambionframework/workspace` implements this page.** The process table
is `packages/workspace/src/jobs.ts`, and the tools are
`packages/workspace/src/job-tools.ts`. The journal holds no entry for a
process. [Workspace](workspace.md) states the owner and the backends that
a process runs on.

## Words

| Word        | Meaning                                                                                |
| ----------- | -------------------------------------------------------------------------------------- |
| process     | One background command that the workspace runs for one agent. It replaces the word job |
| handle      | The key of one process: `<kind>-<12 hex digits>`, such as `bash-3f9a2c1d0b7e`          |
| name        | A label that the agent gives a process, such as `tests`                                |
| owner agent | The agent whose call started the process                                               |
| output file | `~/.processes/<handle>.out` in the owner agent's home                                  |
| kind        | What started the process. `bash` is the one kind today                                 |

**A process is an entry in the process table of the workspace.** On the
workstation, it holds one process group on the server. On just-bash, it
holds one command that runs in the host's process.

## The tools

| Tool     | Parameters                              | What it does                                                         |
| -------- | --------------------------------------- | -------------------------------------------------------------------- |
| `bash`   | `command`, `name?`, `timeout?`, `wait?` | Starts a process, waits up to `wait` seconds, and gives its state    |
| `ps`     | `agent?`, `all?`                        | Lists the running processes of the caller, of one agent, or of all   |
| `status` | `handle`                                | Gives the state of the process and the end of its output             |
| `wait`   | `handle`, `timeout?`                    | Waits up to `timeout` seconds for the process to end, then as status |
| `cancel` | `handle`                                | Stops a running process, waits for it to end, then as status         |

| Value                | Default | Range                         |
| -------------------- | ------- | ----------------------------- |
| `bash` `timeout`     | 600 s   | Above 0, up to 2,147,483 s    |
| `bash` `wait`        | 10 s    | 0 to 600 s. 0 returns at once |
| `wait` `timeout`     | 30 s    | 0 to 600 s                    |
| The wait of `cancel` | 10 s    | Fixed                         |

**`bash` with `wait` is `bash` with a `wait` of 0 and then the `wait`
tool.** A command that ends inside the window gives its output and its
exit code in one call. The agent needs a second call only for a command
that runs longer. A value outside its range makes the call fail with
`Invalid`.

**`name` is a label that the agent chooses.** A name is 1 to 40
characters: lowercase letters, digits, `.`, `_`, and `-`. The result line,
`ps`, the reminder, and the host's view show it beside the handle. The
handle stays the key: `status`, `wait`, and `cancel` take the handle
alone. Two processes can have the same name.

## The result

**Each result of `bash`, `status`, `wait`, and `cancel` is the end of the
output, then one bracketed line.** The line states the process, its
handle, its name when it has one, and its output file. A process that
ended with no output shows `(no output)`.

```text
/home/writer
slab pour Thu

[Process bash-a68e2a3f5863 exited with code 0. Output: /home/writer/.processes/bash-a68e2a3f5863.out.]
```

```text
compiling 14 of 120

[Process bash-3f9a2c1d0b7e (tests) is running. Output: /home/writer/.processes/bash-3f9a2c1d0b7e.out. Call status, wait or cancel with its handle.]
```

| State       | The bracketed line, where `<h>` is the handle and the name |
| ----------- | ---------------------------------------------------------- |
| `running`   | `Process <h> is running. ... Call status, wait or ...`     |
| `exited`    | `Process <h> exited with code <n>.`                        |
| `timed_out` | `Process <h> timed out after <timeout> seconds.`           |
| `cancelled` | `Process <h> is cancelled.`                                |
| `failed`    | `Process <h> failed: <message>.`                           |

**The view keeps the last 2000 lines or 50 KB.** These are the limits of
Pi's `bash` tool. When the view cuts the output, the bracketed line adds
`The text above is the last <n> lines, <size> of <total>.` The agent reads
the rest from the output file with `read`, which takes an offset and a
limit.

**`details.process` is a `ProcessStatus`.** The host's view gives the
same value.

| Field       | Holds                                                        |
| ----------- | ------------------------------------------------------------ |
| `handle`    | The key of the process                                       |
| `name`      | The label, when the agent gave one                           |
| `kind`      | `bash`                                                       |
| `agent`     | The owner agent                                              |
| `command`   | The command as the agent gave it                             |
| `state`     | `running`, `exited`, `timed_out`, `cancelled`, or `failed`   |
| `output`    | The absolute path of the output file                         |
| `timeout`   | Seconds the process may run                                  |
| `room`      | The room of the `bash` call, when it had one. Metadata alone |
| `startedAt` | ISO time of the start                                        |
| `endedAt`   | ISO time of the end, when the state is final                 |
| `exitCode`  | Set when the state is `exited`                               |
| `error`     | Set when the state is `failed`                               |

**A `bash` call fails when its process ends inside the window with a
failure.** The failures are an exit code other than 0, a timeout, and a
fault of the backend. These are the cases in which Pi's `bash` tool fails.
The error text is the result text, so it names the handle. `ps`,
`status`, `wait`, and `cancel` give every state as a result. They fail
only on an unknown handle or an invalid value.

## A process

**A process runs on an environment of its own.** The process table
connects it through the bash backend, outside the queue of the bash owner.
A long process holds no tool call of any agent. The environment is
cleaned up when the process ends.

**`bash` starts its process as one operation on the bash owner.** The
start comes after every earlier operation on the owner, so a `write` and
then a `bash` that reads the file stay in order. The start creates
`~/.processes` and an empty output file, and then connects the process's
environment.

**After the start, the backend's filesystem orders a process against
other work.** A process and a later `write` of the same agent can
interleave. The owner gives no order between them.

**The command runs as a group with its input and output redirected.**

```sh
{
<command>
} < /dev/null > '<home>/.processes/<handle>.out' 2>&1
```

The command stands on lines of its own, so a comment or a here-document
at its end does not reach the brace. Standard input is empty. The shell
can write before the redirect applies, for example on a syntax error. The
process table adds that output to the end of the file, up to 16 KB.

**Each tool reads the end of the output file as one more operation on the
bash owner.** No tool holds the owner while it waits for a process. A
file up to 200 KB is read whole. A larger file is read with `tail -c`, so
a large output does not reach the host whole.

**The state of a process comes from the backend's result.**

| Result of `exec`            | State       |
| --------------------------- | ----------- |
| An exit code                | `exited`    |
| The error code `timeout`    | `timed_out` |
| The error code `aborted`    | `cancelled` |
| Any other error, or a throw | `failed`    |

## Handles and limits

**A handle is `<kind>-<12 hex digits>`.** An example is
`bash-3f9a2c1d0b7e`. The output file has the handle as its name.

**`status`, `wait`, and `cancel` take a handle of the calling agent
alone.** A call with the handle of another agent fails with
`You have no process <handle>.` On the workstation, the output file is in
the owner agent's account, and another account cannot read it.

**The process table keeps its state in the host's memory, for the life of
the workspace.** A restart of the host loses the table and every handle.
The output files stay on the filesystem.

**The table bounds the processes of each agent.**

- **4 running processes.** A `bash` call past that fails, and tells the
  agent to wait for a process or to cancel one. On the workstation, each
  running process holds one channel of the agent's SSH client, and
  OpenSSH allows 10 channels on one client by default
  ([Workstation](workstation.md#the-ssh-client)).
- **64 finished processes.** A new process makes the table forget the
  oldest finished process past that number. The table removes the
  output file of that process in the same operation.

**The table stops the processes of one agent one at a time.** A stop on
the workstation opens a channel of its own for the kill. A stop waits for
the stops of the same agent before it, so the stops of one agent hold at
most one kill channel. A cancel, a timeout, and `dispose()` all stop a
process this way ([For review](#for-review), item 2).

## ps

**`ps` lists running processes from the process table.** It reads no
output file and runs no command. It answers for every backend in the same
way.

| Parameters        | What `ps` lists                             |
| ----------------- | ------------------------------------------- |
| None              | The running processes of the calling agent  |
| `agent: '<name>'` | The running processes of the agent `<name>` |
| `all: true`       | The running processes of every agent        |
| `agent` and `all` | Nothing: the call fails with `Invalid`      |

**Each line states one process, in the order the processes started.** The
command shows its first line, cut to 80 characters. A process with no
name has an empty name cell.

```text
| Handle            | Name       | Agent  | Runs for | Command            |
| ----------------- | ---------- | ------ | -------- | ------------------ |
| bash-3f9a2c1d0b7e | tests      | writer | 2m 14s   | npm test           |
| bash-9c01d4e2aa31 | server-log | writer | 12s      | tail -f server.log |

2 running processes.
```

**A call with no running process to list gives one line.** It is
`No running processes.`, or `<name> has no running processes.`

**Another agent's line gives the handle, the name, the agent, and the run
time.** Its command cell is empty, since a command line can hold a token.
The output of the process stays with the owner agent: `status`, `wait`,
and `cancel` take the caller's own handles
([For review](#for-review), item 4).

**`ps` lists running processes alone.** A finished process stays in the
table ([Handles and limits](#handles-and-limits)), and `status` reaches it
by its handle.

## The host's view

**`workspace.processes` gives the host every process of the workspace.**
A host uses it to show a person what runs, and to stop a process that an
agent left running. It reads the process table. It adds no tool.

```ts
export interface WorkspaceProcesses {
  /** The processes in the table, in the order they started. */
  list(query?: { agent?: string; running?: boolean }): readonly ProcessStatus[];
  /** Call `listener` when a process starts and when it ends. Returns the unsubscribe. */
  subscribe(listener: (event: ProcessEvent) => void): () => void;
  /** Stop the process `handle` of any agent, and give its final status. */
  cancel(handle: string): Promise<ProcessStatus>;
}

export type ProcessEvent =
  | { readonly type: 'started'; readonly process: ProcessStatus }
  | { readonly type: 'ended'; readonly process: ProcessStatus };
```

**`list` gives frozen values.** `running: true` gives the running
processes alone. `agent` gives the processes of one owner agent.

**`subscribe` gives one event when a process starts and one when it
ends.** A host keeps its view current from the events, with no poll. A
listener that throws does not stop the other listeners or the process.
The events belong to the current run of the host.

**The host reads the output of a process through `workspace.use`, as the
owner agent.** `ProcessStatus.output` gives the path. The host needs no
second read path.

```ts
const view = site.processes.list({ running: true });
const unsubscribe = site.processes.subscribe((event) => render(event.process));
const tail = await site.use({ name: view[0].agent }, (env) =>
  env.readTextFile(view[0].output, BACKGROUND_CONTEXT),
);
```

## Reminders

**Each activation of a seat starts with a list of its processes.** A seat
can lose a handle. A new activation, a compaction of its session, or a
harness with no session all start with no memory of an earlier `bash`
call. The reminder gives the handles back.

**The reminder names two sets of the seat's processes.**

- Every running process of the agent, in every room of the workspace.
- The finished processes of the agent that no result or reminder showed
  yet: the newest 10, then `and <n> more`.

```text
Your background processes in the workspace:
- tests, bash-3f9a2c1d0b7e, is running for 2m 14s: npm test
- server-log, bash-5e7b20c4f1d9, is running for 40s in the room review: tail -f server.log
- bash-9c01d4e2aa31 exited with code 1 at 14:02:11: make build
Call status, wait or cancel with a handle. Call ps to list processes.
```

**Each line starts with the name when the process has one.** The handle
follows it. A process from another room names that room.

**A seat with no process to name gets no reminder.** A summarize
activation gets no reminder either: it has no workspace tools.

**The reminder needs one change in the core.** A bundle gives text for
each activation, and the room renders it.

- `ToolBundle` gets an optional `remind` function.
- `describeExecutor` collects the `remind` of each bundle into a new
  `AgentExecutor` field, `reminders`, beside `tools` and `guidance`.
- `renderActivation` calls each reminder for a respond activation, and
  adds the text to the turn context. Pi, Claude, and Codex render through
  it, so each executor that renders gets the reminder.

```ts
export interface ToolBundle {
  readonly tools: readonly AmbionTool[];
  readonly guidance?: string;
  /** Text for one activation of one seat, or undefined for none. */
  readonly remind?: (seat: {
    readonly agent: string;
    readonly room: string;
    readonly activation: string;
  }) => string | undefined;
}
```

**`remind` gives the same text for the same activation.** Pi and Claude
render one activation twice: once for the agent part, and once for the
context that the model reads. The process table marks the finished
processes as shown on the first call for an activation, and keeps that
text for the activation. A second call for the same activation gives the
same text.

**`remind` is synchronous, and a throw gives no reminder.** The process
table is in the host's memory, so the workspace answers with no I/O. The
core catches a throw, and the activation continues with no reminder.

**The reminder goes in the turn context.** The turn context already
changes on each activation, for example with its clock line. A provider's
cache of the agent part stays valid.

**The reminder shows at the start of the activation alone.** A later pass
of the same activation adds no reminder. Every result of a process tool
states the process, and `ps` gives the whole list.

## Life and disposal

**A process outlives the call, the activation, and the exchange that
started it.** An abort of the `bash` call stops the call's wait. The
process keeps running until it ends, it times out, the owner agent or the
host cancels it, or the workspace disposes.

**`wait` gives the state when the process ends or when the time ends.** A
process that is still running gives `running`. An abort of the call stops
the wait, and the process keeps running.

**`cancel` aborts the process and waits up to 10 seconds for it to end.**
The backend's abort path stops the command, and the state becomes
`cancelled`. A `cancel` of a process in a final state gives that state
again.

**`dispose()` stops every process before the bash backend releases its
handles.** The bash owner refuses new work and drains its queue. The
process table then refuses new processes, stops every running process,
and waits for each one to end. The bash backend then disposes. The git
owner disposes after the bash owner, so a push in a process still
reaches the git backend.

## Backends

| Backend              | While the process runs                          | Cancel and timeout                                                     |
| -------------------- | ----------------------------------------------- | ---------------------------------------------------------------------- |
| `memoryBackend`      | The file stays empty until the process ends     | The process ends, and its file stays empty                             |
| `directoryBackend`   | The file stays empty until the process ends     | The process ends, and its file stays empty                             |
| `workstationBackend` | The output reaches the file as the command runs | The process group gets `SIGKILL`, and the file keeps the output so far |

**just-bash writes a redirect when the group ends.** Its commands run in
the host's process, so `status` on a running process there shows no
output yet.

**A workstation process holds an environment over the agent's SSH
session.** The session stays open while any environment is open over it.
The idle timeout starts when the last one is cleaned up
([Workstation](workstation.md#the-ssh-client)).

## The audit log

**Each call of the five tools has one audit entry.** The entry runs on
the bash owner after the call ends. The entry of a `bash` call holds the
state at the end of the call, which can be `running`. The end of a
process has no entry of its own, and a cancel by the host has none. The
output file is the record.

## The guidance

**`openWorkspace` adds one note about the process tools after the tool
line.**

```text
bash starts each command as a background process and returns its handle, such as bash-1a2b3c4d5e6f.
Give a long-running process a name, such as tests or dev-server, so you can tell your processes apart.
The call waits up to wait seconds, 10 by default, and then gives the state of the process and the end of its output.
The whole output of a process goes to ~/.processes/<handle>.out. Read it with read.
status, wait and cancel take a handle. status gives the state of the process, wait waits for it to end,
and cancel stops it. ps lists running processes: yours, one agent's, or every agent's.
A process keeps running after your activation ends. It stops after timeout seconds, 600 by default.
```

## Out of scope

**A process has no link to the life of an activation, an exchange, or a
room.** A cancel at the close of an exchange needs more design: an
exchange closes when no activation is live, so such a rule stops a
process at the first quiet moment. [Backlog](../planning/backlog.md#designs-with-a-shape)
holds the linked lives, the kinds of process after `bash`, and the notice
at the end of a process.

**A new kind adds three parts.** It adds a name to `ProcessKind`, a
runner that gives a final state, and a tool that starts it. The process
table, the handle format, the output file, `ps`, the host's view, the
reminder, and the three handle tools stay as they are.

## For review

**Each decision below has a recommendation.** The code starts when the
review confirms it or changes it.

1. **The word process replaces job.** The code renames `JobStatus` to
   `ProcessStatus`, `details.job` to `details.process`, and `~/.jobs` to
   `~/.processes`, in one commit with no alias. _Recommendation:_ rename.
2. **A timeout kill can go past the SSH channel limit today.** The
   workstation kills a process at its timeout through a channel of its
   own, outside the table's stops. Four processes that time out together
   need 11 channels, and OpenSSH allows 10. A kill whose channel fails
   leaves the group running on the server. _Recommendation:_ the table
   holds the timer, and a timeout stops the process through the same
   stops as a cancel, with the state `timed_out`. The alternative is a
   limit of 3 running processes.
3. **The default timeout stays at 600 seconds.** A dev server needs a
   longer one, and the agent sets it. A process with no timeout outlives
   a crash of the host on the workstation with no bound (item 7).
   _Recommendation:_ keep 600, and let the agent raise it.
4. **`ps` shows every agent's command text.** Command lines can hold
   tokens. The server's own `ps` shows them on the workstation, and on
   just-bash this is new. _Recommendation:_ another agent's line gives
   the handle, the name, the agent, and the run time. The command text
   shows for the caller's own processes. The host's view shows all.
5. **The reminder needs `remind` in the core.** The alternatives change
   nothing in the core, and each misses the start of an activation. A
   footer on each tool result reaches the seat only after its first call.
   A guidance line that tells the seat to call `ps` first costs one call
   in each activation. _Recommendation:_ add `remind` as stated.
6. **The host's view is `list`, `subscribe`, and `cancel`.** It adds no
   read of the output: the host uses `workspace.use` as the owner agent.
   _Recommendation:_ as stated. A helper that reads the end of the output
   can come when a host needs it.
7. **A crash of the host leaves a workstation process on the server.**
   The host holds the timeout, and a dead host kills nothing.
   _Recommendation:_ a later change wraps the command in
   `timeout --kill-after` on the server.
8. **Output files outlive a restart of the host.** The table forgets
   them, and nothing removes them. _Recommendation:_ the host owns the
   cleanup of `~/.processes` across restarts, and this page says so.
9. **A name is a label, and the handle stays the key.** _Recommendation:_
   no rule for two processes with one name. Accept a name in place of a
   handle later, if seats pass names to the handle tools.
10. **`ps` writes an audit entry, as every tool call does.** The entry
    costs one file write on the bash owner for a read of memory.
    _Recommendation:_ keep the entry, since the audit log records every
    tool call.
