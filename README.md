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
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/ambion-room-and-workspace-dark.svg">
  <img alt="Two people use one room. The room journal records a question, activates three agents on Pi, the Claude Agent SDK, and the Codex SDK, and records what two of them say. The third agent has nothing to add. The agents call the tools of a shared workspace. A required bash backend holds the files, the audit log, and the room mirrors. An optional SQL backend holds the tables and writes CSV exports through the bash backend. A message names what it cites, and a change names the activation that made it. A restart replays the journal." src="docs/assets/ambion-room-and-workspace.svg">
</picture>

**The journal records what is said. The workspace holds what is made.** Agents
speak through `say` and work through tools. A message names the artifact it
cites or changes. A room is a shared journal with rules for taking part.

**A workspace has one bash backend, and it can have one SQL backend and
one git backend.** Eight tools run on the bash backend: in memory or on a
directory with `@ambionframework/just-bash`, or on a remote server over SSH
with [`@ambionframework/workstation`](docs/workstation.md). `read`, `write`,
and `edit` work on files. `bash` starts each command as a background
process, with its output in a file, and returns a handle for `status`,
`wait`, and `cancel`. `ps` lists the running processes, and each activation
starts with a reminder of the seat's processes. Background processes are
part of 0.3.0 ([Processes](docs/processes.md)).
The `sql` tool exists only when the workspace has a SQL backend. SQLite is the
default. The `repos` and `fork` tools exist only when the workspace has a git
backend: an agent forks a read-only template, clones it, and pushes with
[`@ambionframework/git`](docs/git.md). See [Workspace](docs/workspace.md).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/ambion-workspace-backends-dark.svg">
  <img alt="Workspace backends. Every workspace has eight tools: read, write, and edit for files, and bash, ps, status, wait, and cancel for background processes, which the host lists, follows, and cancels through workspace.processes. memoryBackend and directoryBackend run just-bash in the host's process, as one user with no network, and write a process's output when it ends. workstationBackend runs real bash over SSH on one server, with one Unix account for each agent, and streams a process's output to its file. A SQL backend adds sql, and a git backend adds repos and fork." src="docs/assets/ambion-workspace-backends.svg">
</picture>

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

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/ambion-exchange-dark.svg">
  <img alt="One exchange on a time axis. visit.send() records the question as entry 1. The room activates three agents, and they reason in parallel. Agent A says, entry 2. The first say of Agent B read only entry 1, so it comes back missed with entry 2. Agent B reconsiders, writes a file, and says, entry 3. Agent C has nothing to add. The room closes the exchange, and waitForClose() returns. An optional summary returns from waitForSummary()." src="docs/assets/ambion-exchange.svg">
</picture>

**An exchange runs from `visit.send()` to `waitForClose()`.** A room started
with `summary` adds a closing summary, and `waitForSummary()` returns it.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/ambion-context-dark.svg">
  <img alt="A room over two exchanges on a time axis. A person asks, entry 1. Agents A, on Pi, and B read the record. A says, entry 2. B says to A, entry 3, which wakes A again. A's second activation resumes the harness session of its first and reads only entries 2 and 3. A says, entry 4. The exchange closes, entry 5, and a summary follows, entry 6. The person asks again, entry 7, which opens exchange 2. A's third activation starts a fresh session and reads the summary and entry 7. B stays silent. The record is durable. The trace goes to the host's logs. The session is a cache for one exchange." src="docs/assets/ambion-context.svg">
</picture>

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
- Native timers, external event subscriptions, and scheduler ingress are
  future work.

[Technical facts](docs/technical-facts.md) lists every limit.

## Read more

[Documentation](docs/README.md) maps the design contracts and hosting
guidance. [Contributing](CONTRIBUTING.md) covers builds and checks.
[The plan](planning/next.md) names the scope of the next release.
[The changelog](CHANGELOG.md) lists the packages and changes of each release.

## License

[Apache 2.0](LICENSE)
