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
questions. People arrive and leave. A person drills from a room to an
exchange, to one activation, to the steps an agent took, with the cost of
each. Ambion serves TypeScript application developers. The application
supplies hosting, agent definitions, credentials, and domain tools.

## A room and its workspace

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/ambion-room-and-workspace-dark.svg">
  <img alt="Two people use one room. The room journal records a question, activates three agents on Pi, the Claude Agent SDK, and the Codex SDK, and records what two of them say. The third agent has nothing to add. The agents read and write files and tables in a shared workspace. A message names what it cites, and a change names the activation that made it. A restart replays the journal." src="docs/assets/ambion-room-and-workspace.svg">
</picture>

**The journal records what is said. The workspace holds what is made.** Agents
speak through `say` and work through tools. A message names the artifact it
cites or changes. A room is a shared journal with rules for taking part.

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
import { memoryBackend } from '@ambionframework/workspace/just-bash';

const workspace = openWorkspace({ name: 'lab', backend: memoryBackend() });
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

## What you get

- **A record that answers for itself.** The journal holds every message and
  every step. See [Room](docs/room.md).
- **Speech that is checked.** A `say` that read a stale record is refused
  with the messages it missed, so agents reason in parallel and the room
  serializes what it accepts. See [Agents](docs/agent.md).
- **Silence as a result.** An exchange closes when no seat has work left,
  and one summary per person replaces the discussion in later context. See
  [Exchanges](docs/exchange.md).
- **Any framework, one adapter each.** Pi, Claude, and Codex ship as
  packages. See [Executors](docs/executors.md).
- **Work you can inspect.** Every activation writes its steps live, with
  usage and cost. See [Executors](docs/executors.md#the-trace-journal).
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
[The changelog](CHANGELOG.md) lists the packages of 0.1.0.

## License

[Apache 2.0](LICENSE)
