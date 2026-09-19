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
export ANTHROPIC_API_KEY=...
pnpm start                  # uses ./.data
pnpm start ./bench --as mira   # a directory, and a person
```

`pnpm start` runs Node with `--experimental-ffi`, which OpenTUI needs. A
directory with no `rooms.db` gets the three sample rooms and the datasheets.
A directory that has one resumes its rooms, including a room you created
and a room you stopped. Set `WORKBENCH_USER` instead of `--as` to pick a
person. Without either, the first screen asks who you are. Set
`AMBION_MODEL` and its provider credential to change the model. The default
is `anthropic/claude-sonnet-5`.

The terminal reads its colors from the repository brand kit in the root
[`brand/`](../../brand) directory. The example has no HTTP interface.

## The terminal

**The composer is the control surface.** The chip in front of the input
shows the room that receives your message. Type `/` to see the commands, or
press Ctrl+R to pick a room.

| Command                | Effect                                             |
| ---------------------- | -------------------------------------------------- |
| `/room <name>`         | Switch to another room                             |
| `/new <name> [goal]`   | Create a room. Without a goal, the composer asks   |
| `/user <person>`       | Act as another person                              |
| `/files`               | Search the workspace files in a side panel         |
| `/open <path>`         | Open the files panel on one file                   |
| `/try`                 | Fill the composer with the room's suggested prompt |
| `/abort`               | Cancel the open exchange                           |
| `/stop`, `/resume`     | Stop the room, or start it again                   |
| `/expand`, `/collapse` | Open or close every discussion                     |
| `/help`, `/quit`       | Show the commands and keys, or leave               |

`/abort` runs at once. Typing the command is the confirmation. Switching
person leaves the current room, then enters it as the new person.

| Key                   | Effect                                                     |
| --------------------- | ---------------------------------------------------------- |
| Enter                 | Send                                                       |
| Ctrl+J, Alt+Enter     | Add a line to the message                                  |
| Tab                   | Complete a command, or browse the discussions              |
| Up, Down, Enter, e, c | While browsing: choose, open or close, open all, close all |
| Esc                   | Close the palette, clear the search, or close the panel    |
| PageUp, PageDown      | Scroll the conversation                                    |
| Type, Up, Down        | In the files panel: search, and choose a file to read      |
| PageUp, PageDown      | In the files panel: scroll the file                        |
| Ctrl+Y                | In the files panel: copy the file to the clipboard         |

A discussion is the thread between a question and its summary, with each
steering message in its place. It starts closed. Start a message with `//` to
send a leading slash, as in `//library/led-5mm.md`.

## The team

**One assistant coordinates three specialists.** The assistant answers
ordinary messages, brings in a specialist, and writes the closing summary.

| Agent           | Scope                                                              |
| --------------- | ------------------------------------------------------------------ |
| **Assistant**   | Understands the request, seats a specialist, and returns a summary |
| **Datasheets**  | Reads `/library` and states exact limits with their source         |
| **Design**      | Chooses parts and values, and shows the circuit math               |
| **Experiments** | Turns a question into a short, repeatable test plan                |

The assistant uses `defineAssistant` from `@ambionframework/assistant`. Each
room seats the specialists it needs. The reserve holds the rest.

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
| `src/transcript.ts`  | The conversation, with open and closed threads        |
| `src/composer.ts`    | The composer, room chip, and palette                  |
| `src/browser.ts`     | The files panel state: search, matches, chosen file   |
| `src/files-panel.ts` | The files panel beside the conversation               |
| `src/tui.ts`         | The terminal: layout, keys, and the run loop          |
| `src/main.ts`        | The entry point                                       |
| `src/brand.ts`       | The product name and the terminal palette             |
| `library/`           | The datasheets                                        |
