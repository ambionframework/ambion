# Processes

> Every process has a port in `$PORT`. A process that listens on it serves
> HTTP, and any agent reads it with `fetch`
> ([Processes that serve HTTP](#processes-that-serve-http)).
> The Workbench example runs
> [sensor servers](../examples/workbench/docs/sensors.md#run-a-server-from-git)
> and [device controllers](../examples/workbench/docs/actuators.md) as such
> processes.

**`bash` starts every command as a background process.** The call gives a
handle for the process. `cancel` takes that handle, `wait` takes a list of
handles, and `ps` lists the processes. `wait` with one handle and `timeout:
0` reads the state and the new output at once. Every workspace has these four
tools, on every bash backend.

**The files of the bash backend are the source of truth.** Each process
is a directory in its owner agent's home. The table reads those files for
every answer, so a new run of the host reads the same table. Memory holds
only what no file can: one record for each live process, with its timer,
and the key of each process that this run saw end. The `ended` query of the
table answers from those keys. The record of a process that this run
started also holds its environment and its controller. The record of an
adopted process holds neither.

**A process runs until it ends, times out, or gets a cancel.** An
activation, an exchange, and a room do not cancel a process. The host sees
the processes of the agents of this run through `workspace.processes`
([The host's view](#the-hosts-view)).

**`@ambionframework/workspace` implements this page.**

| File                | Holds                                                                |
| ------------------- | -------------------------------------------------------------------- |
| `process-files.ts`  | The files of a process, the wrapper, the listing, and the state rule |
| `processes.ts`      | The table: starts, reads, adoptions, and the host's view             |
| `process-cancel.ts` | The cancels: the chain of steps for each agent, and the waits        |
| `process-run.ts`    | One run of a process, and the waits                                  |
| `process-fetch.ts`  | The forward cache: the lookup of a process and the request to it     |
| `process-tools.ts`  | The four tools, and the read of the end of an output                 |
| `process-text.ts`   | The state line, the `ps` table, and the reminder text                |

The journal holds no entry for a process. [Workspace](workspace.md)
states the resources and the backends that a process runs on.

## Words

| Word        | Meaning                                                                       |
| ----------- | ----------------------------------------------------------------------------- |
| process     | One background command that the workspace runs for one agent                  |
| handle      | The key of one process: `<kind>-<12 hex digits>`, such as `bash-3f9a2c1d0b7e` |
| name        | A label that the agent gives a process, such as `tests`                       |
| port        | The number in `$PORT` for one process, from 20000 to 29999                    |
| forward     | One tunnel from the host to the port of one process, over the backend         |
| owner agent | The agent whose call started the process                                      |
| run         | One run of the host process, from `openWorkspace` to `dispose` or a crash     |
| adopt       | Take a live process of an earlier run into this run's timers and cancels      |
| output file | `~/.processes/<handle>/out` in the owner agent's home                         |
| kind        | What started the process. `bash` is the one kind today                        |
| grace       | The seconds from `SIGTERM` to `SIGKILL` when the table cancels a process      |

## The tools

| Tool     | Parameters                                        | What it does                                                      |
| -------- | ------------------------------------------------- | ----------------------------------------------------------------- |
| `bash`   | `command`, `name?`, `timeout?`, `wait?`, `grace?` | Starts a process, waits up to `wait` seconds, and gives its state |
| `ps`     | None                                              | Lists the caller's running processes                              |
| `wait`   | `handles`, `timeout?`                             | Waits up to `timeout` seconds for the first process to end        |
| `cancel` | `handle`                                          | Cancels a running process, waits for it to end, then as `wait`    |

| Value                | Default | Range                                        |
| -------------------- | ------- | -------------------------------------------- |
| `bash` `timeout`     | 600 s   | Above 0, up to 2,147,483 s                   |
| `bash` `wait`        | 30 s    | 0 to 600 s. 0 returns at once                |
| `wait` `timeout`     | 30 s    | 0 to 600 s. 0 reads without a wait           |
| `bash` `grace`       | 10 s    | 1 to 300 s                                   |
| The wait of `cancel` | 15 s    | At most 15 s: the grace, up to 10 s, and 5 s |

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

| File     | Written by  | When                                                                                      |
| -------- | ----------- | ----------------------------------------------------------------------------------------- |
| `spec`   | The table   | At the start: the command, the name, the port, the timeout, the grace, the room, the time |
| `out`    | The command | While it runs. The just-bash backends write it when the command ends                      |
| `pid`    | The wrapper | First: the pid of the shell that runs the command                                         |
| `exit`   | The wrapper | After the command: the exit code and the time, whole or absent                            |
| `stop`   | The table   | Before it cancels the process: `cancelled`, `timed_out`, or `failed`                      |
| `stop`   | The table   | When a read first finds the process lost with a `pid`: `failed`                           |
| `seen`   | The table   | When a result or a reminder showed the end                                                |
| `cursor` | The table   | After each result: the byte offset of the output that results showed                      |

**The wrapper writes the pid, runs the command, and writes the end.**

```sh
trap : TERM 2>/dev/null
echo "$$" > '<dir>/pid'
(
trap 'exit $?' TERM 2>/dev/null
<command>
) < /dev/null > '<dir>/out' 2>&1
echo "$? $(date -u +%Y-%m-%dT%H:%M:%SZ)" > '<dir>/exit.tmp' && mv '<dir>/exit.tmp' '<dir>/exit'
```

The trap keeps the wrapper alive through the `SIGTERM` of a cancel
([The cancel](#the-cancel)). The subshell keeps an `exit` in the command from
ending the wrapper. The command stands on lines of its own, so a comment
or a here-document at its end does not reach the parenthesis. The rename
makes `exit` whole or absent. The shell can write before the redirect
applies, for example on a syntax error. The table adds that output to the
end of `out`, up to 16 KB or 200 lines, and records the shell's exit code
in `exit`.

**The files give the state.**

| Files                            | State                                                     |
| -------------------------------- | --------------------------------------------------------- |
| `exit`                           | `exited`, with the code                                   |
| `exit` with code 143, and `stop` | `cancelled` or `timed_out`, as `stop` names it            |
| The shell still runs the command | `running`, also while a cancel waits for the end          |
| `stop`, the shell gone           | `cancelled`, `timed_out`, or `failed`, as `stop` names it |
| Neither, the shell gone          | `failed`: `The host run ended before the process did.`    |

**The first read that finds a process lost with a `pid` writes `stop`.**
The line is `failed <time> The host run ended before the process did.`
The time names that read, and the status has no `endedAt`. The listing
runs no `ps` for a process with this line while `/proc` has no directory
for its pid, so later reads cost no `ps` for it. The state stays
`failed`, and `exit` still wins.

**A pid that is still in `/proc` gets the `ps` check.** A `ps` that fails
once, for example on a fork failure, writes the line for a live shell.
The next read finds the pid in `/proc`, runs `ps`, and adopts the
process. The live shell wins over the line, so the state is `running`,
and the timeout and `cancel` end the process.

**The line stays in `stop` while the shell runs.** A cancel of the table
writes over it. When the shell ends with no `exit`, the line gives the
state again. On a system with no `/proc`, the line alone skips the
process, and a `ps` that fails once makes the process lost for good.

**A process with no `pid` gets no line.** The listing runs no `ps` for it.
The run that writes `spec` starts the wrapper next, and the wrapper
writes `pid`. A read by another host between the two writes finds no
`pid`, and a later read adopts the process. A host that ends before it
starts the wrapper leaves a spec that never gains a `pid`. That process
stays lost.

**`exit` wins, and `stop` names the cause of a cancel.** The table writes
`stop` before it aborts, in one shell command that writes it only when no
`exit` exists. A cancel or a timeout that meets the natural end of a
command reads the exit code. A command that ends inside the grace of a
cancel reads its exit code too. Code 143 is the one exception: it is the
code of a command that the `SIGTERM` ended, so the cause in `stop` names
that end. The shell "still runs the command" when this run owns
the process, or when `ps -ww -o args=` for the pid holds the handle. The
handle check keeps a pid that the system reused for another program from
reading as the process.

**One shell command reads the table of an agent.** A POSIX script runs
one `find` that hands `spec`, `exit`, `stop`, `seen`, and `pid` of every
process to one `grep`. Where `ps` exists, the script then checks the pid
of each process with no `exit`. It skips a process whose `stop` names it
lost when `/proc` has no directory for its pid. Shell builtins read that
`stop` and test the directory, so the skip starts no program. A read
costs one `exec` on every backend, and just-bash reads a table of 64
processes in about 30 ms. `ps` and the reminder read the whole table.
`cancel` reads the one process. `wait` reads the one process when `handles`
holds one, and the whole table on each read when it holds several.

## The result

**Each result of `bash`, `wait`, and `cancel` is the new output,
then one bracketed line.** The new output is the output after the cursor: the
part that no earlier result of the agent showed. The line states the process,
its handle, its name when it has one, and its output file. A `wait` on several
handles gives this for each process that ended and fits its budget, then the
bracketed line of each one that still runs. A process that ended with no
output shows `(no output)`. A process that wrote nothing new since the last
result shows `(no new output)`. A running process that has written nothing yet
shows only the bracketed line.

**The cursor moves with each result.** A read gives the bytes from the
cursor to the size of `out` when the read began, and writes that size to
`cursor`. A result that starts past the start of the output adds `The text
above starts at byte <n> of the output. An earlier result showed the bytes
before it.` `details.text` holds the new output with no bracketed line, and
`details.read` holds `from` and `to`, the byte offsets of the output file.
Ten polls of a long build give ten new parts, and no part twice. One read
takes at most 200 KB, so a burst past that shows only its end, and `read`
reaches the rest. The cursor is a file, so a new run of the host reads on
from the same byte. A failed write of `cursor` gives
the same bytes again on the next read.

```text
/home/writer
slab pour Thu

[Process bash-a68e2a3f5863 exited with code 0. Output: /home/writer/.processes/bash-a68e2a3f5863/out.]
```

```text
compiling 14 of 120

[Process bash-3f9a2c1d0b7e (tests) is running. Output: /home/writer/.processes/bash-3f9a2c1d0b7e/out. Call wait with its handle, and timeout 0 to read it at once. Call cancel with its handle, or ps to list your processes. $PORT=24817.]
```

| State       | The bracketed line, where `<h>` is the handle and the name                |
| ----------- | ------------------------------------------------------------------------- |
| `running`   | `Process <h> is running. ... Call wait with its handle ... $PORT=<port>.` |
| `running`   | `Process <h> is running, and the table stopped it. ... $PORT=<port>.`     |
| `exited`    | `Process <h> exited with code <n>.`                                       |
| `timed_out` | `Process <h> timed out after <timeout> seconds.`                          |
| `cancelled` | `Process <h> is cancelled.`                                               |
| `failed`    | `Process <h> failed: <message>.`                                          |

**The result of a running process can point to a scheduled say.** `bash`
and `wait` add one note when three facts hold:

- **The activation ends in 120 seconds or less.** Earlier, a `wait` still
  has time, and the note would show on most results.
- **The process runs past the reach of a wait.** The reach of a wait ends
  30 seconds before `ToolContext.deadline`. The timeout of the process
  ends after that time.
- **The context carries an open exchange.** The room then takes a
  `schedule` call.

```text
Your activation ends in 95 seconds. Process bash-3f9a2c1d0b7e can run longer. To look at a process later, call schedule with delaySeconds.
```

**The note names the seconds left before the deadline.** The agent weighs
a last `wait` against a `schedule` call by that number. When the deadline
also cut the wait, the note starts with the line of the cut, which names
the same seconds. The seconds show once.

**The note names each process that qualifies.** `wait` on several handles
adds one note, and it names each running process past the reach of a wait.
`cancel` adds no note.

**The note shows only where `schedule` can help.** Outside a room there is
no `schedule`. A process that ends inside the reach of a wait needs a
`wait`, and each returned say costs one activation.

**The view keeps the last 2000 lines or 50 KB of the new output.** These
are the limits of Pi's `bash` tool. When the view cuts the new output, the
bracketed line adds `The text above is the last <n> lines, <size> of the
<total> after byte <n>.` in place of the start line. One read takes at
most 200 KB, with `head -c <size> | tail -c <count>`. The agent reads the
rest with `read`, which takes an offset and a limit.

**`details.process` is a `Process`.** The host's view gives the
same value.

| Field       | Holds                                                                      |
| ----------- | -------------------------------------------------------------------------- |
| `handle`    | The key of the process                                                     |
| `name`      | The label, when the agent gave one                                         |
| `kind`      | `bash`                                                                     |
| `agent`     | The owner agent                                                            |
| `command`   | The command as the agent gave it                                           |
| `state`     | `running`, `exited`, `timed_out`, `cancelled`, or `failed`                 |
| `output`    | The absolute path of the output file                                       |
| `timeout`   | Seconds the process may run                                                |
| `grace`     | Seconds from `SIGTERM` to `SIGKILL` when the table cancels the process     |
| `room`      | The room of the `bash` call, when it had one. Metadata alone               |
| `startedAt` | ISO time of the start                                                      |
| `endedAt`   | ISO time of the end, when the files name it                                |
| `exitCode`  | Set when the state is `exited`                                             |
| `error`     | Set when the state is `failed`                                             |
| `stopping`  | `true` while the state is `running` and `stop` names a cancel or a timeout |

**A process that ended badly fails the call that reports it.** An exit
code other than 0, a timeout, and a failed process make `bash` and
`wait` a tool error. The error text is the result text: the new
output, then the bracketed line that names the handle and the state. On
several handles, `wait` fails when a process that it reports as ended
ended badly. `cancel` gives the state of the process it cancelled, and
`ps` lists running processes, so neither fails on a state. An unknown
handle and the limit of running processes fail too
([Workspace](workspace.md#give-the-resource-to-an-agent)).

**In a compose call, the binding of a failed call rejects.** The binding of
`bash` or `wait` rejects with an `Error`, and `error.details`
holds the same result as a completed call: the `Process`, the new output in
`text`, and `read`. The binding of `cancel` and of `ps` never rejects on a
state ([Compose](compose.md#bindings)).

## A process

**A process runs on an environment of its own.** The table connects it
through the bash backend, outside the queue of the bash resource. A long
process holds no tool call of any agent.

**`bash` starts its process as one operation on the bash resource.** The
start comes after every earlier operation on the bash resource, so a `write` and
then a `bash` that reads the file stay in order. The start reads the
agent's table, checks the limits, writes `spec`, and connects the
process's environment.

**After the start, the backend's filesystem orders a process against
other work.** A process and a later `write` of the same agent can
interleave. The bash resource gives no order between them.

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
table cancels the process with the cause `timed_out`. The backend's own deadline
comes 30 seconds after the timeout and the grace. It ends a process that
the table's cancel did not end, with the same grace.

**The cancel steps of one agent run one at a time.** A step of a cancel
writes `stop`, aborts a process of this run, or sends a signal to an
adopted one. A step opens at most one short channel on the workstation.
A step never waits for an end, so a cancel with a long grace holds no later
cancel of the same agent. A cancel, a timeout, a cancel by the host, and
`dispose()` cancel a process this way ([The cancel](#the-cancel)). The
workstation sends one signal channel at a time for each client
([Workstation](workstation.md#the-ssh-client)).

## The cancel

**A cancel sends `SIGTERM` to the process group, waits for the grace, and
then sends `SIGKILL`.** The `grace` of the `bash` call sets the wait: 1 to
300 seconds, 10 by default. A server, a database, or a device controller
uses that time to clean up. A cancel, a timeout, a cancel by the host,
and `dispose()` all take this path. A `grace` outside the range makes the
call fail with `Invalid`.

**The grace reaches the backend in the options of `exec`.** `runBash`
passes `grace` beside `timeout`. An abort of the process's controller
and the backend's own deadline then end the command with that grace.
The table writes the grace to `spec` and keeps it in the record of each
live process, so an adopted process keeps the grace of its own call. A
`spec` with no `grace` is no spec: a read skips it.

```ts
export interface WorkspaceExecOptions extends ShellExecOptions {
  /** Seconds from SIGTERM to SIGKILL. Absent or 0: SIGKILL at once. */
  grace?: number;
}
```

**The wrapper outlives the `SIGTERM`.** `trap : TERM` installs a handler.
A handler resets to the default in each program that the command runs, so
each program gets the signal as usual. An ignored signal stays ignored in
every program that the command runs, so the wrapper never ignores `TERM`.
When the command ends, the wrapper writes `exit`. On the workstation, the
script's shell has the same handler
([Workstation](workstation.md#commands-and-aborts)).

**The subshell waits for its last program.** The subshell traps `TERM`
with `exit $?`. Bash 3.2 on macOS forks the last program of a list such as
`cd app && node main.js`. The trap makes the subshell wait for that program
and end with its code.

**A command that runs no program at the signal ends with its last code.**
The trap runs at once and exits with the code of the last command. A shell
loop such as `while true; do :; done` reads `exited` with code 0, and
`stop` alone records the cancel.

**The files record how the command ended.**

| The command                                                    | `exit` | State                   |
| -------------------------------------------------------------- | ------ | ----------------------- |
| Traps `TERM`, and exits in time with a code `n` other than 143 | `n`    | `exited`, with code `n` |
| A program that the `SIGTERM` ended: code 143                   | `143`  | The cause in `stop`     |
| Outlives the grace, and `SIGKILL` ends it                      | Absent | The cause in `stop`     |

**A parent process can hide a clean cancel.** The group signal reaches
every process of the command. A parent that dies on `TERM` gives the
wrapper 143 while its child cleans up. A probe showed it for a forking
`flock`, and `flock -F` or `exec` passed the child's 0 through. A command
that must report a clean cancel keeps its cleaning process last, with
`exec`. The trap of the wrapper's own subshell passes the code through.

**A command that exits 0 inside the grace reads `exited` with code 0.**
The code is the command's own answer: it cleaned up. `stop` still names
the cause, `cancelled` or `timed_out`, and `cancel` does not say that it
stopped nothing.

**`cancel` waits for the end, up to the grace and 5 seconds, and at most
15 seconds.** The wait is the shorter of the grace and 10 seconds, and 5
seconds more. The 5 seconds cover the `SIGKILL`, the close of the channel,
and the read of the files. While the cancel waits, the status reads
`running` with `stopping: true`. When the wait ends first, `cancel` gives
that status, and the cancel goes on: the `SIGKILL` still comes after the
full grace. The flag stays while the process runs, also after the wait
ends and in a later run of the host. The first read after the end gives
the final state. A process that has not ended by then still reads
`running`.

**The timeout takes the same path.** At the timeout, the table writes
`timed_out` to `stop` and aborts the process's controller. A command that
traps `TERM` and exits 0 then reads `exited` with code 0.

**An adopted process gets the same signals through its pid.** One step
of the chain writes `stop` and sends `SIGTERM` to the group of the pid.
The table then reads the files every 500 ms until the grace ends, outside
the chain. A second step of the chain sends `SIGKILL` to a group that
still runs, and the table reads for 5 seconds more, outside the chain.
The script checks the handle in the command line of the pid before each
signal ([Recovery](#recovery)).

**A cancel of a process that a cancel already ends joins that cancel.** A
timeout that comes during a cancel adds no second `SIGTERM` and no
second poll.

**`dispose()` waits for the full grace of each process, and the graces
run at the same time.** For each process, `dispose()` takes the same steps
as a cancel, and waits for the end for the grace and 5 seconds, with no
limit of 15 seconds. A step of the chain does not wait for an end, so
the cancels of one agent overlap. A device controller declares its grace and
gets it at `dispose()`. An agent with 4 processes that ignore `TERM`
takes about one grace and 5 seconds to cancel, and a grace of 300 seconds
holds `dispose()` for up to 305 seconds. The agents cancel in parallel.

**On just-bash, a cancel ends the command at once.** The simulated shell has
no signals and no `trap`. No trap of the command runs, the wrapper writes
no `exit`, and the state is the cause in `stop`.

## Recovery

**A new run of the host reads the table from the files.** Nothing moves
from memory to the files at a shutdown. A crash of the host loses no
process record.

**A live process of an earlier run is adopted when a read finds it.** The
table arms its timeout again from `startedAt` and `timeout` in `spec`. A
process past its timeout cancels at once. `cancel` and the timeout cancel it
through its pid: the table writes `stop`, and a script signals the
process group of the pid ([The cancel](#the-cancel)). The script signals the
group only when the group is not its own, so a backend that runs
commands in the host's group loses one shell and no more.

**An adopted process keeps the port of its `spec`.** A `spec` written before
ports has port 0. The process does not listen on a port of the workspace, and
`fetch` refuses it.

**A process of an earlier run that no shell runs is lost.** Its state is
`failed`, with the error `The host run ended before the process did.` The
first read that finds it with a `pid` writes `stop` for it. The reminder
names it once.

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
cancels them while the first run still waits on them. The journal fences
a second host of a room, and the process table has no fence. Stop one
run of the host before the next one starts over the same accounts.

## ps

**`ps` lists the caller's running processes.** It reads the caller's
table. Each line states one process, in the order the processes started.
The command shows its first line, cut to 80 characters.

```text
| Handle | Name | Port | Runs for | Command |
| --- | --- | --- | --- | --- |
| bash-3f9a2c1d0b7e | tests | 24817 | 2m 14s | npm test |
| bash-9c01d4e2aa31 | server-log | 21093 | 12s | tail -f server.log |

2 running processes.
```

**The `Port` column shows `$PORT` of each process.** A process that listens
on that port serves HTTP to `fetch`.

**A caller with no running process gets one line:** `No running
processes.` A finished process stays in the files, and `wait` with its
handle and `timeout: 0` reaches it.

## The host's view

**`workspace.processes` gives the host the processes of this run's
agents.** A host uses it to show a person what runs, and to cancel a process
that an agent left running. It adds no tool.

```ts
export interface WorkspaceProcesses {
  list(query?: { agent?: string; running?: boolean }): Promise<readonly Process[]>;
  subscribe(listener: (event: ProcessEvent) => void): () => void;
  cancel(handle: string): Promise<Process>;
}

export type ProcessEvent =
  | { readonly type: 'started'; readonly process: Process }
  | { readonly type: 'ended'; readonly process: Process };
```

**`list` reads the tables of the agents that used the workspace in this
run.** An agent joins that set on its first process tool call or
reminder. A `read`, `write`, `edit`, or `apply_patch` call adds no agent.
`running: true` gives the running processes alone.

**`list({ agent })` reads the table of the named agent.** It reads the files
of that agent even when the agent has not acted in this run, so the read
adopts the live processes of an earlier run. A new run of the host calls it
once for each agent that it follows, and it finds those processes before the
agent acts again. The agent joins the set of the run. A name that the backend
does not know rejects the call.

**`subscribe` gives one event when a process starts and one when it
ends.** It covers the processes of this run, and the adopted ones whose
end a read of this run sees. A listener that throws does not stop the
other listeners or the process.

**`cancel` cancels the process of any agent of this run.** It waits for the
end as the `cancel` tool does: the grace, up to 10 seconds, and 5 seconds.
A process that has not ended by then still reads `running`, and its cancel
goes on. The host reads the output of a process through
`workspace.use`, as the owner agent, at `Process.output`.

## Processes that serve HTTP

**Every process has a port.** The table picks it when `bash` starts the
command, and it writes the port into `spec`. The wrapper sets `PORT` to that
number in the environment of the command. A server that listens on `$PORT`
serves HTTP to the workspace. The kernel knows nothing else about the
server.

**The pick is random and belongs to the table.**

- **The range is 20000 to 29999.** The table picks a number at random.
- **The pick excludes the ports of the running processes that the table
  holds.** An agent runs at most 4 processes, so the range does not run out.
- **The pick does not test the machine.** Another program can hold the port.
  The server then fails with `EADDRINUSE`. The agent starts the process
  again, and the new start picks a new port.
- **A process keeps its port until it ends.** A cancel and a timeout free it.

**The agent sees the port in four places.** The command reads `$PORT`. The
`Port` column of `ps` shows it ([ps](#ps)). The state line of a running
process ends with `$PORT=<port>.`. The `details` of `bash`, `wait`, `ps`, and
`cancel` hold `port` as an integer.

**Many servers do not read `$PORT`.** The note of the process tools says so,
and it gives two forms: `vite --port $PORT` and `python3 -m http.server $PORT`.
The agent passes the number on the command line of such a server.

### Read a process with `fetch`

**`fetch({ process, path })` reads one path of a running process with GET.**
Any agent of the workspace can read the running process of any other agent,
by name or by handle. The workspace keeps the body as a snapshot, writes it
to `~/.fetch`, and returns the ref. [Workspace](workspace.md#read-a-process-with-fetch) states
the schema, the result, and the limits.

```ts
bash({ command: 'python3 -m http.server $PORT', name: 'docs', wait: 1 });
fetch({ process: 'docs', path: '/index.html' });
// Result: the status, the media type, the body, the export path, and a ref.
```

**`fetch` finds the process in the tables of this run.** A handle that the
table holds live resolves from memory, with no read of files. A name uses
the same list as `workspace.processes.list` with `running: true`. An agent
joins that list when it first acts in this run. After a restart of the host,
`fetch` finds a process of an agent once that agent has called a process
tool or received a reminder, or once the host has called
`workspace.processes.list({ agent })` for that agent.

**The host reads a process with `workspace.fetch(process, path, init?)`.**
It returns a `Response`. The host can use any method and any header, and the
workspace keeps nothing. The property exists when the bash backend has
`endpoints`. The host is trusted, so no rule limits its request.

### The forward

**One forward carries the requests of one process.** The cache of the
workspace (`process-fetch.ts`) opens the forward at the first request. It
opens it on the session of the owner agent, and it keeps it until the process
ends or the workspace disposes. A forward that fails to open is not kept,
so the next request opens it again. The `ended` event of the table closes the
forward of that process.

**The bash backend carries the forward through `endpoints`.** This contract
is separate from the `connect` method of the environment:

```ts
interface WorkspaceEndpoint {
  readonly url: string; // private HTTP root reachable by the host
  close(): Promise<void>;
}

interface WorkspaceEndpoints {
  readonly machine: string; // the machine where workspace commands run
  forward(
    agent: { readonly name: string },
    port: number,
    signal?: AbortSignal,
  ): Promise<WorkspaceEndpoint>;
}

// Optional property of BashBackend:
// readonly endpoints?: WorkspaceEndpoints;
```

**The workstation implements `endpoints` through SSH forwarding.**
`machine` is `WorkstationOptions.server`. The `port` argument is the port of
the process on the `127.0.0.1` of the workstation. It is an integer from 1 to 65535. `WorkstationOptions.port` is the SSH login port. The returned URL uses
a private loopback address of the host and a local port that the system
assigns. It holds no SSH credentials. The transport reuses the credentials
and the host-key check of the owner agent.

**The caller owns the open forward.** `forward` holds a reference to the
SSH session until `close` completes. Its signal cancels the opening and
releases partial resources. After success, the caller calls `close`, which is
safe more than once. An SSH disconnect, a forwarding failure, and a disposal of
the backend release the channels, the reference, and the local listener.

**OpenSSH must permit the forwarding.** The backend reports a refusal of
forwarding as an error. The example setup enables the loopback destination.
The tests cover both permitted and denied forwarding.

**A backend with no `endpoints` has no `fetch`.** The just-bash backends gain
no real network. The workstation backend carries the path from a process to
a reader.

**A port is not an identity.** A handle and a port do not prove that a
listener belongs to the process. The workstation shares one loopback network
between its accounts, so any account reaches any port with `curl`. `fetch`
adds no reach that `curl` lacks ([Trust](trust.md)).

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
Call wait with a list of handles, and timeout 0 to read at once. Call cancel with a handle. Call ps to list processes.
```

**Each line starts with the name when the process has one.** The handle
follows it. A process from another room names that room. A seat with no
process to name gets no process reminder. A summarize activation calls none.

**The core resolves the reminders once, at the start of an activation.** `ToolBundle.remind` returns the text, or a promise of it.
`describeExecutor` collects the reminders of the bundles into
`Executor.reminders`. The core runs them together when it renders
the record of the first pass of a respond activation. The text goes in the
context, before the ask line.

[Tool bundles](resources.md#tool-bundles) states the `ToolBundle`,
`Reminder`, and `ReminderSeat` contract.

**A reminder has 5 seconds.** A reminder that throws, rejects, gives
blank text, or takes longer gives no text, and the activation goes on.
At the bound the core aborts `signal`. The workspace reminder then
writes no `seen`, and a read that waits on a busy bash resource does not
start. The core does not cut a long reminder, so the bundle bounds its own
text.

**The core resolves on the first pass of the activation.** It resolves
when the pass has something to send.

- **Pi** reads the record after the position that a continued session read
  through. A continued session with no new message calls no reminder, and
  it reads the reminder before the delta.
- **Claude** and **Codex** read the whole view on the first pass.

**The process reminder reads the agent's table once.** It runs on the
bash resource. A bundle with skills first queues the copy of the
skills, which costs one more read when the copy matches
([Skills](skills.md#the-copy-in-the-home)). On the workstation, the read connects the agent's SSH
session at the start of the agent's first activation, and it creates the
agent's home on every backend.

**A reminder can mark a finished process as shown that no model read.**
An activation that fails between the reminder and its first request to
the provider loses that one notice. `ps` and `wait` still reach the
process.

## The end of a process

**No message wakes a seat when a process ends.** The agent reads the end.
`bash` and `wait` block until a process ends or their time ends, inside
the activation. A process that outlives the activation shows in the
reminder at the start of the seat's next activation. The guidance states
this rule to the agent. Codex's unified exec follows the same rule: the
model polls with `write_stdin`, and nothing wakes it.

**An agent waits for the result that its answer needs.** It calls `wait`
before it answers. `wait` returns when the first process in `handles` ends. A
wait stops 30 seconds before the room ends the activation, so one activation
can wait for a process for up to 570 seconds with the default lease deadline
of 600 seconds.

**The end of a longer process reaches the agent at its next activation.**
A message of a person or of another seat starts that activation. Until
then, the end stays in the files.

### The agent can come back later

**An agent schedules its own next activation.** It calls `schedule` with
`delaySeconds` before its activation ends. The room gives the say
back when it is due, and the returned say starts an activation for the
same seat ([Exchange](exchange.md#6-a-scheduled-say)). That activation
reads the process in its reminder, and `wait` with `timeout: 0` gives the output. When the
process still runs, the agent can schedule another say. The guidance
states this to the agent, and the result of a process past the reach of a
wait states it again.

**Each returned say costs one activation.** The room does not look at the
process before it returns the say.

### A host can wake the owner seat

**A host that wants a wake posts a message when a process ends.**
`workspace.processes.subscribe` gives an `ended` event. The host calls
`room.post` to the owner agent, under a key that names the handle. The system
message starts an activation, so the owner seat reads the end in its reminder, and
`wait` with `timeout: 0` gives the output. The kernel adds nothing else for this.

```ts
workspace.processes.subscribe((event) => {
  const { handle, name, agent, state, room: started } = event.process;
  if (event.type !== 'ended' || started !== room.name) return;
  room
    .post({
      to: agent,
      text: `lab: process ${name ?? handle} is ${state}. Call wait with ${handle} and timeout 0 for its output.`,
      key: `process-ended:${handle}`,
    })
    .catch((error: unknown) => log.error(error));
});
```

**The post writes a system message**
([Exchange](exchange.md#7-the-edges-a-host-sees)).

- It opens an exchange when none is open. That exchange has no `person`
  until a person speaks in it, so it owes no summary. When an exchange is
  open, the system message joins it and steers the seat of the owner agent alone.
- The owner agent must hold a seat in that room. The room refuses a system message
  to an agent in the reserve, and `post` rejects. A stopped room rejects too,
  so the host catches each post.
- The key makes a second post of one end land once, for example after a
  restart of the host.
- A process of an earlier run ends in a read. A host that bridges its
  ends calls `workspace.processes.list()` on an interval, so a read sees
  them. `list` reads the agents that acted in this run. `list({ agent })`
  reads that agent even when it has not acted in this run, and the read
  adopts its live processes. A host that restarted calls it once for each
  agent, so it finds a process of an earlier run. A process that ended
  while no host ran gives no event, and the reminder names it.
- `Process.room` names the room of the `bash` call, so a host with
  several rooms posts each end to the room that started the process.

## Life and disposal

**A process outlives the call, the activation, and the exchange that
started it.** An abort of the `bash` call stops the call's wait. The
process keeps running until it ends, it times out, the owner agent or the
host cancels it, or the workspace disposes.

**`wait` gives the state when the process ends or when the time ends.** A
process that is still running gives `running`. An abort of the call stops
the wait, and the process keeps running.

**`wait` with one handle and `timeout: 0` reads the process.** The call does
not wait. It gives the state of the process and its new output, the output
after the last result for it, and a process that ended badly fails it.

**`wait` returns when the first process in `handles` ends.** It takes 1 to 16
handles, and counts a handle that repeats once. For one process, the result is
the state and the new output of that process. For several, the result gives the new output and the
bracketed line of each process that ended, then the bracketed line of each one
that still runs, within a budget. `details.processes` holds every state in
the order of the handles, and `details.ended` holds the details of each
process that it shows.

**The schema of `wait` states the bounds of `handles`.** It sets `minItems`
to 1 and `maxItems` to 16, so the model reads them. A call outside them, or a
call with `handle` in place of `handles`, fails. The harness sets the text
that the model reads:

| Harness | Who refuses the call                | What the model reads                                                        |
| ------- | ----------------------------------- | --------------------------------------------------------------------------- |
| Pi      | The harness, before the tool runs   | The validation text of Pi                                                   |
| Claude  | The Agent SDK, before the tool runs | The validation text of the SDK                                              |
| Codex   | `defineTool`, in the host           | `Invalid arguments for tool 'wait': must have required properties handles.` |

The Codex text above is for the call with `handle`. A call with no handles
gives `handles must not have fewer than 1 items` after the colon. The trace
holds each refused call as a `tool_call` step and a `tool_result` step with
an `error`, on each harness.

**A wait on several handles bounds its output.** It shows the processes that
ended in the order of the handles, until its text holds 50 KB. One view holds
at most 50 KB, so a result holds at most about 100 KB. Each process after that
gives its bracketed line and `Its new output did not fit this
result: call wait with its handle and timeout 0 to read it.` The wait does not read
the output of that process, so its cursor stays, and a `wait` with `timeout: 0`
gives the output.

**A process that already ended makes `wait` return at once.** An agent
that runs a parameter sweep as four processes calls `wait` with the four
handles, reads the result of the first that ends, and calls `wait` again
with the handles that still run. The last line of the result names each
handle that ended: `Drop <handles> from handles: they have ended, and a wait
that holds one returns at once.` The description of `wait` states the same
rule. A handle of a process that ended badly fails each `wait` that holds
it.

**A wait ends 30 seconds before the room ends the activation.** The room
ends an activation `limits.lease.deadline` after its first claim, 600
seconds by default, and counts it as a failed attempt. `ToolContext.deadline`
carries that time. `bash` and `wait` wait for the shorter of the time the call
gives and the time left before the margin. A process that still runs then
gives `running`, and the result line adds `The wait stopped early, because
your activation ends in <n> seconds. Answer before then.` When the process
runs past the reach of a wait, the note of a scheduled say follows. The margin also
covers the skew between the clock of the room's host and the clock of the
seat's host.

**`cancel` cancels the process and waits up to 15 seconds for it to end.**
The state becomes `cancelled`, or `exited` for a command that ended inside
the grace ([The cancel](#the-cancel)). A process that has not ended after 15
seconds still reads `running` with `stopping: true`, for example when its
grace is 30 seconds. Its cancel goes on, and a later `wait` with `timeout: 0` gives its end. A
`cancel` of a process in a final state gives that state again.

**A shell that outlives its run becomes adopted.** A process can outlive
a `SIGKILL`, for example in an uninterruptible wait. When its run ends while its
shell still runs, the table adopts it. The host's one `ended` event for
it comes when a read sees its end.

**`dispose()` cancels every running process of this run, and every adopted
one.** The bash resource refuses new work and drains its queue. The table
then refuses new processes and cancels each running process, each one with
its full grace and the slack. All the processes cancel at the same time,
whatever their agent. The bash backend then disposes. The git resource
disposes after the bash resource, so a push in a process still reaches the
git backend.

## Backends

| Backend              | While the process runs                       | Cancel and timeout                                            |
| -------------------- | -------------------------------------------- | ------------------------------------------------------------- |
| `memoryBackend`      | `out` stays empty until the process ends     | The process ends at once, no trap runs, and `out` stays empty |
| `directoryBackend`   | `out` stays empty until the process ends     | The process ends at once, no trap runs, and `out` stays empty |
| `workstationBackend` | The output reaches `out` as the command runs | `SIGTERM`, the grace, then `SIGKILL`; `out` keeps the output  |

**A just-bash backend has no endpoints.** Its workspace has no `fetch`
tool and no `workspace.fetch`. A process of that backend still gets `$PORT`.

**just-bash has no `ps` and no `kill`.** A just-bash process runs in the
host's process, so no process outlives its run, and the listing finds no
live shell.

**Adoption on the workstation needs the `ps` of procps.** The listing
runs `ps -ww -o args= -p`, and the cancel runs `ps -o pgid= -p`. The
BusyBox `ps` of an Alpine image refuses `-p`. On such a server, a live
process of an earlier run reads as lost, and nothing cancels it.

**A workstation process holds an environment over the agent's SSH
session.** The session stays open while any environment is open over it
([Workstation](workstation.md#the-ssh-client)).

**On just-bash, every home is readable.** Another agent can read the
files of a process with `read` or `bash`. The wall between agents is the
workstation's Unix accounts.

## The audit log

**Each call of the four tools has one audit entry.** The entry runs on the
bash resource after the call ends. The entry of a `bash` call holds the state at
the end of the call, which can be `running`. A call that fails on a process
that ended badly records `error` with the name `ToolFailure` and the `details`
of its result: the `Process`, and for `wait` on several handles, every
status. A `bash` call that an abort cuts while it waits records an error with
no handle, and the process keeps running. The reminder and `ps` name it. The
files of a process are its record.

## The guidance

**`openWorkspace` adds one note about the process tools after the files
note.** The two `$PORT` lines belong to the note on every backend. A backend
with no endpoints has no `fetch`, and the lines still state `$PORT`.

```text
bash starts each command as a background process and returns its handle.
Give a long-running process a name, so you can tell your processes apart.
Each process has a directory, ~/.processes/<handle>/, with its spec, its exit code when it ends, and out, its whole output. Read out with read.
ls ~/.processes lists every process you started that the workspace still keeps.
The workspace sets $PORT for each process. A server that listens on $PORT can be read with fetch.
Many servers do not read $PORT; pass it, as in vite --port $PORT or python3 -m http.server $PORT.
A process keeps running after your activation ends, until its timeout.
No message tells you when a process ends. When your answer needs the result, call wait before you answer.
A wait stops before your activation ends.
A process that outlives your activation shows in the reminder at the start of your next activation.
To check a long process later, call schedule with delaySeconds. The room wakes you with it then.
```

## Out of scope

**A process has no link to the life of an activation, an exchange, or a
room.** An exchange closes when no activation is live, so a cancel at the
close ends a process at the first quiet moment. `bash` is the one kind
of process.

**A new kind adds three parts.** It adds a name to `ProcessKind`, a
runner that writes the same files, and a tool that starts it. The table,
the handle format, the files, `ps`, the host's view, the reminder, and
the two handle tools stay as they are.

## Decisions taken

| Decision                                                        | Reason                                                                                               |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| The files of the bash backend are the source of truth           | A new run reads the same table, and a crash loses no record                                          |
| An agent reaches its own processes alone                        | Its table is its home, and the workstation's accounts make it the wall                               |
| A lost process reads `failed`                                   | It left no end, and nothing runs it                                                                  |
| The first read of a lost process with a pid writes its `stop`   | A later listing runs no `ps` for a process that nothing runs                                         |
| The lost `stop` skips `ps` only for a pid gone from `/proc`     | A `ps` that fails once does not hide a live shell, and the skip starts no program                    |
| The host's list covers this run's agents, and a named agent     | The workspace keeps no roster, and a name reads the files of an agent that has not acted yet         |
| The reminder resolves once per activation, and can read I/O     | Every render of one activation reads the same text                                                   |
| The table holds the timeout, and adopts a live process          | A cancel goes through the cancels of its agent, in every run                                         |
| A cancel writes no `stop` after `exit`                          | A command that ended reads its own end, whatever cancel came late                                    |
| The default timeout is 600 seconds, and the agent can raise it  | An adopted process needs a bound from its spec                                                       |
| A name is a label, and the handle is the key                    | Two processes can have one name with no rule for which one a call takes                              |
| Every process gets a port in `$PORT`                            | A server needs no flag, no registration, and no output line to be read; the workspace knows its port |
| `fetch` sends GET alone                                         | A request that asks a process to act needs a tool of its own                                         |
| `ps` writes an audit entry                                      | The audit log records every tool call                                                                |
| A process wakes no seat, and the agent waits for its result     | The kernel adds no wake source for the end of a process, and a host that wants one calls `room.post` |
| The agent comes back to a long process with a scheduled say     | The room keeps one clock, and the agent chooses when to look again                                   |
| A cancel sends `SIGTERM`, waits the grace, then sends `SIGKILL` | A process gets time to clean up. The `bash` call sets the grace, 10 seconds by default               |
| The grace goes in `spec` and in the options of `exec`           | An abort signal carries no time, and an adopted process keeps the grace of its own call              |
| The workstation host holds the timer of the grace               | No channel stays open for the grace, and `SIGKILL` goes only to a command that still runs            |
| `cancel` waits for the end, up to 15 seconds                    | A cancel gives the final state of a `bash` process, and `stopping` lets a longer grace return early  |
| A command that exits inside the grace reads its exit code       | The code is the command's own answer, and exit 0 says that it cleaned up                             |
| Code 143 after a cancel reads the cause in `stop`               | The `SIGTERM` ended that command, and the command chose no end                                       |
| The timeout and the backend's deadline end with the grace too   | Every cancel takes one path                                                                          |
| `dispose()` gives each process its full grace, all at once      | A device controller gets the grace that it declared, and the shutdown waits for the longest grace    |
| No cancel waits for an end on the chain of its agent            | A cancel with a grace of 300 seconds holds no later cancel or timeout of the agent                   |

**The host owns the cleanup of `~/.processes` past the limit of 64.** A
start removes the oldest finished processes of the agent that starts it,
the seen ones first.
An agent that starts no process keeps its directories.
