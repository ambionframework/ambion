# Workbench

**Workbench is an agentic lab workbench for a toy Arduino kit.** People and
specialized agents share one project. A person asks a question, and the
agents read the datasheets, choose parts, and plan tests, on the record.

Workbench is the runnable example for the Ambion collaboration kernel. See
the root [README](../../README.md) for what Ambion is.
[docs/example.md](../../docs/example.md) holds the people, the tool set, the
rooms, the lab database, the kernel map, and the evidence. This page holds the
run commands and the terminal.

**The git backend holds three templates.** They are `firmware-sketch`,
`sensor-server`, and `actuator-controller`. The [sensor](docs/sensors.md) and
[actuator](docs/actuators.md) pages describe the last two.

## Run

**One command starts the rooms and the terminal in one process.** The rooms
run while the terminal runs. When you quit, the host ends your visit and
closes the rooms. The journals and the room rows stay on disk.

From the repository root, install and build with Node 26.4 or later:

```sh
pnpm install
pnpm build
cd examples/workbench
export ANTHROPIC_API_KEY=...   # Pi and Claude seats
export CODEX_API_KEY=...       # Codex seat
pnpm start                  # uses ./.data
pnpm start ./bench --as mira   # a directory, and a person
```

**The host keeps the root rooms on one canvas.** The canvas stores one row
for each room in `rooms.db`, beside the journals. It owns the name, the
goal, the seats, and whether the room runs. At the start it resumes each
running room and attaches the room mirror, and at the close it stops the
rooms. A stopped room has a stopped row, and a restart leaves it stopped. A
failed stop leaves the room stopped. The `/resume` command starts it again
from its journal. The host keeps the feed, the composer, and the scenarios.
The answer of a person to an approval stays a room message.

`pnpm start` runs Node with `--experimental-ffi`, which OpenTUI needs. A
directory with no `rooms.db` gets the four sample rooms and the datasheets.
A directory that has one resumes the rooms that ran, including a room you
created. A room you stopped stays stopped until you resume it. Set `WORKBENCH_USER` instead of `--as` to pick a
person. Without either, the first screen asks who you are. Set
`AMBION_MODEL` and its provider credential to change the model of the Pi
seats. The default is `anthropic/claude-sonnet-5`. `AMBION_EXECUTOR=codex`
moves the assistant to Codex, and any other value leaves it on Pi.

**A seat with no key does not run, and the others do.** At start, the
Workbench prints one line for each seat whose executor kind has no key. The header
of the terminal marks that seat with `no key`. An activation of that seat
fails at once with the name of the missing variable, and the room keeps
running.

**A closed exchange with no reply says why.** When the room gave up on a
reply, the line under the exchange names the seat, whether the room
retried, and the reason, as in `Closed, assistant failed, the room does
not retry this: 400 invalid_request_error: You have reached your specified
API usage limits.` The reason comes from the trace, so a restart loses it.
A spent credit, quota, or usage limit fails once. A rate limit or a server
error retries to the cap.

The terminal reads its colors from the repository brand kit in the root
[`brand/`](../../brand) directory. The example has no HTTP interface.

## The terminal

**The composer is the control surface.** The chip in front of the input
shows the room that receives your message. Type `/` to see the commands, or
press Ctrl+R to pick a room.

| Command                | Effect                                                |
| ---------------------- | ----------------------------------------------------- |
| `/room <name>`         | Switch to another room                                |
| `/new <name> [goal]`   | Create a room. Without a goal, the composer asks      |
| `/user <person>`       | Act as another person                                 |
| `/files`               | Search the workspace files in a side panel            |
| `/open <path>`         | Open the files panel on one file                      |
| `/ps`                  | Show the background processes of the agents           |
| `/attach <local path>` | Copy a local file into the workspace, ref it next     |
| `/try`                 | Fill the composer with the room's suggested prompt    |
| `/cancel`              | Cancel the open exchange                              |
| `/dismiss <n>`         | Dismiss the say n that waits to return                |
| `/stop`, `/resume`     | Stop the room, or start it again                      |
| `/steps [n]`           | Show the steps of the newest activation of exchange n |
| `/expand`, `/collapse` | Open or close every discussion                        |
| `/help`, `/quit`       | Show the commands and keys, or leave                  |

`/cancel` runs at once. Typing the command is the confirmation. Switching
person leaves the current room, then enters it as the new person.

**A say that waits to return shows as a note.** An agent calls `schedule`
with `delaySeconds`. The conversation notes the say with its seat, its due time,
its owner, its text, and its seq, as in `(/dismiss 41)`. `/dismiss `
lists the says that wait. `/dismiss 41` calls `room.dismiss`, and the
agent does not come back to the say. The say in its discussion then reads
`dismissed` in place of its return time.

| Key                   | Effect                                                           |
| --------------------- | ---------------------------------------------------------------- |
| Enter                 | Send                                                             |
| Ctrl+J, Alt+Enter     | Add a line to the message                                        |
| Tab                   | Complete a command, or browse the discussions                    |
| Up, Down, Enter, e, c | While browsing: choose, open or close, open all, close all       |
| s                     | While browsing: show the steps of the chosen exchange            |
| r                     | While browsing: choose a ref of a shown message                  |
| a                     | While browsing: take the actions of the pinned widgets           |
| Up, Down, Enter, Esc  | In the actions: choose, press or send, leave                     |
| Up, Down, Enter       | While choosing a ref: move, open it, or jump to it               |
| Esc                   | Close the palette, clear the search, or close the panel          |
| PageUp, PageDown      | Scroll the conversation                                          |
| Type, Up, Down        | In the files panel: search, and choose a file to read            |
| PageUp, PageDown      | In the files panel: scroll the file                              |
| Ctrl+Y                | In the files panel: copy the file to the clipboard               |
| Up, Down, j, k        | In the processes panel: choose a process                         |
| PageUp, PageDown      | In the processes panel: scroll the output                        |
| x, then x             | In the processes panel: cancel the chosen process                |
| X, then X             | In the processes panel: cancel the running processes of its room |
| Ctrl+Y                | In the processes panel: copy the output to the clipboard         |
| Esc, q                | In the processes panel: close the panel                          |

The files panel renders Markdown files with headings, lists, and code. It
shows a SQLite database (`.db`, `.sqlite`, `.sqlite3`, up to 8 MiB) as tables,
with the first 50 rows of each. The panel opens the database read-only. It
shows a picture (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, up to 8 MiB) with
OpenTUI's own terminal image rendering, negotiated to the terminal's protocol.

**An agent pins a file with `show`.** The call is `show({ name, kind,
source: { type: 'file', path }, title? })`. The kinds are `markdown`, `table`
(a SQLite database file), and `image`. The terminal draws the pinned files of
the open room in a side area, one after the other, each with its title or
name and its kind. `hide` removes a pin.

- **The host reads each file as its author,** with the size limits of the
  files panel, and it checks the size again on the bytes that it reads.
- **It reads again** after each widget event, each room start, and the end of
  each activation. It polls nothing.
- **The area draws four pins at most** and says `and N more`. It marks a
  stopped room, whose files stay as last read. A widget of an archived
  breakout room draws nothing.
- **The area draws text as text** and drops terminal escapes. It gives way to
  the files panel and the processes panel.

**A pin can carry actions.** `show` also takes `actions` and `for` on these
kinds. The side area draws each action as a button under its pin, and it
shows `for` as `for mira`. A widget that holds an answer reads `answered by
<person> in #<seq>`, and its once actions read as done. Press Tab, then `a`,
to take the keys. Up and Down choose an action, Enter presses it, and Esc
leaves. An action with fields opens a form: type into a text or number field,
press Space or Left and Right to change a boolean or a choice, and press
Enter to send. The form checks the values and shows the first problem before
it sends. The press reaches the room as a message of you, and the agent that
wrote the pin answers it.

- **A press calls `canvas.act` as the person** through `Workbench.act`. The
  host saves the act of each call, with its press token, until the call gives
  a result. After a failure, the next press of the same action sends that act
  again as the same person, so a press lands once.
- **A refusal drops the act** and shows its reason alone. A `stale` result
  redraws the new revision, and an `answered` result shows a line.
- **A button is inactive,** with the reason, when `for` names another person
  or the room is stopped.
- **The host reads the pins again on the `widget` event,** and it adds the
  answer to the pins on the `answered` event with no new file read.
  [Camera Chat](../camera-chat/README.md) reuses `ActionPad` and
  `ActionsView` for the `look` action of its viewfinders.

**`/ps` shows the background processes that the agents started with
`bash`.** The panel lists the running processes first, then the newest
start. Each row gives the name or the handle, the owner agent, the state,
and the command. The chosen process shows its room, its whole command, and
the last 65,536 characters of its output. A start or an end of a process reads
the list again, and the slow poll updates the times.

- **The list holds the agents of this run.** An agent joins it on its first
  process tool call or reminder ([Processes](../../docs/processes.md#the-hosts-view)).
- **The just-bash backend writes the output when the command ends.** A
  running process shows `No output yet.`
- **The panel reads an output file up to 1 MiB.** A larger output shows
  its size and its path. The agent's `wait` tool with `wait: 0` reads the end of any size.
- **The first `x` chooses the process, and the second `x` cancels it.** The
  cancel waits for the process to end up to the grace of its
  call, 10 seconds at most, and 5 seconds more. The file reads of
  the terminal do not wait for it.
- **The first `X` names the room, and the second `X` cancels every running
  process that the room started.** The processes of other rooms keep running.

`/attach <local path>` reads a file from your own machine and copies it into
the workspace, under `/attachments`, and snapshots it. It cites the snapshot
as a ref of your next message. A colleague opens the same file with `/open`, and an agent's `read`
tool returns it as a picture, not text. The command takes files up to 8 MiB.
`~/` in the path expands to your home directory.

**Pasting a picture's path into an empty composer fills `/attach` for you.**
The terminal reads a paste as one block, through bracketed paste, so it can
tell a paste from typing. A paste that is one line, holds no space, starts
with `/` or `~/`, and ends in a picture's extension becomes
`/attach <path>` instead of landing as message text. Pasting into a message
already underway, or a paste that does not look like one bare picture path,
lands as typed.

**A message shows its refs, one line each.** A line starts with `↗` and the
kind of the ref: `snapshot`, `commit`, `file`, `table`, `room`, or
`message`. A ref that does not resolve starts with `✗` and ends with the
reason. Press Tab, then `r`, to choose a ref of a shown message. Tab works
on a direct reply too, which has no discussion. Esc goes back. `r` lists
only the refs of shown messages, so press `e` to open every discussion
first.

| Form                                                                  | Names                                                 | Enter opens                                            |
| --------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------ |
| `ambion://workspace/workbench/snapshot/<digest>/<path>`               | The bytes a file held at a snapshot, from the store   | The preview in the files panel                         |
| `ambion://workspace/workbench/repo/<repo>[/branch/<b>]/commit/<hash>` | One commit of a lab repository                        | The commit in the files panel                          |
| `file:///<path>`                                                      | A file of the workspace as it is now, as `/library/x` | The file in the files panel                            |
| `lab:///<table>`                                                      | A table of the lab database                           | The table in the files panel                           |
| `ambion://room/<room>`                                                | A room of this Workbench                              | The room, at the composer                              |
| `ambion://room/<room>/message/<seq>`                                  | A message of a room of this Workbench                 | The room, with the discussion open and the message lit |

The agents cite these forms in `refs`. The `snapshot` tool gives a snapshot
ref, and an agent writes a commit ref from `git rev-parse`.

**A snapshot opens through `readSnapshot`, from the object store.** Its line
shows the path the file had and the first digits of its digest. The panel
shows text as text, a picture as a picture, and a SQLite database as its
tables. A binary file shows its size, and an agent reads it with `restore`.

**A commit opens through `readCommit`, from the lab repositories.** Its line
shows the repository, the branch or the tag, and the first digits of the
hash. The panel shows the log entry: the hash, the author, the date, the
parents, the message, and each changed file as `A`, `M`, or `D`. When the
ref names a branch or a tag, the last line states where it points now. A moved or deleted
branch keeps the commit, so the ref still opens.

**The terminal checks each ref against what the host holds.** A file, a
table, and a snapshot must be of this workspace, a commit of the
`workbench` workspace, and a room of this Workbench. The terminal reads no
file of the host. A path with `..`, an empty part, a backslash, or a host
name does not resolve. The files panel lists the lab tables after the
files.

A discussion is the thread between a question and its summary, with each
steering message in its place. It starts closed. Start a message with `//` to
send a leading slash, as in `//library/led-5mm.md`.

**The terminal shows the work behind an answer.** Each of these reads from
the record, so a restart keeps them.

- **Cost.** A discussion shows what its exchange spent: dollars when the
  provider reports a cost, else a token count.
- **Steps.** `/steps` or `s` on a chosen discussion shows the passes and steps
  of the newest activation of an exchange that ran. The host keeps the steps that its
  logger receives, in memory, for the latest 200 activations. A running
  activation shows the steps so far and reads again on each step. A restart
  loses the steps.
- **Awaiting.** An exchange that ends on a message to a person shows
  `Waiting on <person>`. That person also sees a note and a status line.
- **Approval.** An operation above an instrument limit shows to the owner of
  the exchange with its id. The owner answers in the room, and the agent
  records the answer with `approve_operation`.

## The team

**One assistant coordinates three specialists, and the seats run on three
executor kinds.** [docs/example.md](../../docs/example.md#the-assistant-and-the-specialists)
states the scope of each specialist.

| Agent           | Kind   | Model                              | Key                 |
| --------------- | ------ | ---------------------------------- | ------------------- |
| **Assistant**   | Pi     | `anthropic/claude-sonnet-5`        | `ANTHROPIC_API_KEY` |
| **Datasheets**  | Pi     | `anthropic/claude-sonnet-5`        | `ANTHROPIC_API_KEY` |
| **Design**      | Claude | `claude-sonnet-5`                  | `ANTHROPIC_API_KEY` |
| **Experiments** | Codex  | `gpt-5.6-luna`, reasoning `medium` | `CODEX_API_KEY`     |

The `seatKinds` table names the kind of each seat, the assistant included.
The `executor` function of the assistant builds the executor of that kind.
The header of the terminal shows the executor kind beside each agent name.

`src/rooms.ts` passes a list of three executions, one for each executor
kind. Each execution checks keys, sets the environment, and lets a test
script an executor. Every host supplies the execution for each kind through
the room or runtime. The seats hold one list of bundles. See
[the tool set](../../docs/example.md#one-tool-set-one-filesystem-no-native-tool).

**The assistant delegates to a breakout room that specialists staff.** A
breakout room is named `<parent>-<name>`. The room list shows it with its
parent, and `/room` completes it with `breakout of <parent>`. A person
visits it as any other room. A restart resumes the breakout rooms that ran,
and replays the notices that no journal holds. The assistant archives the
breakout room when the work is done. See [the canvas](../../docs/canvas.md).

## Tests

**The scripted tier needs no key and no network.** Run it with
`pnpm --filter @ambionframework-examples/workbench test`. The tests give the
Pi seats a scripted model stream. They give the Claude and Codex seats a
scripted execution from `@ambionframework/ambion/testing`.

**The live tier runs each scenario on the real executors.** Run it with
`pnpm --filter @ambionframework-examples/workbench test:live`. It costs money.
A scenario skips when an executor kind that it uses has no key: the `bringup`
scenario needs `ANTHROPIC_API_KEY`, and the `sensing` scenario needs
`ANTHROPIC_API_KEY` and `CODEX_API_KEY`.

## The workspace

**The on-disk layout of the shared workspace.**

```text
.data/
  rooms.db          Room journals, Pi audits, and the canvas rows
  lab.db            The shared database of the sql tool: the lab records
  git.db            The repositories: the firmware-sketch template and every fork
  workspace/
    library/        The datasheets, copied from examples/workbench/library
    shared/         kit.md and notes.md, the team's artifacts
    home/           Agent home directories
```

## What persists

**Room journals and workspace files have separate owners.** Each room has its
own journal. All rooms share one workspace resource. A deliberately stopped
room stays stopped across a restart. The host restores previously running
rooms with the same definitions.

The terminal sends each message with a key. A retry uses the same key, so a
lost acknowledgement adds no duplicate message. This does not make tool
effects exactly once: SQLite records and file changes are not one
transaction.

## Restart

1. Send a message and wait for its acceptance.
2. While an agent works, quit with `/quit`, or stop the process.
3. Run `pnpm start` with the same directory.

A crash writes no departure. A reconnecting visit restores the visit without
another arrival. The default lease expiry is 60 seconds, so lost local work
can pause before it continues.

The person picker is a local convention, not authentication. A deployed
application must authenticate people and control access to rooms and
workspace resources.
