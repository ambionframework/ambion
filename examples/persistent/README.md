# Persistent rooms in the browser

**One Node process hosts the room console and its API.**
[`index.html`](index.html) is a standalone SPA with inline CSS and JavaScript.
It has no frontend dependencies or build step. The layout follows `ambion dev`:
conversation, participant activity, and a message composer.

## Run

From the repository root, install and build with Node 26.4 or later:

```sh
pnpm install
pnpm build
cd examples/persistent
export ANTHROPIC_API_KEY=...
pnpm start
```

Open **http://127.0.0.1:3000**. Choose Alice, Bob, or Cara, then open an existing
room or create one. The browser remembers the assumed identity for that tab.
Open another tab to participate as another person.

`start` creates a fresh `.data` directory. Use `pnpm resume` for subsequent
runs. Both commands accept a data directory argument. Set `PORT` to change
port 3000. Set `AMBION_MODEL` and its provider credential to change the model.
The default is `anthropic/claude-sonnet-5`.

Serve the HTML through this host so its relative API requests use the same
origin. Opening the file directly does not connect it to the demo.

## Play

**Assume one human identity across rooms.** Choose a person in the identity
picker. Selecting a room enters it. Selecting another room leaves the current
room before entering the next. Switch user leaves the current room and opens the
identity picker. A reload restores the selected identity and room visit.
Presence belongs to the person across clients; leaving ends their shared visit.

## The sample team

**Relay is a fictional handoff-board product.** Its shared files include
customer feedback, a product brief, a static HTML prototype, and support
reports. Agents have local tools. They cannot browse the web, send email,
or deploy the product.

| Human | Role          | Preferred summary                                |
| ----- | ------------- | ------------------------------------------------ |
| Alice | Product lead  | Decisions, tradeoffs, and open questions         |
| Bob   | Engineer      | Changed files, verification, and technical risks |
| Cara  | Customer lead | Customer impact and usable wording               |

**The assistant coordinates ordinary specialist agents.** Planner scopes
work, builder implements it, writer prepares copy, and reviewer checks it.
All five use the same workspace tools. Each room seats the specialists it
needs; other definitions remain available. Agents can seat another specialist
during an exchange. The assistant receives ordinary room messages and writes
the optional closing summary through `say`.

| Room     | Collaboration pattern                     | Starting work                                      |
| -------- | ----------------------------------------- | -------------------------------------------------- |
| design   | Independent perspectives, then a decision | Compare feedback and write a scoped brief          |
| delivery | Implementation, review, and revision      | Improve overdue visibility and mobile layout       |
| launch   | Draft, human feedback, and revision       | Write accurate release notes from shared artifacts |
| triage   | Route a report to the right specialist    | Investigate reports and draft a customer response  |

Each room offers a suggested prompt. Click it to fill the composer, then
edit or send it. People describe the outcome without naming an agent.
Try design first, then delivery and launch to reuse the resulting files.
In launch, send a follow-up such as "Keep this under 100 words."

Try this message:

> Create /shared/plan.md with a short launch checklist, then summarize it.

Refresh Shared workspace in the left panel to inspect the file. Switch rooms
while the agents work, or add a follow-up message to the open exchange.
The same message API handles both new questions and steering.

| Control     | Effect                                                                   |
| ----------- | ------------------------------------------------------------------------ |
| Create room | Save its name and goal, start its team, and join as the selected person  |
| Stop        | Revoke room work and record human departures; preserve history and files |
| Resume      | Restore the recorded team and pending work for that room                 |
| Abort work  | Request cancellation while the room remains available                    |
| Select room | Leave the current room and enter the selected room                       |
| Switch user | Leave the current room and choose another predefined identity            |

The timeline keeps human prompts and final summaries visible. The discussion
expands while agents work and collapses when the summary arrives. You can
expand it again to inspect the exchange. An exchange with one agent reply
shows that reply directly, without a summary card or disclosure. Room details show presence and
recent model and tool execution events. Activity is local to this host run;
durable messages remain available after restart and while a room is stopped.

## What persists

**Room journals and workspace files have separate owners.** The demo uses one
runtime and SQLite database. Each room has its own journal. All rooms share
one workspace resource.

```text
.data/
  rooms.db                      # Room journals, Pi audits, and host room catalog
  workspace/                    # One directory shared by every room
    shared/
      project.md                # Product context and constraints
      feedback.md               # Fictional interview notes
      brief.md                  # Product decisions
      prototype.html            # Editable product prototype
      launch.md                 # Release copy
      tickets.md                # Fictional support reports
    home/                       # Agent home directories
```

The host catalog records room names, goals, initialization, and whether the
host should run them. Collaboration state remains in each room journal.
A deliberately stopped room stays stopped when the server restarts. The
server restores previously running rooms with the same definitions.

Workspace tools use one `directoryBackend`. The shared owner serializes tool
operations across rooms. Multi-step edits still require agent coordination.
Startup adds missing sample files and preserves existing file content. Files
survive Stop, Resume, and process restart. Host shutdown calls `dispose`, which preserves those files.
The browser lists up to 500 directory entries and previews text files up to
128 KiB. It does not follow symbolic links.

**The browser saves uncertain deliveries before sending.** Its outbox keeps
the room, human, key, and exact message. A retry uses the same key. Drafts and
deliveries are scoped to each room and human. History loads from sequence zero
on page load, then polls for later messages and merges by sequence.

## Restart and reconnect

1. Send a message and wait for its acceptance.
2. While an agent works, run `kill -KILL <PID>` with the printed Node PID.
3. Run `pnpm resume` with the same directory.
4. Keep the browser open or reload it. It reads the recovered history.
5. Retry an uncertain delivery from its saved outbox.
6. Inspect the recovered exchange and workspace files.

A crash writes no human departure. A reconnecting join restores the existing
visit without another arrival. Sends require a present visit, so a delayed
request cannot silently rejoin a room after navigation. HTTP requests and
JavaScript handles do not survive a process restart. The default lease expiry
is 60 seconds, with retry backoff, so lost local work can pause before it continues.

**Ctrl+C performs a graceful shutdown.** It stops the hosted rooms and closes
SQLite after workspace operations finish. Hosting intent stays in the catalog
so the next server run can restore those rooms. Use the room's Stop control
to keep that room stopped across server restarts.

## API

| Request                                                    | Result                                                                     |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| `GET /people`                                              | Predefined human identities                                                |
| `GET /rooms`                                               | Rooms, running status, participants, current exchange, and recent activity |
| `POST /rooms` with `{name, goal}`                          | Create and start a room                                                    |
| `POST /rooms/:room/resume`, `/stop`, `/abort`              | Room lifecycle operations; abort returns 202 while cancellation proceeds   |
| `PUT /rooms/:room/humans/:person`                          | Join as a predefined human                                                 |
| `POST /rooms/:room/humans/:person` with `{key, text, to?}` | Send as a present human and return `{from, owner, at}` after acceptance    |
| `DELETE /rooms/:room/humans/:person`                       | Record the person's departure                                              |
| `GET /rooms/:room/messages?since=:seq`                     | Durable messages after an exclusive cursor, including stopped rooms        |
| `GET /rooms/:room/exchanges/:from`                         | Wait for a running room's fixed exchange discussion                        |
| `GET /workspace`                                           | Local root and workspace file list                                         |
| `GET /file?path=/shared/plan.md`                           | Text preview                                                               |

The server binds to loopback. Identity selection is a local demo convention,
not authentication. A deployed application must authenticate clients and
control access to rooms and workspace resources. Use one host per database.
Room leases do not make external tool effects exactly once.

[`src/server.ts`](src/server.ts) owns HTTP routing.
[`src/rooms.ts`](src/rooms.ts) owns host lifecycle and catalog persistence.
[`src/team.ts`](src/team.ts) supplies ordinary agent and human definitions.
[`src/scenarios.ts`](src/scenarios.ts) supplies room goals and sample files.
See [deployment and recovery](../../docs/deployment.md) for the kernel contract.
