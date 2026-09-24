# Bash and jobs

**`bash` starts every command as a background job.** The call returns a
handle for the job. The `status`, `wait`, and `cancel` tools take that
handle. The whole output of the job goes to a file in the agent's home.
Every workspace has these four tools, on every bash backend.

**`@ambionframework/workspace` implements this page.** The job table is
`packages/workspace/src/jobs.ts`, and the four tools are
`packages/workspace/src/job-tools.ts`. The room and the journal do not
change: a job is workspace state, and the journal holds no entry for it.
[Workspace](workspace.md) states the owner and the backends that a job
runs on.

**A handle can name more kinds of background work later.** `bash` is the
one kind today. The three handle tools read the kind from the job table,
so a new kind adds a runner and no new tool
([Kinds of job](#kinds-of-job)).

## The four tools

| Tool     | Parameters                     | What it does                                                     |
| -------- | ------------------------------ | ---------------------------------------------------------------- |
| `bash`   | `command`, `timeout?`, `wait?` | Starts a job, waits up to `wait` seconds, and gives its state    |
| `status` | `handle`                       | Gives the state of the job and the end of its output             |
| `wait`   | `handle`, `timeout?`           | Waits up to `timeout` seconds for the job to end, then as status |
| `cancel` | `handle`                       | Stops a running job, waits for it to end, then as status         |

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

## The result

**Each result is the end of the output, then one bracketed line.** The
line states the job, its handle, and its output file. A job that ended
with no output shows `(no output)`.

```text
/home/writer
slab pour Thu

[Job bash-a68e2a3f5863 exited with code 0. Output: /home/writer/.jobs/bash-a68e2a3f5863.out.]
```

```text
compiling 14 of 120

[Job bash-3f9a2c1d0b7e is running. Output: /home/writer/.jobs/bash-3f9a2c1d0b7e.out. Call status, wait or cancel with its handle.]
```

| State       | The bracketed line                                 |
| ----------- | -------------------------------------------------- |
| `running`   | `Job <h> is running. ... Call status, wait or ...` |
| `exited`    | `Job <h> exited with code <n>.`                    |
| `timed_out` | `Job <h> timed out after <timeout> seconds.`       |
| `cancelled` | `Job <h> is cancelled.`                            |
| `failed`    | `Job <h> failed: <message>.`                       |

**The view keeps the last 2000 lines or 50 KB.** These are the limits of
Pi's `bash` tool. When the view cuts the output, the bracketed line adds
`The text above is the last <n> lines, <size> of <total>.` The agent reads
the rest from the output file with `read`, which takes an offset and a
limit.

**`details` holds the job's status and the truncation.** `details.job` is
a `JobStatus`: the handle, the kind, the command, the state, the output
path, the timeout, the start and end times, and the exit code or the
error.

**A `bash` call fails when its job ends inside the window with a failure.**
The failures are an exit code other than 0, a timeout, and a fault of the
backend. These are the cases in which Pi's `bash` tool fails. The error
text is the result text, so it names the handle. `status`, `wait`, and
`cancel` give every state as a result, and they fail only on an unknown
handle or an invalid value.

## The job

**A job runs on an environment of its own.** The job table connects it
through the bash backend, outside the queue of the bash owner. A long
job holds no tool call of any agent. The environment is cleaned up when
the job ends.

**`bash` starts its job as one operation on the bash owner.** The start
comes after every earlier operation on the owner, so a `write` and then a
`bash` that reads the file stay in order. The start creates `~/.jobs` and
an empty output file, and then connects the job's environment.

**After the start, the backend's filesystem orders a job against other
work.** A job and a later `write` of the same agent can interleave. The
owner gives no order between them.

**The command runs as a group with its input and output redirected.**

```sh
{
<command>
} < /dev/null > '<home>/.jobs/<handle>.out' 2>&1
```

The command stands on lines of its own, so a comment or a here-document
at its end does not reach the brace. Standard input is empty. The shell
can write before the redirect applies, for example on a syntax error. The
job table adds that output to the end of the file, up to 16 KB.

**Each tool reads the end of the output file as one more operation on the
bash owner.** No tool holds the owner while it waits for a job. A file up
to 200 KB is read whole. A larger file is read with `tail -c`, so a large
output does not reach the host whole.

**The state of a job comes from the backend's result.**

| Result of `exec`            | State       |
| --------------------------- | ----------- |
| An exit code                | `exited`    |
| The error code `timeout`    | `timed_out` |
| The error code `aborted`    | `cancelled` |
| Any other error, or a throw | `failed`    |

## Handles

**A handle is `<kind>-<12 hex digits>`.** An example is
`bash-3f9a2c1d0b7e`. The output file has the handle as its name.

**A handle names one job of one agent.** A `status`, `wait`, or `cancel`
call from another agent does not find the job. The call fails with
`You have no job <handle>.` On the workstation, the output file is also
in the agent's own account.

**The job table keeps its state in the host's memory, for the life of the
workspace.** A restart of the host loses the table and every handle. The
output files stay on the filesystem.

**The table bounds the jobs of each agent.**

- **4 running jobs.** A `bash` call past that fails, and tells the agent
  to wait for a job or to cancel one. On the workstation, each running
  job holds one channel of the agent's SSH client, and OpenSSH allows 10
  channels on one client by default
  ([Workstation](workstation.md#the-ssh-client)).
- **64 finished jobs.** A new job makes the table forget the oldest
  finished job past that number. The table removes the job's output file
  in the same operation.

## Wait and cancel

**`wait` gives the state when the job ends or when the time ends.** A job
that is still running gives `running`. An abort of the call stops the
wait, and the job keeps running.

**`cancel` aborts the job and waits up to 10 seconds for it to end.** The
backend's abort path stops the command, and the state becomes
`cancelled`. A `cancel` of a job in a final state gives that state again.

**The job table stops the jobs of one agent one at a time.** An abort on
the workstation opens a channel of its own. A stop waits for the stops of
the same agent before it, so two stops never hold two abort channels on
one client.

## Life and disposal

**A job outlives the activation and the exchange that started it.** An
abort of the `bash` call stops the call's wait. The job keeps running
until it ends, it times out, or an agent cancels it.

**`dispose()` stops every job before the bash backend releases its
handles.** The bash owner refuses new work and drains its queue. The job
table then refuses new jobs, stops every running job, and waits for each
one to end. The bash backend then disposes. The git owner disposes after
the bash owner, so a push in a job still reaches the git backend.

## Backends

| Backend              | While the job runs                              | Cancel and timeout                                                     |
| -------------------- | ----------------------------------------------- | ---------------------------------------------------------------------- |
| `memoryBackend`      | The file stays empty until the job ends         | The job ends, and its file stays empty                                 |
| `directoryBackend`   | The file stays empty until the job ends         | The job ends, and its file stays empty                                 |
| `workstationBackend` | The output reaches the file as the command runs | The process group gets `SIGKILL`, and the file keeps the output so far |

**just-bash writes a redirect when the group ends.** Its commands run in
the host's process, so `status` on a running job there shows no output
yet.

**A workstation job holds an environment over the agent's SSH session.**
The session stays open while any environment is open over it. The idle
timeout starts when the last one is cleaned up
([Workstation](workstation.md#the-ssh-client)).

## The audit log

**Each call of the four tools has one audit entry.** The entry runs on
the bash owner after the call ends. The entry of a `bash` call holds the
state at the end of the call, which can be `running`. The end of a job
has no entry of its own. The output file is its record.

## The guidance

**`openWorkspace` adds one note about the job tools after the tool
line.**

```text
bash starts each command as a background job and returns its handle, such as bash-1a2b3c4d5e6f.
The call waits up to wait seconds, 10 by default, and then gives the state of the job and the end of its output.
The whole output of a job goes to ~/.jobs/<handle>.out. Read it with read.
status, wait and cancel take a handle. status gives the state of the job, wait waits for it to end,
and cancel stops it. A job stops after timeout seconds, 600 by default.
```

## Kinds of job

**A new kind adds three parts.** It adds a name to `JobKind`, a runner
that gives a final state, and a tool that starts it. The job table, the
handle format, the output file, and the three handle tools stay as they
are. [Backlog](../planning/backlog.md#designs-with-a-shape) holds the
kinds and the notice that wait for a condition.
