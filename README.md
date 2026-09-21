# Ambion

**Ambion is a collaboration kernel for agents and humans.**

[ambionframework.com](https://ambionframework.com) · [documentation](docs/README.md)

A room is a shared journal with rules for taking part. A workspace is where
agents and people keep the files and tables they work on. Collaboration
needs both: the room decides who speaks, and the workspace holds what they
are speaking about.

People ask questions and read results. Agents speak when they have
something to add and stay silent when they do not. Agents run on any
framework. The kernel keeps the record and the rules. A restart loses
nothing.

## When to use Ambion

**Use Ambion when several domains must contribute to one ongoing application.**
A question such as "Can we promise a Thursday delivery?" can require several
agents. Inventory checks stock. Scheduling checks capacity. Compliance checks
constraints. Each agent uses its own tools and contributes when it has
something useful to add.

**Each agent is its own unit.** It has its own owner, instructions, model,
tools, and framework. The room makes their contributions usable together.

**Rooms persist across individual questions.** People arrive and leave.
Specialists join and leave the active membership. A later message can change
an answer that is still being prepared. The journal preserves these
interactions for the lifetime of its storage.

**People can see the work.** A person drills from a room to an exchange, to
one activation, to the steps an agent took, with the cost of each.

Ambion serves TypeScript application developers. The application supplies
hosting, agent definitions, credentials, and domain tools. Ambion supplies
the collaboration semantics.

![A person asks a question in a room. The room journal records the question, wakes agents that run on any framework, and records what they say. The agents read and write files and tables in a shared workspace. A message names the artifact it cites or changes, and an artifact change names the activation that made it. A restart replays the journal and keeps the workspace.](docs/assets/ambion-room-and-workspace.svg)

The journal records what is said. The workspace holds what is made. Speech
enters the record through `say`. Work enters the workspace through tools. A
message names the artifact it cites or changes, and an artifact change names
the activation that made it. The workspace also holds a copy of the
collaboration itself: an audit log of every tool call, and a mirror of each
room's messages. An agent reads either the way it reads any file a peer
wrote.

## The conceptual model

| Concept    | Meaning                                                                             |
| ---------- | ----------------------------------------------------------------------------------- |
| Definition | An immutable value: a name, an identity, and an executor                            |
| Room       | Participants collaborating through one ordered journal                              |
| Seat       | An agent's membership in a room, with its attention                                 |
| Attention  | Which messages wake an idle seat: `none`, `named`, `broadcast`, or `presence`       |
| Reserve    | Definitions the room knows and has not seated; the room seats them by name          |
| Visit      | A person's speaking identity and presence lifetime                                  |
| Exchange   | A person's question and every activation until the room goes quiet                  |
| Activation | The room waking one seat: a bounded execution with authority to contribute          |
| Step       | One recorded unit of an activation's work: thinking, text, a tool call, a room call |
| Resource   | Application-owned data an agent's tools reach, stamped with provenance              |

Application code works with definitions, rooms, visits, and exchanges. Seats
change through room operations. Activations, leases, executors, and the trace
belong to the hosting entry, `@ambionframework/ambion/hosting`.

## A team on three harnesses

**Every family reaches the world through the same tools.** The team below
runs one seat on Pi, one on the Claude Agent SDK, and one on the Codex SDK.
It has one in-memory workspace and no file on the host. The workspace tools
are the only tools of every seat, next to the three room tools.

<!-- ts: standalone -->

```ts
import { defineAgent, defineHuman, startRoom, type ToolBundle } from '@ambionframework/ambion';
import { claude } from '@ambionframework/claude';
import { codex } from '@ambionframework/codex';
import { pi } from '@ambionframework/pi';
import { memoryBackend, openWorkspace } from '@ambionframework/workspace';

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

**A room seats every agent at `broadcast` by default.** With no `seats`
option, each definition in `agents` becomes a member that wakes on every
message. Pass `seats` to choose other members or another attention, or an
empty map to keep every agent in the reserve. See
[Roster](docs/roster.md#configuration).

**A room with no `execution` runs each seat on the default of its family.**
Importing a family package registers its default execution, which keeps
transcripts in the storage of the runtime. The kernel imports no model
library. A host that needs custom storage, a transport, or limits builds the
executions and passes them to `createRuntime`; see
[Executors](docs/executors.md). An executor kind that no loaded package
serves fails each seat it wakes with `no_execution`.

**The exchange opens on the question and closes when no seat has work
left.** Every seat wakes, reads the workspace, and speaks or stays silent. A
`say` that read a stale record is refused with the messages it missed. Every
read works on a running room and on a stopped one; see
[Exchange](docs/exchange.md).

**The shape is the workbench.** [`examples/workbench`](examples/workbench)
builds its team the same way: one list of `bundles` serves every seat, and
each seat gets its executor from `executorFor` in `definitions.ts`. A
definition names its family through its executor, and the room routes each
seat to the default execution of that family.

| Family | On                             | Off                                    | How the package enforces it                                                               | Test that guards it                                                                                                                      |
| ------ | ------------------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Pi     | Room tools and workspace tools | Everything else; Pi has no native tool | The executor gives the model the room tools and the tools of `bundles` only               | `examples/workbench/test/live/tool-set.test.ts`                                                                                          |
| Claude | Room tools and workspace tools | Every built-in tool of Claude Code     | With no `allowedTools`, the executor passes an empty `--tools` list and reads no settings | `packages/claude/test/policy.test.ts` on the fake executable; `examples/workbench/test/live/tool-set.test.ts` on the model               |
| Codex  | Room tools and workspace tools | Every native tool, and Code Mode       | `nativeTools: 'none'` sets the tool policy and replaces the model catalog entry           | `packages/codex/test/exclusive.test.ts` on the options; `packages/codex/test/live/exclusive.test.ts` and the workbench test on the model |

**What the live tests prove.** One tool set, one filesystem, and no native
tool rest on the live exclusivity tests. `tool-set.test.ts` lists the tools
of each seat that has a key, finds the same list for every seat with no
native tool in it, and shows that one seat reads a file another seat wrote.
It also shows that a seat cannot read `/etc/hosts`.
`packages/codex/test/live/exclusive.test.ts` does the same for a Codex seat.
Both tiers skip a family with no key, and they run only on request.

**`nativeTools: 'none'` turns off Codex Code Mode.** Its JavaScript runtime
reads the host filesystem outside the sandbox on Codex 0.155.1. See
[Codex](docs/codex.md#the-trust-boundary).

Each family has a guide with its options and its tests. Read the
[Pi](packages/pi/README.md), [Claude](packages/claude/README.md), and
[Codex](docs/codex.md) pages, and [Executors](docs/executors.md) for the
contract that all three meet.

## Key technical facts

- **One append-only journal per room.** Messages, arrivals, departures,
  seatings, leases, closes, references, and the composition are entries under
  one sequence. Every room fact is a pure fold over those entries. A resume
  is a replay. See [Durability](docs/durability.md).
- **Conditional, fenced, idempotent writes.** Storage appends only at the
  expected position. Each run writes a fence, and a later fence voids the
  earlier run's writes. A retry under the same key lands once. Journal format
  1 carries a compatibility promise, proven by golden journals that replay in
  CI. Memory and SQLite storages ship, with a Cloudflare Durable Objects
  adapter.
- **Derived activation identity.** An activation id encodes its cause, its
  journal position, its seat, and its attempt. Nothing mints an id, so a wake
  can be sent twice and the fold refuses a stale caller. Leases claim, renew,
  expire, and end with a recorded reason and the activation's usage.
- **Freshness checked at commit.** A `say` carries the position its
  activation read. If the record moved, the room refuses it and returns the
  missed messages. An active agent receives new context between provider
  requests when its framework takes a message during a run, and on its next
  pass otherwise. See [Agents](docs/agent.md).
- **The exchange is a fold.** The first human question after the last close
  opens it. Quiescence closes it with an outcome: complete, cancelled,
  exhausted, or awaiting a person. One configured writer may publish one
  summary for each person who spoke, with a stamped recipient and range.
  Later prompts read the summary in place of the covered messages while the
  source stays readable. See [Exchanges](docs/exchange.md) and
  [Summaries](docs/summary.md).
- **One executor contract.** The kernel drives leases, passes, steering, and
  freshness. A framework supplies one session with passes. Pi, the Claude
  Agent SDK, and the Codex SDK ship as adapters. Codex reaches the same
  three room tools through an MCP server. A conformance suite proves the Pi
  and Claude adapters on fakes. The Codex adapter runs live.
- **Speech through `say` only; everything else into a trace.** Every
  activation writes its steps live to its own trace: thinking, text, tool
  calls, room calls, steers, approvals, and usage. `readActivation` returns
  them by pass, and `subscribe` streams them with an activation id.
- **Artifacts by reference.** A message and a summary carry `refs`, URIs the
  kernel validates, stores, and renders, and never reads behind. Rooms and
  exchanges have URIs. Every resource change carries the activation, the
  exchange, and the room that made it. See [Resources](docs/resources.md).
- **The workspace mirrors the collaboration onto itself.** An audit log
  records every tool call the workspace served, as one JSON line: the room,
  the agent, the tool, the arguments, and the result. A room mirror copies
  its own messages to one file per room. Both rotate the same way, and both
  read like any file an agent already reads. See [Workspace](docs/workspace.md).
- **Three JSON calls each way.** A seat calls `view`, `commit`, and `lease`.
  The room calls `wake`, `steer`, and `cut`. In-process and RPC transports
  share the rules. See [Deployment](docs/deployment.md).
- **Correctness as evidence.** Pure rules carry Dafny-verified contracts. A
  scripted suite runs on memory and SQLite, a chaos sweep crashes before and
  after every append, and a process-kill test resumes over the same
  database.

## What is new

- **No scheduler and no task database.** Retries, resends, backoff, and
  completion derive from the journal, so recovery and live execution use the
  same facts.
- **A say lock for conversation.** Optimistic concurrency applied to speech,
  with the delta returned on refusal, lets agents reason in parallel and
  serializes what they accept.
- **Silence and quiescence as results.** An agent can finish without a mark,
  and an exchange closes when no work remains.
- **Compaction shared by humans and agents.** The summary written for a
  person is the context later agents read.
- **Routing stored with the message.** The attention scale decides who
  wakes, and the decision is written on the entry, so replay routes the same
  way.
- **Any framework, one adapter each.** A definition is a name, an identity,
  and an executor. The kernel keeps the leases, the passes, and the freshness
  check; a framework supplies one session with passes.
- **The trace beside the record.** Harness output maps to one step
  vocabulary, written live per activation, so a person drills from a room to
  an exchange to an activation to a step, with usage and cost on every
  activation.
- **Artifacts by reference.** Files and tables are the medium. The record
  names them, and the kernel reads none of them.
- **The workspace audits and mirrors the room.** A rotating log records
  every tool call the workspace served. A room mirror copies its own
  messages to a file the room never sees. An agent reads either one the
  way it reads any artifact.
- **Waiting on a person as a derived outcome.** An exchange whose last word
  is a question to a person reads as awaiting them, which gives approval a
  representation with no new entry kind.

## Install

Use Node **26.4 or later**. The packages are ESM and publish to npmjs.
Model execution needs credentials for the chosen provider.

```sh
npm install @ambionframework/ambion @ambionframework/pi
```

| Package                       | Concern                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| `@ambionframework/ambion`     | The kernel: protocol, journal vocabulary, rules, room, driver; `/hosting`, `/testing` |
| `@ambionframework/pi`         | The Pi executor                                                                       |
| `@ambionframework/claude`     | The Claude Agent SDK executor                                                         |
| `@ambionframework/codex`      | The Codex SDK executor                                                                |
| `@ambionframework/workspace`  | The resource contract, a directory workspace, and a SQL resource                      |
| `@ambionframework/assistant`  | A default assistant that guides membership and writes summaries                       |
| `@ambionframework/journal`    | The append-only journal and its storage contract                                      |
| `@ambionframework/pi-journal` | Pi transcript sessions over journal storage                                           |
| `@ambionframework/cloudflare` | Rooms and seats as Durable Objects                                                    |
| `@ambionframework/cli`        | `ambion new` and `ambion dev`                                                         |

See [Contributing](CONTRIBUTING.md) to build and run from source.

## The example

**One example ships: an agentic lab workspace.** [`examples/workbench`](examples/workbench)
runs an assistant and three specialists over a shared directory workspace. One
command starts the rooms and an OpenTUI terminal in one process. Three sample
rooms show a datasheet check, a design step, and a test plan. Scripted tests
run in CI, and two scenarios run on a real provider in the live tier.
[The example page](docs/example.md) describes each room.

`ambion new` creates a project from the same layout, with one room and two
definitions, as a Node service or a Cloudflare Worker. `ambion dev` opens its
rooms in the terminal.

## Hosting and persistence

**Placement, persistence, and tool resources are separate choices.**

| Model                         | Storage                     | Use                                                     |
| ----------------------------- | --------------------------- | ------------------------------------------------------- |
| Embedded Node application     | In-memory journals          | Development, tests, and ephemeral application lifetimes |
| Persistent Node service       | SQLite journals             | Long-lived hosts; the example is the reference          |
| Separate room and agent hosts | Storage chosen by each host | The JSON protocol, with a published conformance suite   |
| Cloudflare Durable Objects    | Each object's SQLite        | The adapter and the `ambion new` Worker template        |

The host keeps its process alive, supplies definitions again after restart,
and owns model credentials and tool resources. The journal holds the
collaboration; the host holds the code that runs it. See
[Deployment and recovery](docs/deployment.md) for host responsibilities and
the evidence for each model.

## Boundaries and limits

- Full history remains in storage and replay. `limits.context` bounds what
  one activation reads, and `limits.message` bounds what one message
  carries. [Envelope](docs/envelope.md) lists every limit and its default.
- Activation deadlines and retry caps impose no total exchange budget.
  Continuing contributions keep an exchange open.
- Tools can act before a contribution commits. Applications own effect
  idempotency; conversation freshness does not make external effects
  transactional.
- Await `abort()` or `stop()` to confirm their durable room-wide work. A
  graceful stop ends running leases and keeps pending work for the next run.
  See the [cancellation contract](docs/durability.md#cancellation).
- A process crash records no departure. Hosts reconcile durable presence
  with their connections after recovery.
- Subscriptions belong to a running host. A reconnecting client reads
  durable messages and reacquires exchange handles.
- A workspace provides no operating-system isolation between agents. One
  host owns each resource.
- A seat with harness memory holds state the record does not show.
- A room remains available between interactions. Native timers, external
  event subscriptions, and scheduler ingress are future work.
- The journal owns no domain transactions and no credentials. Browser-only
  execution and a managed service are not provided.

## Read more

[Documentation](docs/README.md) maps the design contracts and hosting
guidance. [Contributing](CONTRIBUTING.md) covers builds and checks.
[The plan](planning/next.md) names the work that remains before the tag.

## License

[Apache 2.0](LICENSE)
