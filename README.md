# Ambion

**Ambion is a collaboration kernel for agents and humans.**

[ambionframework.com](https://ambionframework.com) · [documentation](docs/README.md)

People ask questions and read results. Agents speak when they have
something to add and stay silent when they do not. Agents run on any
framework.

## The problem

**Several domains must contribute to one ongoing application.** A question
such as "Can we promise a Thursday delivery?" can need several agents.
Inventory checks stock. Scheduling checks capacity. Compliance checks
constraints. Each agent has its own owner, instructions, model, tools, and
framework. Each contributes when it has something useful to add.

Ambion makes those contributions usable together. A room stays open between
questions. People arrive and leave. A person reads a room by exchange and
by activation, with the cost of each. The steps an agent took go to the
logs of the host. Ambion serves TypeScript application developers. The application
supplies hosting, agent definitions, credentials, and domain tools.

**Workbench is the first application on Ambion.** It seats specialists for
electrical engineering, hardware, and electrochemistry over one shared
workspace. See the [Workbench repository](https://github.com/fastforwardengine/workbench).

## A room and its workspace

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/ambion-capabilities-dark.svg">
  <img alt="A room and its workspace, by capability. A room activates an agent. The room's journal holds a person's question, what an agent says, a say to itself, the close, an optional summary, and the returned say. The agent calls the tools of a workspace. It says what it finds, with refs to what it names. An agent says to itself with a delay. The exchange closes while the say waits. When the say is due, the room gives it back, and the returned say opens an exchange. The workspace gives an agent five capabilities and one pattern, and the agent combines them while the room runs. Every workspace gives an agent processes. bash starts a process that outlives the activation. ps lists it. status and cancel take its handle, and wait takes 1 to 16 handles. At the start of each activation, a reminder lists the seat's processes. Optional tables add sql: agents pass work through a table or a view. Optional repositories add repos and fork: an agent forks a template, clones it into its home, and pushes. Every workspace gives an agent files, with read, write, and edit. The other capabilities write their files there. Optional sensors add connect and observe: an agent observes a server, and the workspace retains the evidence. Actuators are a pattern over processes: an agent runs a controller command with bash. The command reads its own instruments, handles SIGTERM to stop safe inside the grace of its bash call, and logs JSON lines to a file. The six share the homes and the snapshots. Each agent has a home. On a workstation, no other agent reads it. A snapshot ref names the bytes of a file. An opt-in audit log holds each tool call and its activation. An opt-in room mirror holds each message of the room. A person and the host steer the room. A person on a visit asks a question and reads results. The host is application code. It lists and cancels processes, and hears each start and end. Each one posts a message to the room, and the host can post one when a process ends. A message cites a file with a ref. A restart replays the room's entries." src="docs/assets/ambion-capabilities.svg">
</picture>

**The journal records what is said. The workspace holds what is made, and a
message cites it.** Agents speak through `say` and work through tools. A
room is a shared journal with rules for taking part.

**Every workspace gives an agent files and processes.** `read`, `write`, and
`edit` reach the files. `bash` starts a process that outlives the activation.
`ps` lists it. `status` and `cancel` take its handle, and `wait` takes
`{ handles, timeout? }` with 1 to 16 handles. Each activation starts with a
reminder of the seat's processes. `snapshot` freezes a file and gives a ref
that names its bytes. A message then cites what the
file held when the agent spoke, and `restore` gives those bytes to another
agent. The bytes live in an object store: a folder of the workspace by
default, or an S3 bucket such as MinIO or R2. An optional SQL backend gives
tables and adds `sql`: agents pass work to each other through a table or a
view. An optional git backend gives repositories and adds `repos` and
`fork`. An agent forks a read-only template, clones it into its home,
pushes, and cites the commit by its full hash. See
[Workspace](docs/workspace.md), [Processes](docs/processes.md),
[Snapshot a file](docs/workspace.md#snapshot-a-file), and [Git](docs/git.md).

**A backend with ports can connect to sensor servers.** An agent forks a
Git template, customizes the server, validates it, and saves a commit before
launch. The agent connects by process handle and port. `observe` verifies the
response and retains its manifest and file bytes in the existing snapshot
object store. The agent can cite the returned snapshot refs. The server owns
acquisition and reducer state. Measurement timestamps remain the source of
truth. See [Sensors](docs/sensors.md).

**Actuators are a pattern over processes.** An agent starts a controller
command with `bash`. The command reads its own instruments, drives a
device, and handles `SIGTERM` to stop safe inside the `grace` of the call.
The workbench ships an actuator controller template with tests. The agent
confirms convergence through a sensor. See [Actuators](docs/actuators.md).

**An agent combines the capabilities while the application runs.**
Repositories hold the code of a loop, and processes run it. Tables hold
the plans, and files hold the exports. Sensors bring the state of the
world in, and an actuator closes the loop on it. Each step is a tool call
that the agent chooses, so a new loop needs no new host code. See
[Combine the capabilities](docs/actuators.md#combine-the-capabilities).

**An agent comes back to its work later.** It calls `schedule` with `delaySeconds`.
The exchange closes while the say waits. When the say is due, the
room gives it back, and the returned say opens an exchange of its own. An
agent checks a long build this way with no event source and no host code. A
host posts an event of its own with `room.post`. See [Exchange](docs/exchange.md#6-a-scheduled-say).

**The host lists and cancels processes through `workspace.processes`.** It
hears when each process starts and ends. Host code can post a message to
the owner seat when a process ends. The message starts an activation of
that seat. See [The host's view](docs/processes.md#the-hosts-view).

**Both deployments provide the core workspace tools.** A backend with ports
also provides a private transport for sensor servers.

| What an agent gets             | One node: `@ambionframework/just-bash`                               | A remote server: `@ambionframework/workstation`            |
| ------------------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------- |
| Where the files are            | In the host's memory, or in a directory on the host                  | On the server                                              |
| Isolation between agents       | None: every agent reads and writes every home                        | One Unix account for each agent, and a private home        |
| Network                        | None                                                                 | The server's network                                       |
| Commands                       | A simulated shell with a fixed set                                   | A real bash with the server's commands                     |
| Output of a running process    | Shows when the process ends                                          | Shows while the process runs                               |
| Output after cancel or timeout | The file stays empty                                                 | The file keeps the output so far                           |
| Work after a host restart      | Memory: none. Directory: the files; earlier processes read as failed | The files, and the processes that still run                |
| Repositories                   | In the host's process, with `justGitBackend`                         | In one account on the server, with `workstationGitBackend` |
| Sensor servers                 | No port transport; no `connect` or `observe` tools                   | Workstation provides loopback forwarding over SSH          |

0.3.0 adds the rows "Output of a running process" and "Output after cancel
or timeout", the processes in "Work after a host restart", and
`workstationGitBackend`. See
[Workspace](docs/workspace.md), [Workstation](docs/workstation.md),
[Processes](docs/processes.md), and [Trust](docs/trust.md).

## One team on three harnesses

**One room runs Pi, the Claude Agent SDK, and the Codex SDK.** Every seat holds
the same workspace tools and no native tool of its harness. The workspace is
in memory, so the team reads no file on the host.

<!-- ts: standalone -->

```ts
import { defineAgent, defineHuman, startRoom, type ToolBundle } from '@ambionframework/ambion';
import { claude } from '@ambionframework/claude';
import { codex } from '@ambionframework/codex';
import { pi } from '@ambionframework/pi';
import { openWorkspace } from '@ambionframework/workspace';
import { memoryBackend } from '@ambionframework/just-bash';

const workspace = openWorkspace({ name: 'lab', backend: { bash: memoryBackend() } });
const bundles: ToolBundle[] = [workspace.tools()];
const instructions = 'Read /shared/kit.md before you answer. Cite the path of each fact.';

const datasheets = defineAgent({
  name: 'datasheets',
  identity: 'States part limits with their source.',
  executor: pi({ model: 'anthropic/claude-sonnet-5', instructions, bundles }),
});

const design = defineAgent({
  name: 'design',
  identity: 'Chooses parts and values.',
  executor: claude({ model: 'claude-sonnet-5', instructions, bundles }),
});

const experiments = defineAgent({
  name: 'experiments',
  identity: 'Writes short, repeatable test plans.',
  executor: codex({
    model: 'gpt-5.6-luna',
    modelReasoningEffort: 'medium',
    nativeTools: 'none',
    instructions,
    bundles,
  }),
});

const priya = defineHuman({ name: 'priya', identity: 'Designs the test bench.' });

const room = await startRoom({
  name: 'lab',
  goal: 'Choose a part and plan its test.',
  agents: [datasheets, design, experiments],
});

const visit = await room.visit(priya);
const exchange = await visit.send({ text: 'Which regulator fits a 3.3 V, 2 A rail?' });

try {
  for (const message of await exchange.waitForClose()) {
    if (message.kind === 'said') console.log(`${message.from}: ${message.text}`, message.refs);
  }
  await visit.leave();
} finally {
  await room.stop();
}
```

**The room seats every agent at `broadcast` by default.** Pass `seats` to
choose other members or another attention. See [Roster](docs/roster.md#configuration).
The room runs each seat on the default execution of its family; see
[Executors](docs/executors.md). [`examples/workbench`](examples/workbench)
builds its team the same way and runs it in a terminal.

**Each agent has its own fixed skills.** `loadSkills` reads a folder of
agentskills.io skills on the host, with their scripts and resources, and
`workspace.tools({ skills })` gives the set to one agent. The guidance lists
the skills, and each activation copies them into the agent's home. The seat
reads a skill with `read` and runs its scripts with `bash`, on each of the
three harnesses. See [Skills](docs/skills.md).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/ambion-exchange-dark.svg">
  <img alt="Two exchanges on a time axis. A person asks with visit.send(), entry 1. The room activates Agent A, on Pi, and Agent B, on the Claude Agent SDK, and they reason in parallel. A reads a file and says, entry 2. The first say of B read only entry 1, so it comes back missed with entry 2. B reads entry 2, writes a new file, and says to A, entry 3. Entry 3 wakes A, and A resumes the harness session of its first activation. A reads only entry 3 and answers the person, entry 4. The room closes the exchange, entry 5, and waitForClose() returns. A summary follows, entry 6, and waitForSummary() returns it. The person asks again, entry 7. A starts a fresh session, reads the summary and entry 7, and says, entry 8. B has nothing to add and stays silent. The record is durable. The session is a cache for one exchange. The workspace keeps the files. The trace goes to the host's logs." src="docs/assets/ambion-exchange.svg">
</picture>

**An exchange runs from `visit.send()` to `waitForClose()`.** A room started
with `summary` adds a closing summary, and `waitForSummary()` returns it.

**The record is durable, and every activation reads it.** It holds every
message, close, summary and lease entry. A restart replays it. A summary
replaces the messages it covers in later prompts.

**A seat keeps its harness session for one exchange, as a cache.** A lost
session starts fresh from the record. See
[Exchange continuity](docs/executors.md#exchange-continuity).

## What you get

- **A record that answers for itself.** The journal holds every message and
  every lease entry, with usage and cost. See [Room](docs/room.md).
- **Speech that is checked.** A `say` that read a stale record is refused
  with the messages it missed, so agents reason in parallel and the room
  serializes what it accepts. See [Agents](docs/agent.md).
- **Silence as a result.** An exchange closes when no seat has work left,
  and one summary per person replaces the discussion in later context. See
  [Exchanges](docs/exchange.md).
- **Any framework, one adapter each.** Pi, Claude, and Codex ship as
  packages. See [Executors](docs/executors.md).
- **Work you can inspect.** Every activation gives its steps to the logger
  the host passes in, with usage and cost. See
  [Executors](docs/executors.md#the-trace-log).
- **The same tools on every harness.** See [Trust](docs/trust.md#what-each-harness-exposes)
  for how each package enforces it and which test guards it.

More is in [Technical facts](docs/technical-facts.md).

## Install

Use Node **22.19 or later**. The packages are ESM and install from npmjs with no token. A dev build
of `main` installs from GitHub Packages; see
[Toolchain](docs/toolchain.md#9-release-and-publishing).
Model execution needs credentials for the chosen provider.

```sh
npm install @ambionframework/ambion @ambionframework/pi
```

Run the workbench for the working version of the team above: `pnpm start`
in [`examples/workbench`](examples/workbench). It needs Node **26.4 or
later**, the floor `@opentui/core` sets for its terminal renderer. See
[Contributing](CONTRIBUTING.md) to build from source.

## Boundaries

- The journal owns no domain transactions and no credentials.
- Tools can act before a contribution commits. Applications own effect
  idempotency.
- A scheduled say is the one clock an agent sets. A host that wants
  a wake calls `room.post`.

[Technical facts](docs/technical-facts.md) lists every limit.

## Read more

[Documentation](docs/README.md) maps the design contracts and hosting
guidance. [Contributing](CONTRIBUTING.md) covers builds and checks.
[The plan](planning/next.md) names the scope of the next release.
[The changelog](CHANGELOG.md) lists the packages and changes of each release.

## License

[Apache 2.0](LICENSE)
