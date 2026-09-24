# Processes

**This page is a draft for review.** It states the contract for background
processes in a workspace. Part of it is on this branch, and part of it
waits for review before the code starts.

| Part                                                       | State                              |
| ---------------------------------------------------------- | ---------------------------------- |
| `bash` starts a background process and gives a handle      | On this branch, under the word job |
| `status`, `wait`, and `cancel` take a handle               | On this branch                     |
| The output file, the limits, and disposal                  | On this branch, under `~/.jobs`    |
| The word process, and `~/.processes`                       | Pending review                     |
| `ps`: the running processes of one agent or of all         | Pending review                     |
| A reminder of running processes in each activation         | Pending review, one core change    |
| A cancel of every running process when its exchange closes | Pending review                     |

[For review](#for-review) lists the decisions that this page takes and
that the review must confirm.

**`bash` starts every command as a background process.** The call gives a
handle for the process. `status`, `wait`, and `cancel` take that handle,
and `ps` lists the processes. The whole output of a process goes to a
file in the agent's home. Every workspace has these five tools, on every
bash backend.

**`@ambionframework/workspace` implements this page.** The process table
is `packages/workspace/src/jobs.ts`, and the tools are
`packages/workspace/src/job-tools.ts`. The journal holds no entry for a
process. The room gives the workspace two facts: the room and the
exchange of each tool call, and the close of an exchange.
[Workspace](workspace.md) states the owner and the backends that a process
runs on.

## Words

| Word        | Meaning                                                                                |
| ----------- | -------------------------------------------------------------------------------------- |
| process     | One background command that the workspace runs for one agent. It replaces the word job |
| handle      | The name of one process: `<kind>-<12 hex digits>`, such as `bash-3f9a2c1d0b7e`         |
| owner agent | The agent whose call started the process                                               |
| output file | `~/.processes/<handle>.out` in the owner agent's home                                  |
| kind        | What started the process. `bash` is the one kind today                                 |

**A process is workspace state.** A process is not an operating-system
process. On the workstation it holds one, on the server. On just-bash it
holds a command that runs in the host's process.

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

**`name` gives a process a short name that the agent chooses.** A name is
1 to 40 characters: lowercase letters, digits, `.`, `_`, and `-`, such as
`tests` or `dev-server`. The result line, `ps`, and the reminder show it
beside the handle. A name is a label: the handle stays the key of the
process, and `status`, `wait`, and `cancel` take the handle alone. Two
processes can have the same name. A process with no name shows its
command in the places that show a name.

**`bash` with `wait` is `bash` with a `wait` of 0 and then the `wait`
tool.** A command that ends inside the window gives its output and its
exit code in one call. The agent needs a second call only for a command
that runs longer. A value outside its range makes the call fail with
`Invalid`.

## The result

**Each result of `bash`, `status`, `wait`, and `cancel` is the end of the
output, then one bracketed line.** The line states the process, its
handle, and its output file. A process that ended with no output shows
`(no output)`.

```text
/home/writer
slab pour Thu

[Process bash-a68e2a3f5863 exited with code 0. Output: /home/writer/.processes/bash-a68e2a3f5863.out.]
```

```text
compiling 14 of 120

[Process bash-3f9a2c1d0b7e (tests) is running. Output: /home/writer/.processes/bash-3f9a2c1d0b7e.out. Call status, wait or cancel with its handle.]
```

| State       | The bracketed line                                     |
| ----------- | ------------------------------------------------------ |
| `running`   | `Process <h> is running. ... Call status, wait or ...` |
| `exited`    | `Process <h> exited with code <n>.`                    |
| `timed_out` | `Process <h> timed out after <timeout> seconds.`       |
| `cancelled` | `Process <h> is cancelled.`                            |
| `failed`    | `Process <h> failed: <message>.`                       |

**A process with a name shows it in brackets after the handle.** The
table above writes `<h>` for the handle and the name together.

**A process that the close of its exchange cancelled says so.** Its line
is `Process <h> is cancelled: its exchange closed.`
([The end of an exchange](#the-end-of-an-exchange)).

**The view keeps the last 2000 lines or 50 KB.** These are the limits of
Pi's `bash` tool. When the view cuts the output, the bracketed line adds
`The text above is the last <n> lines, <size> of <total>.` The agent reads
the rest from the output file with `read`, which takes an offset and a
limit.

**`details` holds the status of the process and the truncation.**
`details.process` is a `ProcessStatus`: the handle, the name when the
agent gave one, the kind, the owner agent, the command, the state, the output path, the timeout, the room and
the exchange that started it, the start and end times, and the exit code
or the error.

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

## Handles

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

## ps

**`ps` lists running processes from the process table.** It reads no
file and runs no command, so it is one read of the host's memory. It
answers for every backend in the same way.

| Parameters        | What `ps` lists                             |
| ----------------- | ------------------------------------------- |
| None              | The running processes of the calling agent  |
| `agent: '<name>'` | The running processes of the agent `<name>` |
| `all: true`       | The running processes of every agent        |
| `agent` and `all` | Nothing: the call fails with `Invalid`      |

**Each row states one process.** The rows are in the order the processes
started. The command shows its first line, cut to 80 characters. A
process with no name has an empty name cell.

```text
| Handle            | Name       | Agent  | Runs for | Room  | Command            |
| ----------------- | ------ | -------- | ----- | ------------------ |
| bash-3f9a2c1d0b7e | tests      | writer | 2m 14s   | lobby | npm test           |
| bash-9c01d4e2aa31 | server-log | writer | 12s      | lobby | tail -f server.log |

2 running processes.
```

**A call with no running process to list gives one line.** It is
`No running processes.`, or `<name> has no running processes.`

**Another agent's row gives the metadata of its process alone.** The
command text is visible to every agent in the workspace, as `ps` on a Unix
server shows the command lines of other users. The output of the process
is not: `status`, `wait`, and `cancel` stay with the owner agent.

**`ps` lists running processes alone.** A finished process stays in the
table ([Handles](#handles)), and `status` reaches it by its handle. The
reminder names the finished processes that the agent has not yet seen
([Reminders](#reminders)).

## Reminders

**Each activation of a seat starts with a list of its processes.** A
seat can lose a handle: a new activation, a compaction of its session, or
a harness with no session all start with no memory of an earlier
`bash` call. The reminder gives the handles back.

**The reminder names two sets of the seat's processes.**

- Every running process of the agent, in every room of the workspace.
- Every finished process of the agent whose final state no result has
  shown yet. The reminder shows it once, and marks it as seen.

```text
Your background processes in the workspace:
- tests, bash-3f9a2c1d0b7e, is running for 2m 14s: npm test
- server-log, bash-5e7b20c4f1d9, is running for 40s in the room review: tail -f server.log
- bash-9c01d4e2aa31 exited with code 1 at 14:02:11: make build
Call status, wait or cancel with a handle. Call ps to list processes.
```

**Each line starts with the name when the process has one.** The handle
follows it. A process with no name starts with its handle.

**A seat with no process to name gets no reminder.** The activation text
then has no line about processes.

**The reminder needs one change in the core: a bundle gives text for each
activation.** `ToolBundle` gets one optional member. `defineAgent` keeps
it for each bundle, and `renderActivation` calls it once for each
activation, in every executor.

```ts
export interface ToolBundle {
  readonly tools: readonly AmbionTool[];
  readonly guidance?: string;
  /**
   * Text for one activation of one seat, or undefined for none. The room
   * calls it when it renders the activation, after `guidance`.
   */
  readonly remind?: (seat: {
    readonly agent: string;
    readonly room: string;
    readonly activation: string;
    readonly exchange?: Pick<ExchangeRef, 'owner' | 'from'>;
  }) => string | undefined;
}
```

**`remind` is synchronous.** The process table is in the host's memory,
so the workspace answers with no I/O. A bundle that needs I/O for its text
is a later design.

**The reminder goes in the turn context of the activation.** `guidance`
is the same for every activation, and the agent part holds it. The
reminder changes on each activation, so it stays out of the agent part,
and a provider's cache of the agent part stays valid.

**The reminder shows at the start of the activation alone.** A later pass
of the same activation adds no reminder. Every result of a process tool
states the process, and `ps` gives the whole list.

## The end of an exchange

**The close of an exchange cancels every running process that it
started.** A process records the room and the exchange of the `bash` call
that started it, from `ToolContext.room` and `ToolContext.exchange`. When
the room writes the close of that exchange, the process table cancels
each running process of that room and exchange, for every agent. The
state becomes `cancelled`, and the line says `its exchange closed`.

**`workspace.follow(room)` gives the workspace the closes of one room.**
It subscribes to the room's `exchange_closed` events, and returns a
handle with `stop()`. A host calls it once for each room that seats the
workspace's tools, as it calls `mirror()`. The room publishes
`exchange_closed` already, so the room and the journal do not change.

```ts
const site = openWorkspace({ name: 'lab', backend: { bash: memoryBackend() } });
const room = await openRoom({ name: 'lobby', seats: [surveyor] });
const following = site.follow(room);
// ...
await following.stop();
```

**A process that starts after the close of its exchange lives as long as
its call.** A closing activation runs after the close, with the exchange
it summarizes. The table remembers the closes it saw, and cancels such a
process when its `bash` call returns.

**Two kinds of process have no exchange to close.** A process from a
call outside a room, and a process from a room that the host does not
follow, run until they end, until their timeout, or until a cancel.

**The notices belong to the current run of the room.** A room that
resumes needs a new `follow`. A restart of the host loses the process
table as well ([Handles](#handles)).

**An exchange that awaits a person is closed.** The `awaiting` outcome
holds on a closed exchange ([Exchange](exchange.md)), so the close
cancels its processes too. A build that must outlive the question to a
person starts again in the next exchange.

## Life and disposal

**A process outlives the activation that started it.** An abort of the
`bash` call stops the call's wait. The process keeps running until it
ends, it times out, an agent cancels it, or its exchange closes.

**`wait` gives the state when the process ends or when the time ends.** A
process that is still running gives `running`. An abort of the call stops
the wait, and the process keeps running.

**`cancel` aborts the process and waits up to 10 seconds for it to end.**
The backend's abort path stops the command, and the state becomes
`cancelled`. A `cancel` of a process in a final state gives that state
again.

**The process table stops the processes of one agent one at a time.** An
abort on the workstation opens a channel of its own. A stop waits for the
stops of the same agent before it, so two stops never hold two abort
channels on one client. The close of an exchange and `dispose()` stop
processes in the same way.

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
process has no entry of its own, and neither has a cancel by the close
of an exchange. The output file is the record.

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
A process stops after timeout seconds, 600 by default, or when its exchange closes.
```

## Kinds of process

**A new kind adds three parts.** It adds a name to `ProcessKind`, a
runner that gives a final state, and a tool that starts it. The process
table, the handle format, the output file, `ps`, the reminder, and the
three handle tools stay as they are.
[Backlog](../planning/backlog.md#designs-with-a-shape) holds the kinds and
the notice that wait for a condition.

## For review

**Each decision below has a recommendation.** The code starts when the
review confirms it or changes it.

1. **The word process replaces job.** The code renames `JobStatus` to
   `ProcessStatus`, `details.job` to `details.process`, and `~/.jobs` to
   `~/.processes`. The state line says `Process`. The handle format stays.
   _Recommendation:_ rename, since `ps` and this page use process.
2. **The reminder needs `ToolBundle.remind` in the core.** The
   alternatives change nothing in the core, and each misses the start of
   an activation. A footer on each tool result reaches the seat only
   after its first call. A guidance line that tells the seat to call `ps`
   first costs one call in every activation, and a seat can skip it.
   _Recommendation:_ add `remind`.
3. **`follow(room)` gives the closes to the workspace.** The alternative
   is a bundle hook that the room calls on a close, which changes the
   room. A second alternative cancels lazily: a room has one open
   exchange, so a call with a new exchange means the old one closed. It
   cancels late, at the next call in the room. _Recommendation:_
   `follow`, with no lazy sweep.
4. **`ps` shows the processes of other agents, with their command
   text.** `status`, `wait`, and `cancel` stay with the owner agent.
   _Recommendation:_ as stated. A `wait` on another agent's process is
   useful for coordination, and it can come later, with no output.
5. **The close of an `awaiting` exchange cancels its processes.**
   _Recommendation:_ cancel, for now, as the request states.
6. **A crash of the host leaves a workstation process on the server.**
   The host holds the timeout, and a dead host kills nothing. The group
   keeps running until it ends by itself. _Recommendation:_ a later
   change wraps the command in `timeout --kill-after` on the server. It
   stays out of this change.
7. **The reminder names processes in every room of the workspace.** A
   seat in two rooms sees the processes it started in each.
   _Recommendation:_ every room, with the room in the row when it is not
   the current room.
8. **A name is a label, and the handle stays the key.** An agent recalls
   `tests` more easily than `bash-3f9a2c1d0b7e`, and the reminder gives
   both. A name that `status`, `wait`, and `cancel` accept needs a rule
   for two running processes with one name. _Recommendation:_ a label
   alone, with no uniqueness rule. Accept a name in place of a handle
   later, if seats pass names to these tools.
