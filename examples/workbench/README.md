# Workbench

**Workbench is an agentic lab workbench for a toy Arduino kit.** People and
specialized agents share one project. A person asks a question, and the
agents read the datasheets, choose parts, and plan tests, on the record.

Workbench is the runnable example for the Ambion collaboration kernel. See
the root [README](../../README.md) for what Ambion is. The full lab design
is in [docs/example.md](../../docs/example.md); this package builds the part
that runs on the current kernel API.

## Two endpoints, one host

**One Node process hosts the rooms. A web page and a terminal read the same
rooms through the same HTTP API.**

- **Web.** [`ui/index.html`](ui/index.html) is one page with inline CSS and
  JavaScript. It has no build step. It shows the rooms, the conversation, the
  participants, and the library.
- **Terminal.** [`src/tui.ts`](src/tui.ts) is an [OpenTUI](https://github.com/sst/opentui)
  client on a dark theme. It has a multi-line composer, slash commands, and
  the same discussions as the web page. See [The terminal](#the-terminal).

Both endpoints share the repository brand kit in the root
[`brand/`](../../brand) directory. The web page loads `/brand/tokens/ambion.css`
and the brand icons and logo. The terminal reads the colors from
`brand/tokens/ambion.tokens.json`. One kit holds the identity.

## Run

From the repository root, install and build with Node 26.4 or later:

```sh
pnpm install
pnpm build
cd examples/workbench
export ANTHROPIC_API_KEY=...
pnpm start
```

Open **http://127.0.0.1:3000**. Choose Mira, Theo, or Sol, then open a room.
The browser remembers the person for that tab. Open another tab to work as
another person.

To open the terminal endpoint, keep the host running and start the terminal
in a second shell:

```sh
cd examples/workbench
pnpm tui              # connects to http://127.0.0.1:3000
pnpm tui http://127.0.0.1:3000 theo   # a base URL and a person
```

`pnpm tui` starts Node with `--experimental-ffi`, which OpenTUI needs. Run the
script through `pnpm`, or pass the flag yourself. When you exit, the terminal
ends your visit to the room. The web page for the same person then offers
**re-enter**.

`start` creates a fresh `.data` directory. Use `pnpm resume` for later runs.
Both commands accept a directory argument. Set `PORT` to change the port. Set
`AMBION_MODEL` and its provider credential to change the model. The default
is `anthropic/claude-sonnet-5`.

## The terminal

**The composer is the control surface.** The room chip in front of the input
shows where a message goes. Type `/` to see the commands, or press Ctrl+R to
pick a room.

| Command                | Effect                               |
| ---------------------- | ------------------------------------ |
| `/room <name>`         | Switch to another room               |
| `/abort`               | Cancel the open exchange             |
| `/stop`, `/resume`     | Stop the room, or start it again     |
| `/expand`, `/collapse` | Open or close every discussion       |
| `/help`, `/quit`       | Show the commands and keys, or leave |

`/abort` runs at once. Typing the command is the confirmation. The web page
asks for a second click instead.

| Key                   | Effect                                                     |
| --------------------- | ---------------------------------------------------------- |
| Enter                 | Send                                                       |
| Ctrl+J, Alt+Enter     | Add a line to the message                                  |
| Tab                   | Complete a command, or browse the discussions              |
| Up, Down, Enter, e, c | While browsing: choose, open or close, open all, close all |
| Esc                   | Close the palette, or stop browsing                        |
| PageUp, PageDown      | Scroll the conversation                                    |

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

The browser saves an uncertain delivery before it sends. A retry uses the
same key, so a lost acknowledgement adds no duplicate message. This does not
make tool effects exactly once: SQLite records and file changes are not one
transaction.

## Restart

1. Send a message and wait for its acceptance.
2. While an agent works, stop the process with the printed PID.
3. Run `pnpm resume` with the same directory.
4. Reload the browser, or start the terminal again. It reads the recovered
   history.

A crash writes no departure. A reconnecting join restores the visit without
another arrival. The default lease expiry is 60 seconds, so lost local work
can pause before it continues.

## API

The web page and the terminal use one loopback HTTP API.

| Request                                                    | Result                                                     |
| ---------------------------------------------------------- | ---------------------------------------------------------- |
| `GET /people`                                              | The people identities                                      |
| `GET /rooms`                                               | Rooms, status, participants, and recent activity           |
| `POST /rooms` with `{name, goal}`                          | Create and start a room                                    |
| `POST /rooms/:room/resume`, `/stop`, `/abort`              | Room lifecycle operations                                  |
| `PUT /rooms/:room/humans/:person`                          | Join as a person                                           |
| `POST /rooms/:room/humans/:person` with `{key, text, to?}` | Send as a present person; returns `202 Accepted`           |
| `DELETE /rooms/:room/humans/:person`                       | Record the person's departure                              |
| `GET /rooms/:room?since=:seq`                              | Room metadata, exchange views, and messages after a cursor |
| `GET /workspace`, `GET /file?path=…`                       | The file list and one text preview                         |
| `GET /brand/…`                                             | The repository brand kit: icons, logos, tokens, and font   |

The server binds to loopback. The person picker is a local convention, not
authentication. A deployed application must authenticate clients and control
access to rooms and workspace resources.

## Files

| File                 | What                                                    |
| -------------------- | ------------------------------------------------------- |
| `src/definitions.ts` | The assistant, the three specialists, and the people    |
| `src/scenarios.ts`   | The rooms, and the workspace seed                       |
| `src/rooms.ts`       | The host lifecycle and the room catalog                 |
| `src/server.ts`      | The HTTP routing for both endpoints                     |
| `src/client.ts`      | The HTTP client the terminal uses                       |
| `src/feed.ts`        | The terminal's room feed: one read at a time            |
| `src/tui.ts`         | The terminal endpoint: state, commands, and keys        |
| `src/composer.ts`    | The terminal composer, room chip, and palette           |
| `src/transcript.ts`  | The terminal conversation, with open and closed threads |
| `src/commands.ts`    | The slash commands and their suggestions                |
| `src/timeline.ts`    | The record grouped into questions, threads, summaries   |
| `src/brand.ts`       | The product name and the terminal palette               |
| `ui/index.html`      | The web endpoint                                        |
| `library/`           | The datasheets                                          |
