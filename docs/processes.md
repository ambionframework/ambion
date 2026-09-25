# Processes

**Background processes are part of 0.3.0.** In 0.2.0, `bash` holds the
call until its command ends, and a workspace has four tools.

**`bash` starts every command as a background process.** The call gives a
handle for the process. `status`, `wait`, and `cancel` take that handle,
and `ps` lists the processes. Every workspace has these five tools, on
every bash backend.

**The files of the bash backend are the source of truth.** Each process
is a directory in its owner agent's home. The table reads those files for
every answer, so a new run of the host reads the same table. Memory holds
only what no file can: the environment, the controller, and the timer of
each process that this run owns or adopts.

**A process runs until it ends, times out, or gets a cancel.** An
activation, an exchange, and a room do not stop a process. The host sees
the processes of the agents of this run through `workspace.processes`
([The host's view](#the-hosts-view)).

**`@ambionframework/workspace` implements this page.**

| File               | Holds                                                                |
| ------------------ | -------------------------------------------------------------------- |
| `process-files.ts` | The files of a process, the wrapper, the listing, and the state rule |
| `processes.ts`     | The table: starts, reads, adoptions, stops, and the host's view      |
| `process-run.ts`   | One run of a process, and the waits                                  |
| `process-tools.ts` | The five tools, and the read of the end of an output                 |
| `process-text.ts`  | The state line, the `ps` table, and the reminder text                |

The journal holds no entry for a process. [Workspace](workspace.md)
states the owner and the backends that a process runs on.

## Words

| Word        | Meaning                                                                       |
| ----------- | ----------------------------------------------------------------------------- |
| process     | One background command that the workspace runs for one agent                  |
| handle      | The key of one process: `<kind>-<12 hex digits>`, such as `bash-3f9a2c1d0b7e` |
| name        | A label that the agent gives a process, such as `tests`                       |
| owner agent | The agent whose call started the process                                      |
| run         | One run of the host process, from `openWorkspace` to `dispose` or a crash     |
| adopt       | Take a live process of an earlier run into this run's timers and stops        |
| output file | `~/.processes/<handle>/out` in the owner agent's home                         |
| kind        | What started the process. `bash` is the one kind today                        |

## The tools

| Tool     | Parameters                              | What it does                                                         |
| -------- | --------------------------------------- | -------------------------------------------------------------------- |
| `bash`   | `command`, `name?`, `timeout?`, `wait?` | Starts a process, waits up to `wait` seconds, and gives its state    |
| `ps`     | None                                    | Lists the caller's running processes                                 |
| `status` | `handle`                                | Gives the state of the process and its new output                    |
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
`ps`, and the reminder show it beside the handle. The handle stays the
key. Two processes can have the same name.

**Every tool reaches the caller's own processes alone.** The table of an
agent is the agent's own home. A handle of another agent fails with
`You have no process <handle>.`

## The files

**Each process is a directory: `~/.processes/<handle>/`.**

| File     | Written by  | When                                                                 |
| -------- | ----------- | -------------------------------------------------------------------- |
| `spec`   | The table   | At the start: the command, the name, the timeout, the room, the time |
| `out`    | The command | While it runs. The just-bash backends write it when the command ends |
| `pid`    | The wrapper | First: the pid of the shell that runs the command                    |
| `exit`   | The wrapper | After the command: the exit code and the time, whole or absent       |
| `stop`   | The table   | Before it stops the process: `cancelled`, `timed_out`, or `failed`   |
| `seen`   | The table   | When a result or a reminder showed the end                           |
| `cursor` | The table   | After each result: the byte offset of the output that results showed |

**The wrapper writes the pid, runs the command, and writes the end.**

```sh
echo "$$" > '<dir>/pid'
(
<command>
) < /dev/null > '<dir>/out' 2>&1
echo "$? $(date -u +%Y-%m-%dT%H:%M:%SZ)" > '<dir>/exit.tmp' && mv '<dir>/exit.tmp' '<dir>/exit'
```

The subshell keeps an `exit` in the command from ending the wrapper. The
command stands on lines of its own, so a comment or a here-document at its
end does not reach the parenthesis. The rename makes `exit` whole or
absent. The shell can write before the redirect applies, for example on a
syntax error. The table adds that output to the end of `out`, up to 16 KB
or 200 lines, and records the shell's exit code in `exit`.

**The files give the state.**

| Files                            | State                                                     |
| -------------------------------- | --------------------------------------------------------- |
| `exit`                           | `exited`, with the code                                   |
| The shell still runs the command | `running`, also while a stop waits for the end            |
| `stop`, the shell gone           | `cancelled`, `timed_out`, or `failed`, as `stop` names it |
| Neither, the shell gone          | `failed`: `The host run ended before the process did.`    |

**`exit` wins, and `stop` names the cause of a stop.** The table writes
`stop` before it aborts, in one shell command that writes it only when no
`exit` exists. A cancel or a timeout that meets the natural end of a
command reads the exit code. The shell "still runs the command" when this run owns
the process, or when `ps -ww -o args=` for the pid holds the handle. The
handle check keeps a pid that the system reused for another program from
reading as the process.

**One shell command reads the table of an agent.** A POSIX script runs
one `find` that hands `spec`, `exit`, `stop`, and `seen` of every process
to one `grep`. Where `ps` exists, the script then checks the pid of each
process with no `exit`. A read costs one `exec` on every backend, and
just-bash reads a table of 64 processes in about 30 ms. `ps` and the
reminder read the whole table. `status`, `wait`, and `cancel` read the one
process.

## The result

**Each result of `bash`, `status`, `wait`, and `cancel` is the new output,
then one bracketed line.** The new output is the output after the cursor:
the part that no earlier result of the agent showed. The line states the
process, its handle, its name when it has one, and its output file. A
process that ended with no output shows `(no output)`, and one that wrote
nothing new since the last result shows `(no new output)`.

**The cursor moves with each result.** A read gives the bytes from the
cursor to the size of `out` when the read began, and writes that size to
`cursor`. A result that starts past the start of the output adds `The text
above starts at byte <n> of the output. An earlier result showed the bytes
before it.` `details.read` holds `from` and `to`. Ten polls of a long build
give ten new parts, and no part twice. The cursor is a file, so a new run
of the host reads on from the same byte. A failed write of `cursor` gives
the same bytes again on the next read.

```text
/home/writer
slab pour Thu

[Process bash-a68e2a3f5863 exited with code 0. Output: /home/writer/.processes/bash-a68e2a3f5863/out.]
```

```text
compiling 14 of 120

[Process bash-3f9a2c1d0b7e (tests) is running. Output: /home/writer/.processes/bash-3f9a2c1d0b7e/out. Call status, wait or cancel with its handle.]
```

| State       | The bracketed line, where `<h>` is the handle and the name |
| ----------- | ---------------------------------------------------------- |
| `running`   | `Process <h> is running. ... Call status, wait or ...`     |
| `exited`    | `Process <h> exited with code <n>.`                        |
| `timed_out` | `Process <h> timed out after <timeout> seconds.`           |
| `cancelled` | `Process <h> is cancelled.`                                |
| `failed`    | `Process <h> failed: <message>.`                           |

**The view keeps the last 2000 lines or 50 KB of the new output.** These
are the limits of Pi's `bash` tool. When the view cuts the new output, the
bracketed line adds `The text above is the last <n> lines, <size> of
<total>.` One read takes at most 200 KB, with `head -c <size> | tail -c
<count>`. The agent reads the rest with `read`, which takes an offset and a
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
| `endedAt`   | ISO time of the end, when the files name it                  |
| `exitCode`  | Set when the state is `exited`                               |
| `error`     | Set when the state is `failed`                               |

**A `bash` call fails when its process ends inside the window with a
failure.** The failures are an exit code other than 0, a timeout, and a
fault of the backend. These are the cases in which Pi's `bash` tool fails.
The error text is the result text, so it names the handle. `ps`,
`status`, `wait`, and `cancel` give every state as a result. They fail
only on an unknown handle or an invalid value.

## A process

**A process runs on an environment of its own.** The table connects it
through the bash backend, outside the queue of the bash owner. A long
process holds no tool call of any agent.

**`bash` starts its process as one operation on the bash owner.** The
start comes after every earlier operation on the owner, so a `write` and
then a `bash` that reads the file stay in order. The start reads the
agent's table, checks the limits, writes `spec`, and connects the
process's environment.

**After the start, the backend's filesystem orders a process against
other work.** A process and a later `write` of the same agent can
interleave. The owner gives no order between them.

**The table bounds the processes of each agent.**

- **4 running processes.** A `bash` call past that fails, and tells the
  agent to wait for a process or to cancel one. On the workstation, each
  running process holds one channel of the agent's SSH client, and
  OpenSSH allows 10 channels on one client by default
  ([Workstation](workstation.md#the-ssh-client)).
- **64 finished processes.** A start removes the directories of the
  finished processes past that number: the oldest seen ones first, then
  the oldest that no result or reminder showed.

**The table holds the timeout of each process.** At the timeout, the
table stops the process the way a cancel does. The backend's own deadline
is 30 seconds later, and it stops a process that the table's stop did not
end.

**The table stops the processes of one agent one at a time.** A stop on
the workstation opens a channel of its own for the kill. A stop waits for
the stops of the same agent before it, so the stops of one agent hold at
most one kill channel while each stop ends within its grace of 10
seconds. A cancel, a timeout, a cancel by the host, and `dispose()` all
stop a process this way.

## Recovery

**A new run of the host reads the table from the files.** Nothing moves
from memory to the files at a shutdown. A crash of the host loses no
process record.

**A live process of an earlier run is adopted when a read finds it.** The
table arms its timeout again from `startedAt` and `timeout` in `spec`. A
process past its timeout stops at once. `cancel` and the timeout kill it
through its pid: the table writes `stop`, and a script kills the process
group of the pid. The script kills the group only when the group is not
its own, so a backend that runs commands in the host's group loses one
shell and no more.

**A process of an earlier run that no shell runs is lost.** Its state is
`failed`, with the error `The host run ended before the process did.` The
reminder names it once.

| Backend              | What a new run finds of a running process          |
| -------------------- | -------------------------------------------------- |
| `memoryBackend`      | No file: the files lived in the host's memory      |
| `directoryBackend`   | A lost process: its commands ran in the host       |
| `workstationBackend` | A live process, adopted, when its group still runs |

**The end of an adopted process comes from a read.** No run of this host
waits on its shell, so a wait reads its files every 500 ms. The host's
`ended` event comes when a read of this run first sees the end.

**Two runs of the host over one account adopt the same processes.** A
second run adopts the live processes of the first, and its `dispose()`
stops them while the first run still waits on them. The journal fences
a second host of a room, and the process table has no fence. Stop one
run of the host before the next one starts over the same accounts.

## ps

**`ps` lists the caller's running processes.** It reads the caller's
table. Each line states one process, in the order the processes started.
The command shows its first line, cut to 80 characters.

```text
| Handle | Name | Runs for | Command |
| --- | --- | --- | --- |
| bash-3f9a2c1d0b7e | tests | 2m 14s | npm test |
| bash-9c01d4e2aa31 | server-log | 12s | tail -f server.log |

2 running processes.
```

**A caller with no running process gets one line:** `No running
processes.` A finished process stays in the files, and `status` reaches
it by its handle.

## The host's view

**`workspace.processes` gives the host the processes of this run's
agents.** A host uses it to show a person what runs, and to stop a process
that an agent left running. It adds no tool.

```ts
export interface WorkspaceProcesses {
  list(query?: { agent?: string; running?: boolean }): Promise<readonly ProcessStatus[]>;
  subscribe(listener: (event: ProcessEvent) => void): () => void;
  cancel(handle: string): Promise<ProcessStatus>;
}

export type ProcessEvent =
  | { readonly type: 'started'; readonly process: ProcessStatus }
  | { readonly type: 'ended'; readonly process: ProcessStatus };
```

**`list` reads the tables of the agents that used the workspace in this
run.** An agent joins that set on its first process tool call or
reminder. A `read`, `write`, or `edit` call adds no agent. A new run of the
host shows an agent's processes once that agent acts again.
`running: true` gives the running processes alone, and `agent` gives one
agent.

**`subscribe` gives one event when a process starts and one when it
ends.** It covers the processes of this run, and the adopted ones whose
end a read of this run sees. A listener that throws does not stop the
other listeners or the process.

**`cancel` stops the process of any agent of this run.** It waits up to
10 seconds for the end, and a process that has not ended by then still
reads `running`. The host reads the output of a process through
`workspace.use`, as the owner agent, at `ProcessStatus.output`.

## Reminders

**Each respond activation of a seat starts with a list of its
processes.** A new activation, a compaction of a session, and a harness
with no session all lose the handles of earlier `bash` calls. The
reminder gives them back.

**The reminder names two sets of the seat's processes.**

- Every running process of the agent, in every room of the workspace.
- The finished processes of the agent with no `seen` file: the newest
  10, then `and <n> more`. The reminder writes `seen` for each one it
  names.

```text
Your background processes in the workspace:
- tests, bash-3f9a2c1d0b7e, is running for 2m 14s: npm test
- server-log, bash-5e7b20c4f1d9, is running for 40s in the room review: tail -f server.log
- bash-9c01d4e2aa31 exited with code 1 at 14:02:11 UTC: make build
Call status, wait or cancel with a handle. Call ps to list processes.
```

**Each line starts with the name when the process has one.** The handle
follows it. A process from another room names that room. A seat with no
process to name gets no reminder, and a summarize activation calls none.

**The executor resolves the reminders once, at the start of an
activation.** `ToolBundle.remind` returns the text, or a promise of it.
`describeExecutor` collects the reminders of the bundles into
`AgentExecutor.reminders`. `resolveReminders` from
`@ambionframework/ambion/hosting` runs them together and gives the text,
and `renderActivation` takes it as its third argument. The text goes in
the turn context, before the ask line.

```ts
export interface ToolBundle {
  readonly tools: readonly AmbionTool[];
  readonly guidance?: string;
  readonly remind?: Reminder;
}

export type Reminder = (
  seat: ReminderSeat,
  signal: AbortSignal,
) => string | undefined | Promise<string | undefined>;

export interface ReminderSeat {
  readonly agent: string;
  readonly room: string;
  readonly activation: string;
}
```

**A reminder has 5 seconds.** A reminder that throws, rejects, gives
blank text, or takes longer gives no text, and the activation goes on.
At the bound the executor aborts `signal`. The workspace reminder then
writes no `seen`, and a read that waits on a busy bash owner does not
start. The core does not cut a long reminder, so the bundle bounds its own
text.

**Each executor resolves on the first pass of the activation.**

- **Pi** resolves when the pass has something to send. A continued
  session with no new message calls no reminder. A continued session
  reads the reminder before the delta.
- **Claude** and **Codex** resolve for the whole view of the first pass.

**The workspace reminder costs one read of the agent's table.** It runs
on the bash owner. On the workstation, the read connects the agent's SSH
session at the start of the agent's first activation, and it creates the
agent's home on every backend.

**A reminder can mark a finished process as shown that no model read.**
An activation that fails between the reminder and its first request to
the provider loses that one notice. `ps` and `status` still reach the
process.

## Life and disposal

**A process outlives the call, the activation, and the exchange that
started it.** An abort of the `bash` call stops the call's wait. The
process keeps running until it ends, it times out, the owner agent or the
host cancels it, or the workspace disposes.

**`wait` gives the state when the process ends or when the time ends.** A
process that is still running gives `running`. An abort of the call stops
the wait, and the process keeps running.

**A wait ends 30 seconds before the room ends the activation.** The room
ends an activation `limits.lease.deadline` after its first claim, 600
seconds by default, and counts it as a failed attempt. `ToolContext.deadline`
carries that time. `bash` and `wait` wait for the shorter of the time the call
gives and the time left before the margin. A process that still runs then
gives `running`, and the result line adds `The wait stopped early, because
your activation ends in <n> seconds. Answer before then.` The margin also
covers the skew between the clock of the room's host and the clock of the
seat's host.

**`cancel` stops the process and waits up to 10 seconds for it to end.**
The state becomes `cancelled`. A process that has not ended after 10
seconds still reads `running`, and a later `status` gives its end. A
`cancel` of a process in a final state gives that state again.

**A shell that outlives its run becomes adopted.** A process can ignore a
kill, for example in an uninterruptible wait. When its run ends while its
shell still runs, the table adopts it. The host's one `ended` event for
it comes when a read sees its end.

**`dispose()` stops every running process of this run, and every adopted
one.** The bash owner refuses new work and drains its queue. The table
then refuses new processes and stops each running process, with a grace
of 10 seconds for each. The stops of one agent run one at a time, and the
agents run in parallel. The bash backend then
disposes. The git owner disposes after the bash owner, so a push in a
process still reaches the git backend.

## Backends

| Backend              | While the process runs                       | Cancel and timeout                                                  |
| -------------------- | -------------------------------------------- | ------------------------------------------------------------------- |
| `memoryBackend`      | `out` stays empty until the process ends     | The process ends, and `out` stays empty                             |
| `directoryBackend`   | `out` stays empty until the process ends     | The process ends, and `out` stays empty                             |
| `workstationBackend` | The output reaches `out` as the command runs | The process group gets `SIGKILL`, and `out` keeps the output so far |

**just-bash has no `ps` and no `kill`.** A just-bash process runs in the
host's process, so no process outlives its run, and the listing finds no
live shell.

**Adoption on the workstation needs the `ps` of procps.** The listing
runs `ps -ww -o args= -p`, and the kill runs `ps -o pgid= -p`. The
BusyBox `ps` of an Alpine image refuses `-p`. On such a server, a live
process of an earlier run reads as lost, and nothing stops it.

**A workstation process holds an environment over the agent's SSH
session.** The session stays open while any environment is open over it
([Workstation](workstation.md#the-ssh-client)).

**On just-bash, every home is readable.** Another agent can read the
files of a process with `read` or `bash`. The wall between agents is the
workstation's Unix accounts.

## The audit log

**Each call of the five tools has one audit entry.** The entry runs on
the bash owner after the call ends. The entry of a `bash` call holds the
state at the end of the call, which can be `running`. A `bash` call that
an abort cuts while it waits records an error with no handle, and the
process keeps running. The reminder and `ps` name it. The files of a
process are its record.

## The guidance

**`openWorkspace` adds one note about the process tools after the tool
line.**

```text
bash starts each command as a background process and returns its handle, such as bash-1a2b3c4d5e6f.
Give a long-running process a name, such as tests or dev-server, so you can tell your processes apart.
The call waits up to wait seconds, 10 by default, and then gives the state of the process and the end of its output.
The whole output of a process goes to ~/.processes/<handle>/out. Read it with read.
status, wait and cancel take a handle. status gives the state of the process, wait waits for it to end,
and cancel stops it. ps lists your running processes.
A process keeps running after your activation ends. It stops after timeout seconds, 600 by default.
```

## Out of scope

**A process has no link to the life of an activation, an exchange, or a
room.** An exchange closes when no activation is live, so a cancel at the
close stops a process at the first quiet moment.
[Backlog](../planning/backlog.md#designs-with-a-shape) holds the linked
lives, the kinds of process after `bash`, and the notice at the end of a
process.

**A new kind adds three parts.** It adds a name to `ProcessKind`, a
runner that writes the same files, and a tool that starts it. The table,
the handle format, the files, `ps`, the host's view, the reminder, and
the three handle tools stay as they are.

## Decisions taken

| Decision                                                       | Reason                                                                  |
| -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| The files of the bash backend are the source of truth          | A new run reads the same table, and a crash loses no record             |
| An agent reaches its own processes alone                       | Its table is its home, and the workstation's accounts make it the wall  |
| A lost process reads `failed`                                  | It left no end, and nothing runs it                                     |
| The host's list covers this run's agents                       | The workspace keeps no roster                                           |
| The reminder resolves once per activation, and can read I/O    | Every render of one activation reads the same text                      |
| The table holds the timeout, and adopts a live process         | A kill goes through the stops of its agent, in every run                |
| A stop writes no `stop` after `exit`                           | A command that ended reads its own end, whatever stop came late         |
| The default timeout is 600 seconds, and the agent can raise it | An adopted process needs a bound from its spec                          |
| A name is a label, and the handle is the key                   | Two processes can have one name with no rule for which one a call takes |
| `ps` writes an audit entry                                     | The audit log records every tool call                                   |

**The host owns the cleanup of `~/.processes` past the limit of 64.** A
start removes the oldest finished processes of the agent that starts it,
the seen ones first.
An agent that starts no process keeps its directories.
