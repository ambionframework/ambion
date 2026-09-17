# Ambion

**Ambion is a collaboration kernel for agents and humans.**

[ambionframework.com](https://ambionframework.com) · [documentation](docs/README.md)

A room is a shared journal with rules for taking part. People ask questions
and read results. Agents speak when they have something to add and stay
silent when they do not. Agents run on any framework. Agents and people share
files, tables, and instruments. The kernel keeps the record and the rules. A
restart loses nothing.

Two of these claims land with 0.1.0 and are pending today: any framework,
and tables and instruments beside files. [The plan](planning/next.md) tracks
both.

## When to use Ambion

**Use Ambion when several domains must contribute to one ongoing application.**
A question such as “Can we promise a Thursday delivery?” can require several
agents. Inventory checks stock. Scheduling checks capacity. Compliance checks
constraints. Each agent uses its own tools and contributes when it has
something useful to add.

**Each agent is its own unit.** It has its own owner, instructions, model,
tools, and framework. The room makes their contributions usable together.

**Rooms persist across individual questions.** People arrive and leave.
Specialists join and leave the active membership. Later messages can change
an answer that is still being prepared. The journal preserves these interactions
for the lifetime of its storage.

Ambion serves TypeScript application developers. The application supplies
hosting, agent definitions, credentials, and domain tools. Ambion supplies the
collaboration semantics.

![A person asks a question in a room. The room journal records the question, wakes agents that run on any framework, and records what they say. The agents read and write files, tables, and instruments in a shared workspace. A message names the artifact it cites or changes, and an artifact change names the activation that made it. A restart replays the journal and keeps the workspace.](docs/assets/ambion-room-and-workspace.svg)

The picture shows the room and the workspace side by side. Speech enters the
record through `say`. Work enters the workspace through tools. A message
names the artifact it cites or changes, and an artifact change names the
activation that made it. Files are here today. Tables, instruments,
references, and provenance land with 0.1.0.

## The conceptual model

| Concept     | Meaning                                                      |
| ----------- | ------------------------------------------------------------ |
| Definitions | One value per agent: a name, an identity, and how it runs    |
| Room        | Participants collaborating through one ordered journal       |
| Membership  | An agent's participation and attention within a room         |
| Visit       | A human's speaking identity and presence lifetime            |
| Exchange    | An opening message and the discussion it starts              |
| Activation  | A bounded execution with authority to contribute to the room |

Application code mainly works with definitions, rooms, visits, and exchanges.
Membership changes through room operations. Activation and lease details
belong to the hosting contract. The API calls an agent membership a
_seat_.

## Key technical facts

- **One append-only journal per room.** Messages, arrivals, departures,
  seatings, leases, closes, and the composition are entries under one
  sequence. Every room fact is a pure fold over those entries. A resume is a
  replay.
- **Conditional, fenced, idempotent writes.** Storage appends only at the
  expected position. Each run writes a fence, and a later fence voids the
  earlier run's writes. A retry under the same key lands once. Memory and
  SQLite storages ship, with a Cloudflare Durable Objects adapter.
- **Derived activation identity.** An activation id encodes its cause, its
  journal position, its seat, and its attempt. Nothing mints an id, so a wake
  can be sent twice and the fold refuses a stale caller. Leases claim, renew,
  expire, and end with a recorded reason.
- **Freshness checked at commit.** A `say` carries the position its
  activation read. If the record moved, the room refuses it and returns the
  missed messages. Active agents receive new context between provider
  requests.
- **The exchange is a fold.** The first human question after the last close
  opens it. Quiescence closes it. One configured writer may publish one
  summary with a stamped recipient and range, and later prompts read the
  summary in place of the covered messages while the source stays readable.
- **Three JSON calls each way.** A seat calls `view`, `commit`, and `lease`.
  The room calls `wake`, `steer`, and `cut`. In-process and RPC transports
  share the rules.
- **Correctness as evidence.** Pure rules carry Dafny-verified contracts. A
  scripted suite runs on memory and SQLite, a chaos sweep crashes before and
  after every append, and a process-kill test resumes over the same database.

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

Four more land with 0.1.0 and are pending today. [The plan](planning/next.md)
holds each one.

- **Any framework, one adapter each.** A definition becomes a name, an
  identity, and an executor. The kernel keeps the leases, the passes, and the
  freshness check; a framework supplies one session with passes. Pi and the
  Claude Agent SDK ship as adapters.
- **Speech only through `say`; everything else into a trace.** Harness
  output maps to one step vocabulary, written live per activation, so a
  person drills from a room to an exchange to an activation to a step, with
  usage and cost on every activation.
- **Artifacts by reference.** Messages carry references, every resource
  change carries provenance, and rooms have URIs, so files, tables, and
  instruments are the medium and the kernel reads none of them.
- **Waiting on a person as a derived outcome.** An exchange whose last word
  is a question to a person reads as awaiting them, which gives approval a
  representation with no new entry kind.

## Install

Use Node **22.19 or later**. Packages use ESM. Model execution uses the Pi
integration and requires credentials for the chosen provider.

The [local development CLI](packages/cli/README.md) creates team projects and
opens their rooms in OpenTUI. Installing the CLI or the repository requires
Node **26.4 or later**.

The configured registry is GitHub Packages, which requires a token for read
access. Create a [classic PAT](https://github.com/settings/tokens/new?scopes=read:packages&description=Ambion)
with `read:packages`, then add this to your project's `.npmrc`:

```ini
@ambionframework:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

```sh
export GITHUB_TOKEN=…
npm install @ambionframework/ambion
```

The main library includes the journal dependency. Add
`@ambionframework/workspace` when agents need its optional filesystem tools.
Add `@ambionframework/assistant` for a default assistant that guides membership
and summarizes exchanges. The [assistant contract](docs/assistant.md) describes
its behavior and the `startRoom({ assistant })` shorthand.
See [Contributing](CONTRIBUTING.md) to build and run from source.

## Try a working application

- [Relay](examples/persistent/README.md): multiple persistent rooms and people,
  a browser UI, and a shared local workspace in one Node process.
- [Local CLI](packages/cli/README.md): `ambion new` creates a team project;
  `ambion dev` opens its rooms in the terminal.
- [Site example](examples/site): domain tools and agent collaboration.

## A small room

This example uses two specialist definitions and no summary writer. Each specialist
owns its instructions and model choice. Define ordinary typed tools with
`defineTool` and pass reusable bundles in the separate `bundles` field.
Pass a workspace's `tools()` result in that field.

```ts
import { defineAgent, defineHuman, startRoom } from '@ambionframework/ambion';

const inventory = defineAgent({
  name: 'inventory',
  identity: 'Checks stock constraints.',
  instructions: 'Use the supplied stock facts. State a constraint only when it changes the answer.',
  model: 'anthropic/claude-sonnet-4-5',
});
const scheduling = defineAgent({
  name: 'scheduling',
  identity: 'Checks delivery capacity.',
  instructions:
    'Use the supplied capacity facts. State a constraint only when it changes the answer.',
  model: 'anthropic/claude-sonnet-4-5',
});
const priya = defineHuman({
  name: 'priya',
  identity: 'Coordinates customer deliveries.',
});

const room = await startRoom({
  name: 'delivery',
  goal: 'Check delivery promises against stock and capacity.',
  agents: [inventory, scheduling],
  seats: { inventory: 'broadcast', scheduling: 'broadcast' },
});

try {
  const visit = await room.visit(priya);
  const exchange = await visit.send({
    text: 'We have 12 units in stock and Thursday capacity for 8. Can we promise 10 for Thursday?',
  });
  for (const message of await exchange.waitForClose()) {
    if (message.kind === 'said') console.log(`${message.from}: ${message.text}`);
  }
  await visit.leave();
} finally {
  await room.stop();
}
```

Set `summary` to the name of a defined agent when the application needs an
optional closing summary. Include every executable definition in `agents`; leave
an agent out of `seats` to keep it in the reserve. If `seats` is omitted, every
defined agent starts at `broadcast` attention. `exchange.waitForSummary()` waits for
a summary or a terminal result without one. A writer may decline, and the
application can always read the discussion.

Use `room.read()` for immediate conversation and participant state.
`readRoom(name, { runtime })` and `readExchange(name, from, { runtime })` also
inspect stopped rooms. These reads never wait for an agent to finish.

## Hosting and persistence

**Placement, persistence, and tool resources are separate choices.**

| Model                         | Storage                            | Use and support                                                    |
| ----------------------------- | ---------------------------------- | ------------------------------------------------------------------ |
| Embedded Node application     | In-memory journals                 | Development, tests, and ephemeral application lifetimes            |
| Persistent Node service       | SQLite through the storage adapter | SQLite adapter and recovery tests; application-managed lifecycle   |
| Separate room and agent hosts | Storage chosen by each host        | JSON protocol extension contract                                   |
| Cloudflare Durable Objects    | Each object's SQLite storage       | Publishable adapter for local CLI use; deployment commands pending |

The host keeps its process alive, supplies definitions again after restart,
and owns model credentials and tool resources. Persisted history alone does
not restart an application. The protocol carries collaboration data; execution
hosts need their own code, credentials, and authorization.

See [Deployment and recovery](docs/deployment.md) for host responsibilities
and the current evidence for each model.

## Boundaries and limits

- Full history remains in storage and replay. Memory and model input can grow
  with room history. Ambion does not promise bounded context or indefinite scale.
- Activation deadlines and retry caps do not impose a total exchange budget.
  Continuing contributions can keep an exchange open.
- Tools can act before a contribution commits. Applications own effect
  idempotency; conversation freshness does not make external effects transactional.
- Await `abort()` or `stop()` to confirm their durable room-wide work.
  Exchange handles do not provide independent cancellation. See the
  [cancellation contract](docs/durability.md#cancellation).
- A process crash does not record a person's departure. Hosts reconcile
  durable presence with their actual connections after recovery.
- Subscriptions belong to a running host. Reconnecting clients read durable
  messages and reacquire exchange handles.
- Workspace files remain separate from collaboration history. Shared workspaces
  provide no operating-system isolation between agents or distributed directory ownership.
- Ambient means a room remains available between interactions. Native timers,
  external event subscriptions, and a scheduler ingress API are future work.

The journal does not own domain transactions or credentials. Browser-only
execution, a managed service, and turnkey deployment commands are not provided.

## Read more

[Documentation](docs/README.md) maps the design contracts and hosting guidance.
[Contributing](CONTRIBUTING.md) covers builds and checks.

## License

[Apache 2.0](LICENSE)
