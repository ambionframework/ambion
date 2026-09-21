# Workbench

**Workbench is an agentic lab workbench for a toy Arduino kit.** People and
specialized agents share one project. A person asks a question, and the
agents read the datasheets, choose parts, and plan tests, on the record.

Workbench is the runnable example for the Ambion collaboration kernel. See
the root [README](../../README.md) for what Ambion is. The full lab design
is in [docs/example.md](../../docs/example.md); this package builds the part
that runs on the current kernel API.

## Run

**One command starts the rooms and the terminal in one process.** The rooms
run while the terminal runs. When you quit, the host ends your visit and
closes the rooms. The journals stay on disk.

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

`pnpm start` runs Node with `--experimental-ffi`, which OpenTUI needs. A
directory with no `rooms.db` gets the three sample rooms and the datasheets.
A directory that has one resumes its rooms, including a room you created
and a room you stopped. Set `WORKBENCH_USER` instead of `--as` to pick a
person. Without either, the first screen asks who you are. Set
`AMBION_MODEL` and its provider credential to change the model of the Pi
seats. The default is `anthropic/claude-sonnet-5`.

**A seat with no key does not run, and the others do.** At start, the
Workbench prints one line for each seat whose family has no key. The header
of the terminal marks that seat with `no key`. An activation of that seat
fails at once with the name of the missing variable, and the room keeps
running.

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
| `/try`                 | Fill the composer with the room's suggested prompt    |
| `/abort`               | Cancel the open exchange                              |
| `/stop`, `/resume`     | Stop the room, or start it again                      |
| `/steps [n]`           | Show the steps of the newest activation of exchange n |
| `/expand`, `/collapse` | Open or close every discussion                        |
| `/help`, `/quit`       | Show the commands and keys, or leave                  |

`/abort` runs at once. Typing the command is the confirmation. Switching
person leaves the current room, then enters it as the new person.

| Key                   | Effect                                                     |
| --------------------- | ---------------------------------------------------------- |
| Enter                 | Send                                                       |
| Ctrl+J, Alt+Enter     | Add a line to the message                                  |
| Tab                   | Complete a command, or browse the discussions              |
| Up, Down, Enter, e, c | While browsing: choose, open or close, open all, close all |
| s                     | While browsing: show the steps of the chosen exchange      |
| r                     | While browsing: choose a ref of a shown message            |
| Up, Down, Enter       | While choosing a ref: move, open it, or jump to it         |
| Esc                   | Close the palette, clear the search, or close the panel    |
| PageUp, PageDown      | Scroll the conversation                                    |
| Type, Up, Down        | In the files panel: search, and choose a file to read      |
| PageUp, PageDown      | In the files panel: scroll the file                        |
| Ctrl+Y                | In the files panel: copy the file to the clipboard         |

The files panel renders Markdown files with headings, lists, and code. It
shows a SQLite database (`.db`, `.sqlite`, `.sqlite3`, up to 8 MiB) as tables,
with the first 50 rows of each. The panel opens the database read-only.

**A message shows its refs, one line each.** A line starts with `↗` and the
kind of the ref: `file`, `table`, or `message`. A ref that does not resolve
starts with `✗` and ends with the reason. Press Tab, then `r`, to choose a
ref of a shown message. Enter opens a `file` or a `table` ref in the files
panel, the same panel that `/files` opens. Enter on a `message` ref opens its
discussion and highlights the message. Esc goes back. `r` lists only the
refs of shown messages, so press `e` to open every discussion first.

The Workbench resolves three URI forms. The agents cite them in `refs`.

| Form                                 | Names                                    |
| ------------------------------------ | ---------------------------------------- |
| `file:///<path>`                     | A file of the workspace, as `/library/x` |
| `lab:///<table>`                     | A table of the lab database              |
| `ambion://room/<room>/message/<seq>` | A message of the open room               |

The terminal checks a `file:` or `lab:` ref against the list that the host
gives for the workspace and the lab database. It reads no file of the host.
A path with `..`, an empty part, a backslash, or a host name does not
resolve. The files panel lists the lab tables after the files.

A discussion is the thread between a question and its summary, with each
steering message in its place. It starts closed. Start a message with `//` to
send a leading slash, as in `//library/led-5mm.md`.

**The terminal shows the work behind an answer.** Each of these reads from
the record, so a restart keeps them.

- **Cost.** A discussion shows what its exchange spent: dollars when the
  provider reports a cost, else a token count.
- **Steps.** `/steps` or `s` on a chosen discussion shows the passes and steps
  of the newest activation of an exchange. A running activation shows the
  steps written so far and reads again on each change.
- **Awaiting.** An exchange that ends on a message to a person shows
  `Waiting on <person>`. That person also sees a note and a status line.
- **Approval.** An operation above an instrument limit shows to the owner of
  the exchange with its id. The owner answers in the room, and the agent
  records the answer with `approve_operation`.

## The team

**One assistant coordinates three specialists, and the specialists run on
three executor families.** The assistant answers ordinary messages, brings
in a specialist, and writes the closing summary.

| Agent           | Scope                                                              | Family | Model                              | Key                 |
| --------------- | ------------------------------------------------------------------ | ------ | ---------------------------------- | ------------------- |
| **Assistant**   | Understands the request, seats a specialist, and returns a summary | Pi     | `anthropic/claude-sonnet-5`        | `ANTHROPIC_API_KEY` |
| **Datasheets**  | Reads `/library` and states exact limits with their source         | Pi     | `anthropic/claude-sonnet-5`        | `ANTHROPIC_API_KEY` |
| **Design**      | Chooses parts and values, and shows the circuit math               | Claude | `claude-sonnet-5`                  | `ANTHROPIC_API_KEY` |
| **Experiments** | Turns a question into a short, repeatable test plan                | Codex  | `gpt-5.6-luna`, reasoning `medium` | `CODEX_API_KEY`     |

The assistant uses `defineAssistant` from `@ambionframework/assistant`. Each
room seats the specialists it needs. The reserve holds the rest. The header
of the terminal shows the family beside each agent name.

The workspace, lab, and instrument tools reach every seat as tool bundles.
`src/rooms.ts` composes the three executions with `composeExecutions` from
`@ambionframework/ambion/hosting`.

### One tool set, one filesystem, no native tool

**Every agent holds the same tools and reaches the same filesystem, and no
native tool of any harness is on.** One list of bundles serves every seat:
the workspace, the lab, and the instrument tools, in that order. All three
families share one workspace instance, so a file that one agent writes is
the file that another agent reads.

| Family | How it enforces the guarantee                                        |
| ------ | -------------------------------------------------------------------- |
| Pi     | Has no native tool. The seat holds only the tools that it receives.  |
| Claude | Passes no built-in tool. The definition sets no `allowedTools`.      |
| Codex  | Sets `nativeTools: 'none'` and no policy option that opens the host. |

`test/tool-set.test.ts` fails when a definition drifts from this. The live
test `test/live/tool-set.test.ts` asks each seat for its tool list, writes a
file with one seat and reads it with another, and asks each seat for
`/etc/hosts`.

## Tests

**The scripted tier needs no key and no network.** Run it with
`pnpm --filter @ambionframework-examples/workbench test`. The tests give the
Pi seats a scripted model stream. They give the Claude and Codex seats a
scripted execution from `@ambionframework/ambion/testing`.

**The live tier runs each scenario on the real families.** Run it with
`pnpm --filter @ambionframework-examples/workbench test:live`. It costs money.
A scenario skips when a family that it uses has no key: the `bringup`
scenario needs `ANTHROPIC_API_KEY`, and the `sensing` scenario needs
`ANTHROPIC_API_KEY` and `CODEX_API_KEY`.

## The rooms

**Three rooms share one kit.** Each goal shows a distinct collaboration
pattern. Each room offers a suggested prompt.

| Room    | Pattern                  | Starting work                                |
| ------- | ------------------------ | -------------------------------------------- |
| bringup | Datasheet check → design | Blink one LED and choose its series resistor |
| sensing | Design → test plan       | Wire the HC-SR04 and plan a distance test    |
| power   | Datasheet check → budget | Add up the kit current and confirm USB power |

## The workspace

**Every room shares one directory workspace.** It holds the datasheets and
the team's artifacts.

```text
.data/
  rooms.db          Room journals, Pi audits, and the host room catalog
  workspace/
    library/        The datasheets, copied from examples/workbench/library
    shared/         kit.md and notes.md, the team's artifacts
    home/           Agent home directories
```

The datasheets are simplified summaries for a runnable example. They are not
the manufacturer datasheets. The example connects no real hardware, so every
measurement is a planned value.

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

A crash writes no departure. A reconnecting join restores the visit without
another arrival. The default lease expiry is 60 seconds, so lost local work
can pause before it continues.

The person picker is a local convention, not authentication. A deployed
application must authenticate people and control access to rooms and
workspace resources.

## Files

| File                 | What                                                  |
| -------------------- | ----------------------------------------------------- |
| `src/definitions.ts` | The assistant, the three specialists, and the people  |
| `src/scenarios.ts`   | The rooms, and the workspace seed                     |
| `src/rooms.ts`       | The host lifecycle and the room catalog               |
| `src/workbench.ts`   | The host API the terminal calls in process            |
| `src/files.ts`       | The workspace list and one file preview               |
| `src/names.ts`       | The room name and goal rules                          |
| `src/session.ts`     | The terminal state and commands, without OpenTUI      |
| `src/feed.ts`        | The room feed: one read at a time                     |
| `src/commands.ts`    | The slash commands and their suggestions              |
| `src/timeline.ts`    | The record grouped into questions, threads, summaries |
| `src/steps.ts`       | The steps of an activation, and the cost of a run     |
| `src/approvals.ts`   | The instrument operations that wait for an answer     |
| `src/transcript.ts`  | The conversation, with open and closed threads        |
| `src/composer.ts`    | The composer, room chip, and palette                  |
| `src/browser.ts`     | The files panel state: search, matches, chosen file   |
| `src/files-panel.ts` | The files panel beside the conversation               |
| `src/database.ts`    | The SQLite preview: tables and their first rows       |
| `src/refs.ts`        | The refs of a message: parse, resolve, and one chip   |
| `src/tui.ts`         | The terminal: layout, keys, and the run loop          |
| `src/families.ts`    | The family, model, and key of each seat               |
| `src/unavailable.ts` | The execution of a family that has no key             |
| `src/main.ts`        | The entry point                                       |
| `src/brand.ts`       | The product name and the terminal palette             |
| `library/`           | The datasheets                                        |
