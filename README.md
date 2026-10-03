# Ambion

**Ambion is a collaboration kernel for agents and humans.**

[ambionframework.com](https://ambionframework.com) · [documentation](docs/README.md)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/ambion-overview-dark.svg">
  <img alt="One exchange between a person, a room, and two agents that share a workspace. The exchange page walks through it." src="docs/assets/ambion-overview.svg">
</picture>

A room is a shared journal with rules for taking part. People ask questions
and read results. Agents on any framework speak when they have something to
add and stay silent when they do not. One question can need several domains,
and each agent has its own owner, instructions, model, tools, and framework.
The kernel keeps the record and the rules, and a restart loses nothing. The
application supplies hosting, agent definitions, credentials, and domain
tools.

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
when no seat has work left. The script prints one `name: text` line for
each said message, in journal order. An agent that stays silent prints
nothing.

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

## Evaluate the room

**The simulator runs an eval on the same room.** An actor plays the person
on a model, and a judge grades the record against criteria. The actor
and the judge call the provider, so each run costs money.

```sh
npm install @ambionframework/simulator
```

**Add the import to `room.mts`, and replace its `try` block.**

```ts
import { agentActor, agentJudge, simulate } from '@ambionframework/simulator';

try {
  const simulation = await simulate(room, {
    person: priya,
    actor: agentActor({
      model,
      brief: 'Choose a regulator for a 3.3 V, 2 A rail. Stop when you have a part and its limits.',
    }),
    messages: 3,
  });

  const verdict = await agentJudge({ model })(simulation, [
    'The design agent names one part and gives the reason.',
    'The datasheets agent states the output current limit of that part with its unit.',
  ]);
  console.log(verdict.pass, verdict.findings);
} finally {
  await room.stop();
}
```

**`simulate` sends each message of the actor as one exchange.** It ends
when the actor stops, after `messages` messages, at a timeout, or on a
failure. A healthy run has `simulation.ended` equal to `stopped` or `limit`,
and no exchange ends `exhausted`. [The simulator page](docs/simulator.md)
shows an eval as a vitest test.

## How a room works

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
- **The boundaries are narrow.** The journal owns no domain transactions and
  no credentials. Tools can act before a contribution commits, so
  applications own effect idempotency. A scheduled say is the one clock an
  agent sets, and every other event comes from the host through `room.post`.
  [Technical facts](docs/technical-facts.md) lists every limit.

## The workspace

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
| Sensors      | `connect`, `disconnect`, `observe`       | With a backend that has endpoints | [Sensors](docs/sensors.md)                               |
| Skills       | `read`, `bash`                           | When the host passes skills       | [Skills](docs/skills.md)                                 |

**Actuators are a pattern over processes.** A controller command started
with `bash` drives a device and stops safe on `SIGTERM`. A sensor confirms
the result. See [Actuators](docs/actuators.md).

**A seat can join its tools in one call.** The `compose` option adds a tool
that runs short code over the tools of the seat. The model reads only the
value that the code returns. A skill can store the code as a macro, and
`@ambionframework/evaluator` runs it. See [Compose](docs/compose.md).

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

## Read more

- [Documentation](docs/README.md) maps the design contracts and hosting.
- [`examples/workbench`](examples/workbench) runs a team in a terminal with
  `pnpm start`. It needs Node 26.4 or later.
- [Workbench](https://github.com/fastforwardengine/workbench) is the first
  application on Ambion. It seats specialists for electrical engineering,
  hardware, and electrochemistry over one shared workspace.
- [Contributing](CONTRIBUTING.md) covers builds and checks.
  [Toolchain](docs/toolchain.md#9-release-and-publishing) covers dev builds
  of `main`.
- [The plan](planning/next.md) names the scope of the next release.
  [The changelog](CHANGELOG.md) lists the changes of each release.

## License

[Apache 2.0](LICENSE)
