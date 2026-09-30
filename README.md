# Ambion

**Ambion is a collaboration kernel for agents and humans.**

[ambionframework.com](https://ambionframework.com) · [documentation](docs/README.md)

A room is a shared journal with rules for taking part. People ask questions
and read results. Agents on any framework speak when they have something to
add and stay silent when they do not. The kernel keeps the record and the
rules, and a restart loses nothing.

**One question can need several domains.** "Can we promise a Thursday
delivery?" needs inventory, scheduling, and compliance. Each agent has its
own owner, instructions, model, tools, and framework. A room makes their
contributions usable together. The application supplies hosting, agent
definitions, credentials, and domain tools.

[Workbench](https://github.com/fastforwardengine/workbench) is the first
application on Ambion. It seats specialists for electrical engineering,
hardware, and electrochemistry over one shared workspace.

## Quickstart

**Install the kernel, the Pi executor, and an in-memory workspace.** Use
Node 22.19 or later. The packages are ESM.

```sh
npm install @ambionframework/ambion @ambionframework/pi \
  @ambionframework/workspace @ambionframework/just-bash
export ANTHROPIC_API_KEY=...
```

**Save a room with two agents as `room.mts`.**

```ts
import { defineAgent, definePerson, startRoom } from '@ambionframework/ambion';
import { memoryBackend } from '@ambionframework/just-bash';
import { pi } from '@ambionframework/pi';
import { openWorkspace } from '@ambionframework/workspace';

const workspace = openWorkspace({ name: 'lab', backend: { bash: memoryBackend() } });
const bundles = [workspace.tools()];
const model = 'anthropic/claude-sonnet-5';

const datasheets = defineAgent({
  name: 'datasheets',
  identity: 'States part limits with their source.',
  executor: pi({ model, instructions: 'Give each limit with its unit.', bundles }),
});

const design = defineAgent({
  name: 'design',
  identity: 'Chooses parts and values.',
  executor: pi({ model, instructions: 'Name one part and give the reason.', bundles }),
});

const priya = definePerson({ name: 'priya', identity: 'Designs the test bench.' });
const room = await startRoom({ name: 'lab', goal: 'Choose a part.', agents: [datasheets, design] });

try {
  const visit = await room.visit(priya);
  const exchange = await visit.send({ text: 'Which regulator fits a 3.3 V, 2 A rail?' });
  for (const message of await exchange.waitForClose()) {
    if (message.kind === 'said') console.log(`${message.from}: ${message.text}`);
  }
} finally {
  await room.stop();
}
```

**Run it with `node room.mts`.** Both agents read the question in
parallel. Each one speaks or stays silent, and `waitForClose()` returns
when no seat has work left.

## One team on three harnesses

**One room runs Pi, the Claude Agent SDK, and Codex.** Install
`@ambionframework/claude` or `@ambionframework/codex`, and pass its
executor. Every seat holds the same workspace tools and no native tool of
its harness. The Claude seat reads `ANTHROPIC_API_KEY`, and the Codex seat
reads `CODEX_API_KEY`.

```ts
import { claude } from '@ambionframework/claude';
import { codex } from '@ambionframework/codex';

const reviewer = defineAgent({
  name: 'reviewer',
  identity: 'Checks a choice against the limits.',
  executor: claude({ model: 'claude-sonnet-5', instructions: 'Name each risk.', bundles }),
});

const experiments = defineAgent({
  name: 'experiments',
  identity: 'Writes short, repeatable test plans.',
  executor: codex({
    model: 'gpt-5.6-luna',
    modelReasoningEffort: 'medium',
    instructions: 'Write a plan of at most five steps.',
    bundles,
  }),
});
```

The room seats every agent at `broadcast` by default. Pass `seats` to choose
another attention; see [Roster](docs/roster.md#configuration).
[Executors](docs/executors.md) holds the contract for a new harness.

## How a room works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/ambion-exchange-dark.svg">
  <img alt="Two exchanges on a time axis. A person asks with visit.send(), entry 1. The room activates Agent A, on Pi, and Agent B, on the Claude Agent SDK, and they reason in parallel. A reads a file and says, entry 2. The first say of B read only entry 1, so it comes back missed with entry 2. B reads entry 2, writes a new file, and says to A, entry 3. Entry 3 wakes A, and A resumes the harness session of its first activation. A reads only entry 3 and answers the person, entry 4. The room closes the exchange, entry 5, and waitForClose() returns. A summary follows, entry 6, and waitForSummary() returns it. The person asks again, entry 7. A starts a fresh session, reads the summary and entry 7, and says, entry 8. B has nothing to add and stays silent. The record is durable. The session is a cache for one exchange. The workspace keeps the files. The trace goes to the host's logs." src="docs/assets/ambion-exchange.svg">
</picture>

- **Speech is checked.** A `say` that read a stale record comes back with
  the messages it missed. Agents reason in parallel, and the room serializes
  what it accepts. See [Agents](docs/agent.md).
- **Silence is a result.** An exchange closes when no seat has work left. A
  room started with `summaryWriter` adds a closing summary, which replaces the
  discussion in later prompts. See [Exchange](docs/exchange.md).
- **The record is durable.** The journal holds every message, close,
  summary, and lease entry, with usage and cost. A restart replays it. See
  [Durability](docs/durability.md).
- **A harness session is a cache for one exchange.** A lost session starts
  fresh from the record. See
  [Exchange continuity](docs/executors.md#exchange-continuity).
- **An agent comes back to its work later.** `schedule` with `delaySeconds` returns
  a say when it is due, and the say opens an exchange. A host posts an event
  with `room.post`. See [A scheduled say](docs/exchange.md#6-a-scheduled-say).
- **The steps of each activation go to the host's logger.** See
  [The trace log](docs/executors.md#the-trace-log).

## The workspace

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/ambion-capabilities-dark.svg">
  <img alt="A room and its workspace, by capability. A room activates an agent. The room's journal holds a person's question, what an agent says, a say to itself, the close, an optional summary, and the returned say. The agent calls the tools of a workspace. It says what it finds, with refs to what it names. An agent says to itself with a delay. The exchange closes while the say waits. When the say is due, the room gives it back, and the returned say opens an exchange. The workspace gives an agent five capabilities and one pattern, and the agent combines them while the room runs. Every workspace gives an agent processes. bash starts a process that outlives the activation. ps lists it. status and cancel take its handle, and wait takes 1 to 16 handles. At the start of each activation, a reminder lists the seat's processes. Optional tables add sql: agents pass work through a table or a view. Optional repositories add repos and fork: an agent forks a template, clones it into its home, and pushes. Every workspace gives an agent files and objects. read, write, and edit reach the files. snapshot puts the bytes of a file in an object store, and restore gives them back. The store is a folder of the workspace or an S3 bucket. Optional sensors add connect and observe: an agent observes a server, and the workspace retains the evidence. Actuators are a pattern over processes: an agent runs a controller command with bash. The command reads its own instruments, handles SIGTERM to stop safe inside the grace of its bash call, and logs JSON lines to a file. The six share the homes and the snapshots. Each agent has a home. On a workstation, no other agent reads it. A snapshot ref names the bytes of a file. An opt-in audit log holds each tool call and its activation. An opt-in room mirror holds each message of the room. A person and the host steer the room. A person on a visit asks a question and reads results. The host is application code. It lists and cancels processes, and hears each start and end. Each one posts a message to the room, and the host can post one when a process ends. A message cites a file with a ref. A restart replays the room's entries." src="docs/assets/ambion-capabilities.svg">
</picture>

**The journal records what is said. The workspace holds what is made, and a
message cites it.** Each agent has a home, and each capability is a set of
tools.

| Capability   | Tools                                    | When                              | Read                                                     |
| ------------ | ---------------------------------------- | --------------------------------- | -------------------------------------------------------- |
| Files        | `read`, `write`, `edit`                  | Every workspace                   | [Workspace](docs/workspace.md)                           |
| Processes    | `bash`, `ps`, `status`, `cancel`, `wait` | Every workspace                   | [Processes](docs/processes.md)                           |
| Snapshots    | `snapshot`, `restore`                    | Every workspace                   | [Snapshot a file](docs/workspace.md#snapshot-a-file)     |
| Tables       | `sql`                                    | With a SQL backend                | [Workspace](docs/workspace.md#query-the-shared-database) |
| Repositories | `repos`, `fork`                          | With a git backend                | [Git](docs/git.md)                                       |
| Sensors      | `connect`, `observe`                     | With a backend that has endpoints | [Sensors](docs/sensors.md)                               |
| Skills       | `read`, `bash`                           | When the host passes skills       | [Skills](docs/skills.md)                                 |

**Actuators are a pattern over processes.** A controller command started
with `bash` drives a device and stops safe on `SIGTERM`. A sensor confirms
the result. See [Actuators](docs/actuators.md).

**Two packages provide the bash backend.** `@ambionframework/just-bash`
runs a simulated shell on one node, in memory or in a directory.
`@ambionframework/workstation` runs a real bash on a server over SSH, with
one Unix account for each agent. See
[Backends and limits](docs/workspace.md#backends-and-limits) and
[Trust](docs/trust.md).

**Camera Chat connects an agent-managed Mac camera to a room conversation.**
Run `pnpm demo` in [`examples/camera-chat`](examples/camera-chat) for a
camera-free preview. Its README describes live capture and the localhost
shell and Git backends.

## Boundaries

- The journal owns no domain transactions and no credentials.
- Tools can act before a contribution commits. Applications own effect
  idempotency.
- A scheduled say is the one clock an agent sets. Every other event comes
  from the host through `room.post`.

[Technical facts](docs/technical-facts.md) lists every limit.

## Read more

- [Documentation](docs/README.md) maps the design contracts and hosting.
- [`examples/workbench`](examples/workbench) runs a team in a terminal with
  `pnpm start`. It needs Node 26.4 or later.
- [Contributing](CONTRIBUTING.md) covers builds and checks.
  [Toolchain](docs/toolchain.md#9-release-and-publishing) covers dev builds
  of `main`.
- [The plan](planning/next.md) names the scope of the next release.
  [The changelog](CHANGELOG.md) lists the changes of each release.

## License

[Apache 2.0](LICENSE)
